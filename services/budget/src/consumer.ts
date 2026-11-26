import { parseEvent, type EventEnvelope, type SettingKey } from "@my-wife/contracts";
import { subject } from "@my-wife/service-kit";

export const ONBOARDING_SUBJECT = "onboarding.step_completed";
/** Replicas of budget share one queue group so each event is handled once. */
export const BUDGET_QUEUE_GROUP = "budget";

export interface MessageLike {
  string(): string;
}

/** The slice of a NATS connection the consumer needs; core NATS, not JetStream. */
export interface SubscribeLike {
  subscribe(subject: string, opts: { queue: string }): AsyncIterable<MessageLike>;
}

export interface ConsumerLog {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * Consumes `onboarding.step_completed` under the subject prefix. Payloads are validated with
 * `parseEvent`; invalid messages are dropped and a handler failure is logged, never fatal.
 * Resolves when the subscription ends.
 */
export async function runOnboardingConsumer(opts: {
  nats: SubscribeLike;
  prefix: string;
  handler: (event: EventEnvelope) => Promise<void>;
  log: ConsumerLog;
}): Promise<void> {
  const sub = opts.nats.subscribe(subject(opts.prefix, ONBOARDING_SUBJECT), {
    queue: BUDGET_QUEUE_GROUP,
  });
  for await (const msg of sub) {
    try {
      const parsed = parseEvent(JSON.parse(msg.string()));
      if (!parsed.success) {
        opts.log.warn({ error: parsed.error }, "dropped invalid onboarding event");
        continue;
      }
      if (parsed.data.type !== ONBOARDING_SUBJECT) {
        opts.log.warn({ type: parsed.data.type }, "dropped unexpected event type");
        continue;
      }
      await opts.handler(parsed.data);
    } catch (err) {
      opts.log.error({ err }, "onboarding handler failed");
    }
  }
}

/**
 * Reads the user's effective settings (registry defaults merged with overrides) from identity.
 * The gateway convention is the `x-user-id` header on internal calls. Returns an empty object
 * on any failure so the sample budget falls back to defaults rather than blocking onboarding.
 */
export function createSettingsReader(opts: {
  identityUrl: string;
  fetchFn?: typeof fetch;
}): (userId: string) => Promise<Partial<Record<SettingKey, unknown>>> {
  const doFetch = opts.fetchFn ?? fetch;
  return async (userId) => {
    try {
      const res = await doFetch(`${opts.identityUrl}/settings`, {
        headers: { "x-user-id": userId },
      });
      if (!res.ok) return {};
      const body = (await res.json()) as { ok?: boolean; data?: { values?: unknown } };
      const values = body.data?.values;
      return body.ok && values && typeof values === "object"
        ? (values as Partial<Record<SettingKey, unknown>>)
        : {};
    } catch {
      return {};
    }
  };
}
