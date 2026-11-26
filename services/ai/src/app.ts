import { servicePort, type AppConfig } from "@my-wife/config";
import { ChatMessageRequestSchema, ChatMessageResponseSchema, SETTINGS } from "@my-wife/contracts";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";
import { ChatService } from "./chat/chat-service";
import { renderMessage } from "./i18n";
import { createProvider, type LlmProvider } from "./llm";
import { InMemoryMemoryStore, loadMemoryLimits, MemoryService, type MemoryStore } from "./memory";
import { createSettingsReader } from "./settings";

export const SERVICE_NAME = "ai";

export interface AiDeps extends ServiceDeps {
  provider?: LlmProvider;
  publish?: (event: {
    name: "ai.message_sent" | "memory.created";
    payload: unknown;
  }) => Promise<void>;
  memoryStore?: MemoryStore;
  /** Effective user settings (identity `GET /settings`); defaults to an HTTP reader. */
  readSettings?: (userId: string) => Promise<Record<string, unknown>>;
  memoryLimits?: { maxFactLength: number; maxPerTurn: number };
}

/** Factory used by main.ts, the dev runner and tests; no process-level globals (ADR 0007). */
export function createApp(config: AppConfig, deps: AiDeps = {}) {
  const app = createServiceApp({
    name: SERVICE_NAME,
    logLevel: config.logLevel,
    nats: deps.nats,
  });
  const publish = deps.publish ?? (async () => {});
  const identityUrl = process.env.IDENTITY_URL ?? `http://localhost:${servicePort("identity")}`;
  const readSettings = deps.readSettings ?? createSettingsReader(identityUrl);
  const memory = new MemoryService({
    store: deps.memoryStore ?? new InMemoryMemoryStore(),
    publish,
    topK: async (userId) => {
      const values = await readSettings(userId);
      const parsed = SETTINGS["ai.memory_retrieval_top_k"].schema.safeParse(
        values["ai.memory_retrieval_top_k"],
      );
      return parsed.success ? parsed.data : SETTINGS["ai.memory_retrieval_top_k"].default;
    },
    ...(deps.memoryLimits ?? loadMemoryLimits()),
  });
  const chat = new ChatService({
    provider: deps.provider ?? createProvider(),
    publish,
    memory,
    warn: (fields, message) => app.log.warn(fields, message),
  });
  app.post("/chat/message", async (req, reply) => {
    const parsed = ChatMessageRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "invalid_request" });
    // The gateway sets x-user-id; a missing header is the single local user.
    const header = req.headers["x-user-id"];
    const userId = typeof header === "string" && header !== "" ? header : "local";
    const result = await chat.handleMessage(parsed.data.text, config.uiLanguage, userId);
    const text =
      "key" in result.reply ? renderMessage(result.reply, config.uiLanguage) : result.reply.text;
    return ChatMessageResponseSchema.parse({ ok: true, data: { ...result, reply: { text } } });
  });
  return app;
}
