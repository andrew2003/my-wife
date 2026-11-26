import type { AppConfig } from "@my-wife/config";
import { ChatMessageRequestSchema, ChatMessageResponseSchema } from "@my-wife/contracts";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";
import { ChatService } from "./chat/chat-service";
import { renderMessage } from "./i18n";
import { createProvider, type LlmProvider } from "./llm";

export const SERVICE_NAME = "ai";

export interface AiDeps extends ServiceDeps {
  provider?: LlmProvider;
  publish?: (event: { name: "ai.message_sent"; payload: unknown }) => Promise<void>;
}

/** Factory used by main.ts, the dev runner and tests; no process-level globals (ADR 0007). */
export function createApp(config: AppConfig, deps: AiDeps = {}) {
  const app = createServiceApp({
    name: SERVICE_NAME,
    logLevel: config.logLevel,
    nats: deps.nats,
  });
  const chat = new ChatService({
    provider: deps.provider ?? createProvider(),
    publish: deps.publish ?? (async () => {}),
    warn: (fields, message) => app.log.warn(fields, message),
  });
  app.post("/chat/message", async (req, reply) => {
    const parsed = ChatMessageRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "invalid_request" });
    const result = await chat.handleMessage(parsed.data.text, config.uiLanguage);
    const text =
      "key" in result.reply ? renderMessage(result.reply, config.uiLanguage) : result.reply.text;
    return ChatMessageResponseSchema.parse({ ok: true, data: { ...result, reply: { text } } });
  });
  return app;
}
