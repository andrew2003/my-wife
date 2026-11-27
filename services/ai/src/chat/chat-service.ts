import { randomUUID } from "node:crypto";
import {
  aiEvents,
  DegradedReasonSchema,
  SETTINGS,
  type Locale,
  type AiToolCall,
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
import type { ConversationStore } from "../conversation";
import type { MemoryService } from "../memory";
import { buildSystemPrompt } from "./persona";
import { isQuickCapture, resolveDay } from "./capture";
import type { ToolExecutor } from "../tools";
import { wrapUntrusted, type UntrustedSource } from "./untrusted";

const DEFAULT_MAX_CAPTURES = 5;

export interface ChatServiceDeps {
  provider: LlmProvider;
  publish: (event: {
    name:
      | "ai.message_sent"
      | "memory.created"
      | "memory.deleted"
      | "persona.updated"
      | "ai.degraded_entered"
      | "ai.degraded_exited";
    payload: unknown;
  }) => Promise<void>;
  memory?: MemoryService;
  /** Where answered turns are recorded for the summary job. */
  conversations?: ConversationStore;
  now?: () => Date;
  newId?: () => string;
  /** Structured warn logger; never receives user text or secrets. */
  warn?: (fields: Record<string, unknown>, message: string) => void;
  /** Second model used after `ai.fallback_after_failures` consecutive primary failures. */
  fallback?: LlmProvider;
  /** Runs validated quick-capture proposals (create_task, record_cash_expense) on trusted turns. */
  tools?: ToolExecutor;
  /** Safety cap on captures run for one message; the registry has no key for it yet. */
  maxCapturesPerMessage?: number;
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
  /** Last strictness seen per user and the persona version it implies (in memory for now). */
  private readonly personas = new Map<string, { strictness: number; version: number }>();

  constructor(private readonly deps: ChatServiceDeps) {}

  /** Current failover state, for the banner signal. */
  statusOf(userId: string): FailoverState {
    return this.states.get(userId) ?? INITIAL_FAILOVER;
  }

  /** Time zone for resolving relative days; registry default when unset or invalid. */
  private async timeZone(userId: string): Promise<string> {
    const def = SETTINGS["calendar.time_zone"];
    try {
      const values = (await this.deps.readSettings?.(userId)) ?? {};
      const parsed = def.schema.safeParse(values["calendar.time_zone"]);
      return parsed.success ? parsed.data : def.default;
    } catch {
      return def.default;
    }
  }

  /**
   * Runs the quick-capture proposals of a trusted turn. The model only proposes: code resolves
   * the day, the executor validates against the contracts and audits, and the confirmation text
   * states what code actually did. Other tools are ignored here.
   */
  private async capture(
    calls: readonly AiToolCall[],
    locale: Locale,
    userId: string,
    at: Date,
  ): Promise<{ lines: string[]; executed: number }> {
    const tools = this.deps.tools;
    if (!tools) return { lines: [], executed: 0 };
    const max = this.deps.maxCapturesPerMessage ?? DEFAULT_MAX_CAPTURES;
    const lines: string[] = [];
    let executed = 0;
    for (const call of calls.filter(isQuickCapture).slice(0, max)) {
      let args: unknown = call.args;
      if (call.tool === "create_task") {
        const { day, ...rest } = call.args;
        const resolved = resolveDay(day, at, await this.timeZone(userId));
        args = resolved ? { ...rest, day: resolved } : rest;
      }
      const result = await tools.execute(userId, { tool: call.tool, args });
      if (result.status === "ok") executed += 1;
      if (result.status !== "ok") {
        lines.push(renderMessage({ key: "ai.capture.failed", params: {} }, locale));
      } else if (call.tool === "create_task") {
        const a = args as { title: string; day?: string };
        lines.push(
          renderMessage(
            {
              key: a.day ? "ai.capture.task_created_day" : "ai.capture.task_created",
              params: { title: a.title, day: a.day ?? "" },
            },
            locale,
          ),
        );
      } else {
        const a = args as { amountVnd: number; note?: string };
        lines.push(
          renderMessage(
            {
              key: "ai.capture.expense_recorded",
              params: { amount: a.amountVnd, note: a.note ?? "" },
            },
            locale,
          ).trim(),
        );
      }
    }
    return { lines, executed };
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
  private async recallSafely(userId: string): Promise<[string[], string[]]> {
    try {
      const memory = this.deps.memory;
      return memory
        ? [await memory.recall(userId), await memory.recallSummaries(userId)]
        : [[], []];
    } catch (error) {
      this.deps.warn?.(
        { errorName: error instanceof Error ? error.name : "unknown" },
        "memory recall failed",
      );
      return [[], []];
    }
  }

  /**
   * Current strictness (registry default when unset or invalid). A change since the last reply
   * bumps the persona version and announces `persona.updated`; the first sight is the baseline.
   */
  private async strictness(userId: string): Promise<number> {
    const def = SETTINGS["ai.persona_strictness"];
    let value: number = def.default;
    try {
      const values = (await this.deps.readSettings?.(userId)) ?? {};
      const parsed = def.schema.safeParse(values["ai.persona_strictness"]);
      if (parsed.success) value = parsed.data;
    } catch {
      // Keep the default.
    }
    const seen = this.personas.get(userId);
    if (!seen) {
      this.personas.set(userId, { strictness: value, version: 1 });
    } else if (seen.strictness !== value) {
      const next = { strictness: value, version: seen.version + 1 };
      this.personas.set(userId, next);
      try {
        await this.deps.publish({
          name: "persona.updated",
          payload: aiEvents["persona.updated"].parse({ version: next.version }),
        });
      } catch (error) {
        this.deps.warn?.(
          { errorName: error instanceof Error ? error.name : "unknown" },
          "event publish failed",
        );
      }
    }
    return value;
  }

  async handleMessage(text: string, locale: Locale, userId: string): Promise<ChatResult> {
    return this.run(text, locale, userId, null);
  }

  /**
   * An email field or a chat paste: wrapped as data, answered in words only. Whatever tools or
   * memories the model proposes are dropped, and nothing of it is recorded as a user turn.
   */
  async handleUntrusted(
    text: string,
    source: UntrustedSource,
    locale: Locale,
    userId: string,
  ): Promise<ChatResult> {
    return this.run(text, locale, userId, source);
  }

  private async run(
    text: string,
    locale: Locale,
    userId: string,
    untrusted: UntrustedSource | null,
  ): Promise<ChatResult> {
    const messageId = (this.deps.newId ?? randomUUID)();
    const threshold = await this.threshold(userId);
    const strictness = await this.strictness(userId);
    const [memories, summaries] = await this.recallSafely(userId);
    const request = {
      system: untrusted
        ? `${buildSystemPrompt(locale, memories, summaries, strictness)}\n${renderMessage({ key: "ai.untrusted.rule", params: {} }, locale)}`
        : buildSystemPrompt(locale, memories, summaries, strictness),
      userText: untrusted ? wrapUntrusted(text, untrusted) : text,
      locale,
    };
    const before = this.statusOf(userId);
    const { fallback } = this.deps;
    const slots: [ModelSlot, LlmProvider][] = [];
    // While degraded every model is probed again, so recovery is noticed on the first success.
    if (before.degraded || before.active === "primary") slots.push(["primary", this.deps.provider]);
    if (fallback && (before.degraded || before.active === "fallback"))
      slots.push(["fallback", fallback]);
    let state = before;
    let answered: {
      slot: ModelSlot;
      text: string;
      memories: readonly string[];
      toolCalls: readonly AiToolCall[];
    } | null = null;
    for (const [slot, provider] of slots) {
      try {
        const response = await provider.complete(request);
        state = nextFailoverState(state, slot, true, threshold, { hasFallback: !!fallback });
        if (untrusted && response.toolCalls.length > 0)
          this.deps.warn?.(
            { dropped: response.toolCalls.length, source: untrusted },
            "untrusted content proposed tools; dropped",
          );
        answered = {
          slot,
          text: response.text,
          memories: untrusted ? [] : (response.memories ?? []),
          toolCalls: untrusted ? [] : response.toolCalls,
        };
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
    const captured = untrusted
      ? { lines: [] as string[], executed: 0 }
      : await this.capture(
          answered.toolCalls,
          locale,
          userId,
          (this.deps.now ?? (() => new Date()))(),
        );
    if (captured.lines.length > 0) replyText = `${replyText}\n\n${captured.lines.join("\n")}`;
    await this.deps.publish({
      name: "ai.message_sent",
      payload: aiEvents["ai.message_sent"].parse({ messageId, toolCalls: captured.executed }),
    });
    if (untrusted) {
      return { messageId, reply: { text: replyText }, pendingConfirmations: [], degraded: false };
    }
    try {
      const at = (this.deps.now ?? (() => new Date()))();
      await this.deps.conversations?.append({ userId, role: "user", text, at });
      await this.deps.conversations?.append({ userId, role: "assistant", text: answered.text, at });
    } catch (error) {
      this.deps.warn?.(
        { errorName: error instanceof Error ? error.name : "unknown" },
        "conversation record failed",
      );
    }
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
