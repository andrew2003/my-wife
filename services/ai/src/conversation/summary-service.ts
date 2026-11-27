import { aiEvents, SETTINGS } from "@my-wife/contracts";
import { renderMessage } from "../i18n";
import type { LlmProvider } from "../llm";
import type { MemoryStore } from "../memory";
import type { ConversationStore } from "./conversation-store";

export interface SummaryServiceOptions {
  conversations: ConversationStore;
  memories: MemoryStore;
  provider: LlmProvider;
  publish: (event: { name: "memory.created"; payload: unknown }) => Promise<void>;
  readSettings: (userId: string) => Promise<Record<string, unknown>>;
  locale: "vi" | "en";
  warn?: (fields: Record<string, unknown>, message: string) => void;
}

type SummarySetting = "ai.summary_trigger_messages" | "ai.recent_messages_kept";

/**
 * Summarises long conversations: when a user has at least `ai.summary_trigger_messages` active
 * turns, all but the last `ai.recent_messages_kept` are summarised into one `summary` memory and
 * compacted. The model only proposes the summary text; turns are removed only after it is stored.
 */
export class SummaryService {
  constructor(private readonly options: SummaryServiceOptions) {}

  private async setting(userId: string, key: SummarySetting): Promise<number> {
    const def = SETTINGS[key];
    try {
      const parsed = def.schema.safeParse((await this.options.readSettings(userId))[key]);
      return parsed.success ? parsed.data : def.default;
    } catch {
      return def.default;
    }
  }

  /** Runs the job for every user; returns how many conversations were summarised. */
  async run(now: Date): Promise<number> {
    let done = 0;
    for (const userId of await this.options.conversations.usersWithTurns()) {
      try {
        if (await this.summarise(userId, now)) done += 1;
      } catch (error) {
        this.options.warn?.(
          { errorName: error instanceof Error ? error.name : "unknown" },
          "conversation summary failed",
        );
      }
    }
    return done;
  }

  private async summarise(userId: string, now: Date): Promise<boolean> {
    const { conversations, memories, provider, locale } = this.options;
    const turns = await conversations.listActive(userId);
    const trigger = await this.setting(userId, "ai.summary_trigger_messages");
    if (turns.length < trigger) return false;
    const kept = await this.setting(userId, "ai.recent_messages_kept");
    const old = turns.slice(0, Math.max(0, turns.length - kept));
    if (old.length === 0) return false;
    // Old turns are untrusted data: they go in the user channel, never the instructions.
    const transcript = old.map((t) => `${t.role}: ${t.text.replace(/\s+/g, " ")}`).join("\n");
    const response = await provider.complete({
      system: renderMessage({ key: "ai.summary.instruction", params: {} }, locale),
      userText: transcript,
      locale,
    });
    const fact = response.text.trim();
    if (fact === "") return false;
    const row = await memories.add({ userId, fact, source: "summary", createdAt: now });
    await conversations.compact(
      userId,
      old.map((t) => t.id),
    );
    await this.options.publish({
      name: "memory.created",
      payload: aiEvents["memory.created"].parse({ memoryId: row.id }),
    });
    return true;
  }
}
