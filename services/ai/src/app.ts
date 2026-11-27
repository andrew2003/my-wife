import { servicePort, type AppConfig } from "@my-wife/config";
import {
  ChatMessageRequestSchema,
  ChatMessageResponseSchema,
  SaveLlmKeyRequestSchema,
  SETTINGS,
} from "@my-wife/contracts";
import type { Writable } from "node:stream";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";
import { ChatService } from "./chat/chat-service";
import { renderMessage } from "./i18n";
import {
  createKeyValidator,
  InMemoryLlmKeyStore,
  LlmKeyService,
  parseKeyring,
  SecretsUnavailableError,
  type KeyValidator,
  type LlmKeyStore,
} from "./keys";
import { createProvider, type LlmProvider } from "./llm";
import { InMemoryMemoryStore, loadMemoryLimits, MemoryService, type MemoryStore } from "./memory";
import { createSettingsReader } from "./settings";
import {
  createVisionModel,
  InMemoryChallengeStore,
  WakeError,
  WakeService,
  type ChallengeStore,
  type VisionModel,
} from "./wake";

export const SERVICE_NAME = "ai";

declare module "fastify" {
  interface FastifyInstance {
    /** Internal access to the key service; `resolve` returns a decrypted key and must never reach a response. */
    llmKeys: LlmKeyService;
  }
}
/** Largest accepted photo request body (base64 text), 10 MiB. */
const WAKE_PHOTO_BODY_LIMIT = 10 * 1024 * 1024;

export interface AiDeps extends ServiceDeps {
  provider?: LlmProvider;
  publish?: (event: {
    name:
      | "ai.message_sent"
      | "memory.created"
      | "ai.photo_graded"
      | "llm_key.saved"
      | "llm_key.invalid";
    payload: unknown;
  }) => Promise<void>;
  memoryStore?: MemoryStore;
  /** Effective user settings (identity `GET /settings`); defaults to an HTTP reader. */
  readSettings?: (userId: string) => Promise<Record<string, unknown>>;
  challengeStore?: ChallengeStore;
  /** Vision model for wake photos; the fake one until M4. */
  visionModel?: VisionModel;
  /**
   * Whether the user gave the `wake_photo` consent. No read route exists in identity yet, so the
   * default allows it (the fake model sends the photo nowhere); see docs/decisions.md.
   */
  hasWakePhotoConsent?: (userId: string) => Promise<boolean>;
  /** Encrypted storage for user LLM keys; in memory until the database lands. */
  keyStore?: LlmKeyStore;
  /** Decides whether a provider accepts a key; offline shape check by default. */
  keyValidator?: KeyValidator;
  /** Log destination, for tests that scan logs. */
  logStream?: Writable;
  now?: () => Date;
  memoryLimits?: { maxFactLength: number; maxPerTurn: number };
}

/** Factory used by main.ts, the dev runner and tests; no process-level globals (ADR 0007). */
export function createApp(config: AppConfig, deps: AiDeps = {}) {
  const app = createServiceApp({
    name: SERVICE_NAME,
    logLevel: config.logLevel,
    nats: deps.nats,
    logStream: deps.logStream,
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
  const now = deps.now ?? (() => new Date());
  const userOf = (header: unknown) =>
    typeof header === "string" && header !== "" ? header : "local";
  const wake = new WakeService({
    store: deps.challengeStore ?? new InMemoryChallengeStore(),
    vision: deps.visionModel ?? createVisionModel(),
    publish,
    readSettings,
    hasConsent: deps.hasWakePhotoConsent ?? (async () => true),
    warn: (fields, message) => app.log.warn(fields, message),
  });
  const WAKE_STATUS = {
    consent_required: 403,
    not_found: 404,
    expired: 410,
    already_graded: 409,
    empty_image: 400,
    grading_failed: 502,
  } as const;
  app.post("/wake/challenges", async (req, reply) => {
    try {
      const c = await wake.createChallenge(userOf(req.headers["x-user-id"]), now());
      const ref = { key: c.messageKey, params: c.params };
      return reply.code(201).send({
        ok: true,
        data: {
          challengeId: c.id,
          message: ref,
          text: renderMessage(ref, config.uiLanguage),
          expiresAt: c.expiresAt.toISOString(),
        },
      });
    } catch (error) {
      if (error instanceof WakeError)
        return reply.code(WAKE_STATUS[error.code]).send({ ok: false, error: error.code });
      throw error;
    }
  });
  // The body holds a photo: it is never logged, stored or echoed.
  app.post<{ Params: { id: string } }>(
    "/wake/challenges/:id/photo",
    { bodyLimit: WAKE_PHOTO_BODY_LIMIT },
    async (req, reply) => {
      const body = req.body as { imageBase64?: unknown } | null;
      if (typeof body?.imageBase64 !== "string")
        return reply.code(400).send({ ok: false, error: "invalid_request" });
      try {
        const grade = await wake.submitPhoto(
          userOf(req.headers["x-user-id"]),
          req.params.id,
          Buffer.from(body.imageBase64, "base64"),
          now(),
        );
        return { ok: true, data: { grade } };
      } catch (error) {
        if (error instanceof WakeError)
          return reply.code(WAKE_STATUS[error.code]).send({ ok: false, error: error.code });
        throw error;
      }
    },
  );
  const keys = new LlmKeyService({
    store: deps.keyStore ?? new InMemoryLlmKeyStore(),
    validator: deps.keyValidator ?? createKeyValidator(),
    ring: config.secretsMasterKey
      ? parseKeyring({
          currentKeyId: config.secretsKeyId,
          masterKey: config.secretsMasterKey,
          previousKeys: config.secretsPreviousKeys,
        })
      : null,
    publish,
  });
  app.decorate("llmKeys", keys);
  // Key routes answer with the key view only; the secret is never echoed, stored in the clear or logged.
  app.post("/keys", async (req, reply) => {
    const parsed = SaveLlmKeyRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "invalid_request" });
    try {
      const key = await keys.save(userOf(req.headers["x-user-id"]), parsed.data);
      return { ok: true, data: { key } };
    } catch (error) {
      if (error instanceof SecretsUnavailableError)
        return reply.code(503).send({ ok: false, error: "secrets_unavailable" });
      throw error;
    }
  });
  app.get("/keys", async (req) => ({
    ok: true,
    data: { keys: await keys.list(userOf(req.headers["x-user-id"])) },
  }));
  app.delete<{ Params: { id: string } }>("/keys/:id", async (req, reply) => {
    const removed = await keys.remove(userOf(req.headers["x-user-id"]), req.params.id);
    return removed
      ? { ok: true, data: {} }
      : reply.code(404).send({ ok: false, error: "not_found" });
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
