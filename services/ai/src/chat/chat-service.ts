import { randomUUID } from "node:crypto";
import { aiEvents, type Locale, type MessageRef } from "@my-wife/contracts";
import type { LlmProvider } from "../llm";
import type { MemoryService } from "../memory";
import { buildSystemPrompt } from "./persona";

export interface ChatServiceDeps {
  provider: LlmProvider;
  publish: (event: {
    name: "ai.message_sent" | "memory.created";
    payload: unknown;
  }) => Promise<void>;
  memory?: MemoryService;
  now?: () => Date;
  newId?: () => string;
  /** Structured warn logger; never receives user text or secrets. */
  warn?: (fields: Record<string, unknown>, message: string) => void;
}

export interface ChatResult {
  messageId: string;
  reply: MessageRef | { text: string };
  pendingConfirmations: never[];
  degraded: boolean;
}

/**
 * Minimal agent loop (M1): persona + user text to the provider, one reply.
 * Tool proposals are not executed yet (the tool wrapper arrives later), so
 * `toolCalls` in the event is always 0.
 */
export class ChatService {
  constructor(private readonly deps: ChatServiceDeps) {}

  async handleMessage(text: string, locale: Locale, userId: string): Promise<ChatResult> {
    const messageId = (this.deps.newId ?? randomUUID)();
    let replyText: string;
    let proposals: readonly string[];
    try {
      const memories = (await this.deps.memory?.recall(userId)) ?? [];
      const response = await this.deps.provider.complete({
        system: buildSystemPrompt(locale, memories),
        userText: text,
        locale,
      });
      replyText = response.text;
      proposals = response.memories ?? [];
    } catch (error) {
      // Plain error reply; nothing from the provider is acted on.
      this.deps.warn?.(
        {
          provider: this.deps.provider.id,
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "llm provider call failed",
      );
      return {
        messageId,
        reply: { key: "ai.chat.error", params: {} },
        pendingConfirmations: [],
        degraded: true,
      };
    }
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
