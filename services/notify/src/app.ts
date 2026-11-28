import type { AppConfig } from "@my-wife/config";
import {
  InboxQuerySchema,
  LocaleSchema,
  PushSubscriptionRequestSchema,
  type CommandDefinition,
} from "@my-wife/contracts";
import { suggestCommands } from "./commands/menu";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";
import { inboxKey, InMemoryInbox, type Inbox, type InboxEntry } from "./dispatch/dispatcher";
import { InMemoryQuestionStore, type QuestionStore } from "./questions/question-service";
import { InvalidPushEndpointError, type PushService } from "./push/push-service";

export const SERVICE_NAME = "notify";

export type NotifyDeps = ServiceDeps & {
  /** Web push; routes are mounted only when given. */
  push?: PushService;
  /** Message history behind `GET /inbox`; defaults to an in-memory inbox. */
  inbox?: Inbox;
  /** Joins the question of a question message; defaults to an in-memory store. */
  questionStore?: QuestionStore;
  /** The user's command definitions (built-ins with overrides plus custom); enables autocomplete. */
  commandSource?: (userId: string) => Promise<CommandDefinition[]>;
};

const INBOX_MAX_PAGE = 100;
/** Question messages are stored as `question-<questionId>` by the question service. */
const QUESTION_MESSAGE_PREFIX = "question-";
const CURSOR_PATTERN = /^[0-9TZ:.+-]+\|.+$/;

const SUGGEST_QUERY_MAX = 64;

const UnsubscribeSchema = PushSubscriptionRequestSchema.pick({ endpoint: true });

/** Factory used by main.ts, the dev runner and tests; no process-level globals (ADR 0007). */
export function createApp(config: AppConfig, deps: NotifyDeps = {}) {
  const app = createServiceApp({
    name: SERVICE_NAME,
    logLevel: config.logLevel,
    nats: deps.nats,
  });
  const inbox = deps.inbox ?? new InMemoryInbox();
  const questionStore = deps.questionStore ?? new InMemoryQuestionStore();
  {
    const questionOf = (userId: string, entry: InboxEntry) => {
      const { id, class: cls } = entry.message;
      if (cls !== "question" || !id.startsWith(QUESTION_MESSAGE_PREFIX)) return null;
      const record = questionStore.get(id.slice(QUESTION_MESSAGE_PREFIX.length));
      return record && record.userId === userId ? record.question : null;
    };

    // Newest first, keyset-paginated; `nextCursor` is opaque and null on the last page.
    app.get("/inbox", async (req, reply) => {
      const userId = req.headers["x-user-id"];
      if (typeof userId !== "string" || userId === "") {
        return reply.code(401).send({ ok: false, error: { code: "notify.unauthorized" } });
      }
      const raw = req.query as Record<string, string | undefined>;
      if (raw.limit !== undefined && !/^\d+$/.test(raw.limit)) {
        return reply.code(400).send({ ok: false, error: { code: "notify.invalid_query" } });
      }
      // Larger limits are clamped to the cap rather than refused.
      const limit =
        raw.limit === undefined ? undefined : Math.min(Number(raw.limit), INBOX_MAX_PAGE);
      const parsed = InboxQuerySchema.safeParse({ ...raw, limit });
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: { code: "notify.invalid_query" } });
      }
      const q = parsed.data;
      let after: string | null = null;
      if (q.cursor !== undefined && q.cursor !== "") {
        after = Buffer.from(q.cursor, "base64url").toString("utf8");
        if (!CURSOR_PATTERN.test(after)) {
          return reply.code(400).send({ ok: false, error: { code: "notify.invalid_cursor" } });
        }
      }
      const page = await inbox.page(userId, {
        limit: q.limit,
        after,
        accept: (entry) => {
          if (q.service !== undefined && entry.message.sourceService !== q.service) return false;
          if (q.class !== undefined && entry.message.class !== q.class) return false;
          if (q.state !== undefined && questionOf(userId, entry)?.state !== q.state) return false;
          return true;
        },
      });
      const items = page.items.map((entry) => ({
        id: entry.message.id,
        class: entry.message.class,
        messageKey: entry.message.message.key,
        params: entry.message.message.params,
        question: questionOf(userId, entry),
        createdAt: entry.message.createdAt,
      }));
      const last = page.items[page.items.length - 1];
      const nextCursor =
        page.next === null || !last
          ? null
          : Buffer.from(inboxKey(last.message)).toString("base64url");
      return { ok: true, data: { items, nextCursor } };
    });
  }

  const commandSource = deps.commandSource;
  if (commandSource) {
    // In-app chat autocomplete: suggestions for a bare `/prefix`.
    app.get("/commands/suggest", async (req, reply) => {
      const userId = req.headers["x-user-id"];
      if (typeof userId !== "string" || userId === "") {
        return reply.code(401).send({ ok: false, error: { code: "notify.unauthorized" } });
      }
      const query = req.query as Record<string, unknown>;
      const locale = LocaleSchema.safeParse(query.locale ?? "vi");
      if (typeof query.q !== "string" || query.q.length > SUGGEST_QUERY_MAX || !locale.success) {
        return reply.code(400).send({ ok: false, error: { code: "notify.invalid_query" } });
      }
      const defs = await commandSource(userId);
      return { ok: true, data: { items: suggestCommands(query.q, defs, locale.data) } };
    });
  }

  const push = deps.push;
  if (push) {
    const userOf = (header: unknown) => (typeof header === "string" && header ? header : null);

    app.post("/push/subscriptions", async (req, reply) => {
      const userId = userOf(req.headers["x-user-id"]);
      if (!userId)
        return reply.code(401).send({ ok: false, error: { code: "notify.unauthorized" } });
      const parsed = PushSubscriptionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: { code: "notify.invalid_subscription" } });
      }
      try {
        const { id } = await push.subscribe(userId, parsed.data);
        return reply.code(201).send({ ok: true, data: { id } });
      } catch (err) {
        if (err instanceof InvalidPushEndpointError) {
          return reply
            .code(400)
            .send({ ok: false, error: { code: "notify.invalid_subscription" } });
        }
        throw err;
      }
    });

    app.delete("/push/subscriptions", async (req, reply) => {
      const userId = userOf(req.headers["x-user-id"]);
      if (!userId)
        return reply.code(401).send({ ok: false, error: { code: "notify.unauthorized" } });
      const parsed = UnsubscribeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: { code: "notify.invalid_subscription" } });
      }
      await push.unsubscribe(userId, parsed.data.endpoint);
      return reply.code(204).send();
    });
  }
  return app;
}
