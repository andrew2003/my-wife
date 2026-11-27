import { randomUUID } from "node:crypto";
import {
  aiEvents,
  DegradedReasonSchema,
  SETTINGS,
  type Locale,
  type MessageRef,
} from "@my-wife/contracts";
import {
  type DegradedReason,
  INITIAL_FAILOVER,
  nextFailoverState,
  type FailoverState,
  type ModelSlot,
} from "../fallback";
import { renderMessage } from "../i18n";
import type { LlmProvider } from "../llm";
import type { MemoryService } from "../memory";
import { buildSystemPrompt } from "./persona";

export interface ChatServiceDeps {
  provider: LlmProvider;
  publish: (event: {
    name: "ai.message_sent" | "memory.created" | "ai.degraded_entered" | "ai.degraded_exited";
    payload: unknown;
  }) => Promise<void>;
  memory?: MemoryService;
  now?: () => Date;
  newId?: () => string;
  /** Structured warn logger; never receives user text or secrets. */
  warn?: (fields: Record<string, unknown>, message: string) => void;
  /** Second model used after `ai.fallback_after_failures` consecutive primary failures. */
  fallback?: LlmProvider;
  /** Effective user settings; the failure threshold comes from here. */
  readSettings?: (userId: string) => Promise<Record<string, unknown>>;
}

export interface ChatResult {
  messageId: string;
  reply: MessageRef | { text: string };
  pendingConfirmations: never[];
  degraded: boolean;
}

/** A provider error may carry a `reason`; anything else counts as the provider being down. */
function reasonOf(error: unknown): DegradedReason {
  const parsed = DegradedReasonSchema.safeParse((error as { reason?: unknown } | null)?.reason);
  return parsed.success ? parsed.data : "provider_down";
}

/**
 * Minimal agent loop (M1): persona + user text to the provider, one reply.
 * Tool proposals are not executed yet (the tool wrapper arrives later), so
 * `toolCalls` in the event is always 0.
 *
 * Failover: after `ai.fallback_after_failures` consecutive primary failures the fallback model
 * answers the next message with the same prompt (same memories) and the user is told once. When
 * no model is left the service is degraded and chat free text points to the inbox and buttons.
 */
export class ChatService {
  private readonly states = new Map<string, FailoverState>();

  constructor(private readonly deps: ChatServiceDeps) {}

  /** Current failover state, for the banner signal. */
  statusOf(userId: string): FailoverState {
    return this.states.get(userId) ?? INITIAL_FAILOVER;
  }

  private async threshold(userId: string): Promise<number> {
    const def = SETTINGS["ai.fallback_after_failures"];
    try {
      const values = (await this.deps.readSettings?.(userId)) ?? {};
      const parsed = def.schema.safeParse(values["ai.fallback_after_failures"]);
      return parsed.success ? parsed.data : def.default;
    } catch {
      return def.default;
    }
  }

  private async publishDegraded(
    name: "ai.degraded_entered" | "ai.degraded_exited",
    payload: unknown,
  ): Promise<void> {
    try {
      await this.deps.publish({ name, payload: aiEvents[name].parse(payload) });
    } catch (error) {
      this.deps.warn?.(
        { errorName: error instanceof Error ? error.name : "unknown" },
        "event publish failed",
      );
    }
  }

  /** A memory failure must never cost the user a reply: fall back to no memories. */
  private async recallSafely(userId: string): Promise<string[]> {
    try {
      return (await this.deps.memory?.recall(userId)) ?? [];
    } catch (error) {
      this.deps.warn?.(
        { errorName: error instanceof Error ? error.name : "unknown" },
        "memory recall failed",
      );
      return [];
    }
  }

  async handleMessage(text: string, locale: Locale, userId: string): Promise<ChatResult> {
    const messageId = (this.deps.newId ?? randomUUID)();
    const threshold = await this.threshold(userId);
    const memories = await this.recallSafely(userId);
    const request = { system: buildSystemPrompt(locale, memories), userText: text, locale };
    const before = this.statusOf(userId);
    const { fallback } = this.deps;
    const slots: [ModelSlot, LlmProvider][] = [];
    // While degraded every model is probed again, so recovery is noticed on the first success.
    if (before.degraded || before.active === "primary") slots.push(["primary", this.deps.provider]);
    if (fallback && (before.degraded || before.active === "fallback"))
      slots.push(["fallback", fallback]);
    let state = before;
    let answered: { slot: ModelSlot; text: string; memories: readonly string[] } | null = null;
    for (const [slot, provider] of slots) {
      try {
        const response = await provider.complete(request);
        state = nextFailoverState(state, slot, true, threshold, { hasFallback: !!fallback });
        answered = { slot, text: response.text, memories: response.memories ?? [] };
        break;
      } catch (error) {
        // Plain error handling; nothing from the provider is acted on.
        this.deps.warn?.(
          { provider: provider.id, errorName: error instanceof Error ? error.name : "unknown" },
          "llm provider call failed",
        );
        state = nextFailoverState(state, slot, false, threshold, {
          hasFallback: !!fallback,
          reason: reasonOf(error),
        });
      }
    }
    this.states.set(userId, state);
    if (!before.degraded && state.degraded && state.reason)
      await this.publishDegraded("ai.degraded_entered", { reason: state.reason });
    if (before.degraded && !state.degraded) await this.publishDegraded("ai.degraded_exited", {});
    if (!answered) {
      const key = state.degraded ? "ai.chat.degraded" : "ai.chat.error";
      return {
        messageId,
        reply: { key, params: {} },
        pendingConfirmations: [],
        degraded: true,
      };
    }
    let replyText = answered.text;
    if (answered.slot === "fallback" && !state.notified) {
      const notice = renderMessage({ key: "ai.chat.fallback_notice", params: {} }, locale);
      replyText = `${notice}\n\n${replyText}`;
      this.states.set(userId, { ...state, notified: true });
    }
    const proposals = answered.memories;
    await this.deps.publish({
      name: "ai.message_sent",
      payload: aiEvents["ai.message_sent"].parse({ messageId, toolCalls: 0 }),
    });
    // The turn has ended: code validates and stores the proposed facts.
    try {
      await this.deps.memory?.endTurn(
        userId,
        text,
        proposals,
        (this.deps.now ?? (() => new Date()))(),
      );
    } catch (error) {
      this.deps.warn?.(
        { errorName: error instanceof Error ? error.name : "unknown" },
        "memory write failed",
      );
    }
    return { messageId, reply: { text: replyText }, pendingConfirmations: [], degraded: false };
  }
}
