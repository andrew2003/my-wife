import { servicePort, type AppConfig } from "@my-wife/config";
import {
  ChatMessageRequestSchema,
  ChatMessageResponseSchema,
  DegradedStatusSchema,
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
import { runHandoverTest, type HandoverFact } from "./handover";
import { createProvider, type LlmProvider } from "./llm";
import { InMemoryConversationStore, SummaryService, type ConversationStore } from "./conversation";
import {
  InMemoryMemoryStore,
  loadMemoryLimits,
  loadSummaryMaxLength,
  MemoryService,
  type MemoryStore,
} from "./memory";
import { RemarkService, type RemarkFacts } from "./remarks";
import { createSettingsReader } from "./settings";
import { InMemoryAuditLog, ToolExecutor, type ToolBackends } from "./tools";
import {
  createVisionModel,
  InMemoryChallengeStore,
  InMemoryFailedPhotoStore,
  WakeError,
  WakeService,
  type ChallengeStore,
  type FailedPhotoStore,
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
  /** Second model for failover; none until a fallback key has a real adapter. */
  fallbackProvider?: LlmProvider;
  publish?: (event: {
    name:
      | "ai.message_sent"
      | "memory.created"
      | "memory.deleted"
      | "persona.updated"
      | "ai.photo_graded"
      | "llm_key.saved"
      | "llm_key.invalid"
      | "ai.handover_passed"
      | "ai.handover_failed"
      | "ai.model_changed"
      | "ai.degraded_entered"
      | "ai.degraded_exited"
      | "ai.token_cap_reached";
    payload: unknown;
  }) => Promise<void>;
  memoryStore?: MemoryStore;
  conversationStore?: ConversationStore;
  /** Effective user settings (identity `GET /settings`); defaults to an HTTP reader. */
  readSettings?: (userId: string) => Promise<Record<string, unknown>>;
  challengeStore?: ChallengeStore;
  /** Encrypted failing wake photos kept until the appeal window ends; in memory for now. */
  failedPhotoStore?: FailedPhotoStore;
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
  /**
   * The code-computed facts the handover questions are graded against, from the user's current
   * data. Defaults to none, which makes the test pass trivially (see docs/decisions.md).
   */
  handoverFacts?: (userId: string) => Promise<HandoverFact[]>;
  /** Builds the candidate provider for a handover test; the fake one by default. */
  providerFor?: (candidate: { provider: string; model: string; apiKey: string }) => LlmProvider;
  /** Log destination, for tests that scan logs. */
  logStream?: Writable;
  now?: () => Date;
  /** Longest accepted conversation summary; defaults to `AI_SUMMARY_MAX_LENGTH`. */
  summaryMaxLength?: number;
  memoryLimits?: { maxFactLength: number; maxPerTurn: number };
  /** REST wrappers for quick capture; none are wired yet, so a capture is audited as failed. */
  toolBackends?: ToolBackends;
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
  const memoryStore = deps.memoryStore ?? new InMemoryMemoryStore();
  const conversations = deps.conversationStore ?? new InMemoryConversationStore();
  const provider = deps.provider ?? createProvider();
  const memory = new MemoryService({
    store: memoryStore,
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
    provider,
    publish,
    memory,
    conversations,
    fallback: deps.fallbackProvider,
    tools: new ToolExecutor({
      audit: new InMemoryAuditLog(),
      backends: deps.toolBackends ?? {},
      now: deps.now ?? (() => new Date()),
    }),
    now: deps.now,
    readSettings,
    warn: (fields, message) => app.log.warn(fields, message),
  });
  const now = deps.now ?? (() => new Date());
  const remarks = new RemarkService({
    provider,
    readSettings,
    now,
    isDegraded: (userId) => chat.statusOf(userId).degraded,
    warn: (fields, message) => app.log.warn(fields, message),
  });
  // Companion panel remark: the web sends code-computed facts; the text is number-checked.
  app.post("/remarks", async (req, reply) => {
    const body = req.body as { screen?: unknown; facts?: unknown; locale?: unknown } | null;
    const facts = body?.facts;
    const valid =
      typeof body?.screen === "string" &&
      /^[a-z][a-z0-9_-]{0,63}$/.test(body.screen) &&
      facts !== null &&
      typeof facts === "object" &&
      !Array.isArray(facts) &&
      Object.values(facts).every((v) => typeof v === "string" || typeof v === "number");
    if (!valid) return reply.code(400).send({ ok: false, error: "invalid_request" });
    const locale = body.locale === "vi" || body.locale === "en" ? body.locale : config.uiLanguage;
    const data = await remarks.remark({
      userId: userOf(req.headers["x-user-id"]),
      screen: body.screen as string,
      facts: facts as RemarkFacts,
      locale,
    });
    return { ok: true, data };
  });
  const summaries = new SummaryService({
    conversations,
    memories: memoryStore,
    provider,
    publish,
    readSettings,
    maxLength: deps.summaryMaxLength ?? loadSummaryMaxLength(),
    locale: config.uiLanguage,
    warn: (fields, message) => app.log.warn(fields, message),
  });
  // Periodic job: summarises long conversations and compacts the old turns.
  app.post("/jobs/summaries", async () => ({
    ok: true,
    data: { summarised: await summaries.run(now()) },
  }));
  app.delete<{ Params: { id: string } }>("/memories/:id", async (req, reply) => {
    const deleted = await memory.delete(userOf(req.headers["x-user-id"]), req.params.id);
    return deleted
      ? { ok: true, data: {} }
      : reply.code(404).send({ ok: false, error: "not_found" });
  });
  const userOf = (header: unknown) =>
    typeof header === "string" && header !== "" ? header : "local";
  const ring = config.secretsMasterKey
    ? parseKeyring({
        currentKeyId: config.secretsKeyId,
        masterKey: config.secretsMasterKey,
        previousKeys: config.secretsPreviousKeys,
      })
    : null;
  const wake = new WakeService({
    failedPhotos: deps.failedPhotoStore ?? new InMemoryFailedPhotoStore(),
    ring,
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
        const outcome = await wake.submitPhoto(
          userOf(req.headers["x-user-id"]),
          req.params.id,
          Buffer.from(body.imageBase64, "base64"),
          now(),
        );
        const hint = (
          { retake: "ai.wake.retake", button_check_in: "ai.wake.button_check_in" } as Record<
            string,
            string
          >
        )[outcome.next];
        return {
          ok: true,
          data: {
            ...outcome,
            ...(hint ? { text: renderMessage({ key: hint, params: {} }, config.uiLanguage) } : {}),
          },
        };
      } catch (error) {
        if (error instanceof WakeError)
          return reply.code(WAKE_STATUS[error.code]).send({ ok: false, error: error.code });
        throw error;
      }
    },
  );
  // Periodic job: deletes failing photos whose appeal window has ended.
  app.post("/jobs/wake-photos", async () => ({
    ok: true,
    data: { deleted: await wake.purgeExpired(now()) },
  }));
  // The `wake_photo` consent was revoked: delete every kept photo at once.
  app.delete("/wake/photos", async (req) => ({
    ok: true,
    data: { deleted: await wake.deleteAllFor(userOf(req.headers["x-user-id"])) },
  }));
  const keys = new LlmKeyService({
    store: deps.keyStore ?? new InMemoryLlmKeyStore(),
    validator: deps.keyValidator ?? createKeyValidator(),
    ring,
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
  const validator = deps.keyValidator ?? createKeyValidator();
  // Switching a model: the candidate must pass the handover test before its key replaces the
  // active one. A failed test leaves the old model active. The key is never echoed or logged.
  app.post("/models/switch", async (req, reply) => {
    const parsed = SaveLlmKeyRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: "invalid_request" });
    const header = req.headers["x-user-id"];
    if (typeof header !== "string" || header === "")
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    const userId = header;
    const input = parsed.data;
    // Fail closed: without a real adapter for the candidate there is nothing to test.
    if (!deps.providerFor)
      return reply.code(503).send({ ok: false, error: "provider_unavailable" });
    const facts = (await deps.handoverFacts?.(userId)) ?? [];
    // A run with no questions proves nothing, so it never enables a model.
    if (facts.length === 0) return reply.code(409).send({ ok: false, error: "not_ready" });
    let keyOk: boolean;
    try {
      keyOk = await validator.validate(input);
    } catch {
      keyOk = false;
    }
    if (!keyOk) return reply.code(422).send({ ok: false, error: "key_invalid" });
    const settings = await readSettings(userId);
    const ratio = SETTINGS["ai.handover_pass_ratio"].schema.safeParse(
      settings["ai.handover_pass_ratio"],
    );
    const result = await runHandoverTest({
      provider: deps.providerFor(input),
      facts,
      locale: config.uiLanguage,
      role: input.role,
      passRatio: ratio.success ? ratio.data : SETTINGS["ai.handover_pass_ratio"].default,
    });
    if (result.state === "failed") {
      await publish({
        name: "ai.handover_failed",
        payload: {
          role: input.role,
          passRatio: result.passRatio,
          failedQuestions: result.failedQuestions,
        },
      });
      return { ok: true, data: result };
    }
    try {
      await keys.save(userId, input);
    } catch (error) {
      if (error instanceof SecretsUnavailableError)
        return reply.code(503).send({ ok: false, error: "secrets_unavailable" });
      throw error;
    }
    await publish({
      name: "ai.handover_passed",
      payload: { role: input.role, passRatio: result.passRatio },
    });
    await publish({
      name: "ai.model_changed",
      payload: { role: input.role, provider: input.provider, model: input.model },
    });
    return { ok: true, data: result };
  });
  const KEYS_DEFAULT_PAGE = 50;
  const KEYS_MAX_PAGE = 100;
  const KEYS_CURSOR_PATTERN = /^key_[0-9a-zA-Z-]+$/;
  // Ordered by key id, keyset-paginated; `nextCursor` is opaque and null on the last page.
  // Only the key view is returned, never key material.
  app.get("/keys", async (req, reply) => {
    const query = req.query as { limit?: string; cursor?: string };
    let limit = KEYS_DEFAULT_PAGE;
    if (query.limit !== undefined) {
      if (!/^\d+$/.test(query.limit) || Number(query.limit) < 1)
        return reply.code(400).send({ ok: false, error: "invalid_limit" });
      limit = Math.min(Number(query.limit), KEYS_MAX_PAGE);
    }
    let after: string | null = null;
    if (query.cursor !== undefined && query.cursor !== "") {
      after = Buffer.from(query.cursor, "base64url").toString("utf8");
      if (!KEYS_CURSOR_PATTERN.test(after))
        return reply.code(400).send({ ok: false, error: "invalid_cursor" });
    }
    const page = await keys.listPage(userOf(req.headers["x-user-id"]), limit, after);
    const nextCursor = page.next === null ? null : Buffer.from(page.next).toString("base64url");
    return { ok: true, data: { keys: page.keys, nextCursor } };
  });
  app.delete<{ Params: { id: string } }>("/keys/:id", async (req, reply) => {
    const removed = await keys.remove(userOf(req.headers["x-user-id"]), req.params.id);
    return removed
      ? { ok: true, data: {} }
      : reply.code(404).send({ ok: false, error: "not_found" });
  });
  // Banner signal for the web: true when no model answers. Rules, buttons and the inbox live in
  // other services and keep working.
  app.get("/status/degraded", async (req) => {
    const state = chat.statusOf(userOf(req.headers["x-user-id"]));
    return {
      ok: true,
      data: DegradedStatusSchema.parse({
        degraded: state.degraded,
        reason: state.degraded ? state.reason : null,
      }),
    };
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
