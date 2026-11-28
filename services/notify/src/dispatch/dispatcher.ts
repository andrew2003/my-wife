import { notifyEvents, SETTINGS, type OutboundMessage, type TimeRange } from "@my-wife/contracts";

type DeliveryChannel = (typeof notifyEvents)["notify.delivery_failed"]["_output"]["channel"];

/**
 * Seconds to wait before each retry; the last value repeats. The registry has no key for it
 * (contracts are frozen), so it is a service option with this default, like `sync`'s backoff.
 */
export const DEFAULT_RETRY_BACKOFF_SECONDS: readonly number[] = [30, 120, 600];

export type DigestKind = "morning" | "evening";

/** Per-user values read from the settings registry (`notify.quiet_hours`, `calendar.time_zone`). */
export interface DispatchSettings {
  quietHours: TimeRange;
  timeZone: string;
  /** `notify.morning_digest_time`; defaults to the registry default. */
  morningDigestTime?: string;
  /** `notify.evening_digest_time`; defaults to the registry default. */
  eveningDigestTime?: string;
  /** `notify.delivery_retries`; defaults to the registry default. */
  deliveryRetries?: number;
  /** Channel named in `notify.delivery_failed`; defaults to `notify.channel`'s default. */
  channel?: DeliveryChannel;
}

export interface InboxEntry {
  message: OutboundMessage;
  /** Held for a digest and not yet batched into one. */
  pendingDigest: boolean;
}

/** Every message of every class is recorded here, even if chat delivery fails. */
export interface Inbox {
  add(userId: string, entry: InboxEntry): Promise<void>;
  list(userId: string): Promise<InboxEntry[]>;
  pending(userId: string): Promise<InboxEntry[]>;
  markDigested(userId: string, messageIds: string[]): Promise<void>;
  /**
   * Newest first by (createdAt, id), keyset-paginated: `after` is the key of the last item of
   * the previous page and `next` is null on the last page. `accept` filters on the joined view.
   * A persistent implementation must back this with an index on
   * (user_id, created_at DESC, id DESC).
   */
  page(userId: string, query: InboxPageQuery): Promise<InboxPage>;
}

export interface InboxPageQuery {
  limit: number;
  after: string | null;
  accept?: (entry: InboxEntry) => boolean;
}

export interface InboxPage {
  items: InboxEntry[];
  next: string | null;
}

/** Sort key of a message; ISO timestamps have a fixed width, so string order is time order. */
export function inboxKey(message: Pick<OutboundMessage, "createdAt" | "id">): string {
  return `${message.createdAt}|${message.id}`;
}

export class InMemoryInbox implements Inbox {
  private entries = new Map<string, InboxEntry[]>();
  /** Per-user entries kept newest first on insert (the in-memory index), so a page never sorts. */
  private byRecency = new Map<string, InboxEntry[]>();

  async add(userId: string, entry: InboxEntry): Promise<void> {
    this.entries.set(userId, [...(this.entries.get(userId) ?? []), entry]);
    const list = [...(this.byRecency.get(userId) ?? [])];
    const key = inboxKey(entry.message);
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (inboxKey(list[mid]!.message) > key) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, entry);
    this.byRecency.set(userId, list);
  }
  async page(userId: string, query: InboxPageQuery): Promise<InboxPage> {
    const list = this.byRecency.get(userId) ?? [];
    let lo = 0;
    if (query.after !== null) {
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (inboxKey(list[mid]!.message) >= query.after) lo = mid + 1;
        else hi = mid;
      }
    }
    const items: InboxEntry[] = [];
    let more = false;
    for (let i = lo; i < list.length; i++) {
      const entry = list[i]!;
      if (query.accept && !query.accept(entry)) continue;
      if (items.length === query.limit) {
        more = true;
        break;
      }
      items.push(entry);
    }
    const last = items[items.length - 1];
    return { items, next: more && last ? inboxKey(last.message) : null };
  }
  async list(userId: string): Promise<InboxEntry[]> {
    return this.entries.get(userId) ?? [];
  }
  async pending(userId: string): Promise<InboxEntry[]> {
    return (this.entries.get(userId) ?? []).filter((e) => e.pendingDigest);
  }
  async markDigested(userId: string, messageIds: string[]): Promise<void> {
    for (const entry of this.entries.get(userId) ?? []) {
      if (messageIds.includes(entry.message.id)) entry.pendingDigest = false;
    }
  }
}

export interface DispatchEvent {
  name: "digest.sent" | "notify.delivery_failed";
  payload: unknown;
}

export interface DispatcherDeps {
  /** Time is a parameter so quiet hours can be simulated. */
  now: () => Date;
  settings: { get(userId: string): Promise<DispatchSettings> };
  inbox: Inbox;
  /** Sends one message to the user's chat channel. */
  deliver: (userId: string, message: OutboundMessage) => Promise<void>;
  /** Sends one digest message that batches the held items. */
  deliverDigest: (userId: string, items: InboxEntry[], kind: DigestKind) => Promise<void>;
  publish: (event: DispatchEvent) => Promise<void>;
  /** Seconds before each retry (last value repeats). */
  retryBackoffSeconds?: readonly number[];
}

export interface Dispatcher {
  send(
    userId: string,
    message: OutboundMessage,
  ): Promise<{ messageId: string; deferredToDigest: boolean }>;
  /** Batches the held items into a digest; returns the item count (0 sends nothing). */
  flushDigest(userId: string, kind: DigestKind): Promise<number>;
  /**
   * Sends each user's morning and evening digest once per local day, once `now()` has reached
   * the configured time; run it from a timer.
   */
  runDigests(userIds: readonly string[]): Promise<void>;
  /** Retries every failed delivery that is due at `now()`; run it from a timer. */
  runRetries(): Promise<void>;
}

interface PendingRetry {
  userId: string;
  message: OutboundMessage;
  /** Delivery attempts made so far. */
  attempts: number;
  nextAt: number;
}

function minutesOfDay(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function localMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(at);
}

/** `from` is inclusive, `to` exclusive; a range may cross midnight; `from == to` is empty. */
export function isInQuietHours(at: Date, range: TimeRange, timeZone: string): boolean {
  const from = minutesOfDay(range.from);
  const to = minutesOfDay(range.to);
  if (from === to) return false;
  const now = localMinutes(at, timeZone);
  return from < to ? now >= from && now < to : now >= from || now < to;
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const backoff = deps.retryBackoffSeconds?.length
    ? deps.retryBackoffSeconds
    : DEFAULT_RETRY_BACKOFF_SECONDS;
  const retries = new Map<string, PendingRetry>();
  /** Local date of the last digest run, per user and kind. */
  const digestRuns = new Map<string, string>();

  /** One delivery attempt; on failure schedules a retry or, when exhausted, announces it. */
  async function attempt(userId: string, message: OutboundMessage, made: number): Promise<void> {
    const settings = await deps.settings.get(userId);
    const maxRetries = settings.deliveryRetries ?? SETTINGS["notify.delivery_retries"].default;
    try {
      await deps.deliver(userId, message);
      retries.delete(message.id);
      return;
    } catch {
      // Chat delivery failed: the inbox entry keeps the message visible.
    }
    const attempts = made + 1;
    if (attempts - 1 < maxRetries) {
      const delay = backoff[Math.min(attempts - 1, backoff.length - 1)] ?? 0;
      retries.set(message.id, {
        userId,
        message,
        attempts,
        nextAt: deps.now().getTime() + delay * 1000,
      });
      return;
    }
    retries.delete(message.id);
    await deps.publish({
      name: "notify.delivery_failed",
      payload: notifyEvents["notify.delivery_failed"].parse({
        messageId: message.id,
        channel: settings.channel ?? SETTINGS["notify.channel"].default,
        attempts,
      }),
    });
  }

  const dispatcher: Dispatcher = {
    async runDigests(userIds) {
      for (const userId of userIds) {
        const settings = await deps.settings.get(userId);
        const at = deps.now();
        const today = localDate(at, settings.timeZone);
        const minutes = localMinutes(at, settings.timeZone);
        const times: [DigestKind, string][] = [
          ["morning", settings.morningDigestTime ?? SETTINGS["notify.morning_digest_time"].default],
          ["evening", settings.eveningDigestTime ?? SETTINGS["notify.evening_digest_time"].default],
        ];
        // Several digests due at once (late start): only the latest-time one is sent, so a
        // morning digest never arrives in the evening; the earlier ones count as done.
        const due = times
          .filter(
            ([kind, time]) =>
              minutes >= minutesOfDay(time) && digestRuns.get(`${userId}:${kind}`) !== today,
          )
          .sort((a, b) => minutesOfDay(a[1]) - minutesOfDay(b[1]));
        for (const [kind] of due) digestRuns.set(`${userId}:${kind}`, today);
        const latest = due.at(-1);
        if (latest) await dispatcher.flushDigest(userId, latest[0]);
      }
    },

    async runRetries() {
      const nowMs = deps.now().getTime();
      for (const retry of [...retries.values()]) {
        if (retry.nextAt <= nowMs) await attempt(retry.userId, retry.message, retry.attempts);
      }
    },

    async send(userId, message) {
      const settings = await deps.settings.get(userId);
      const quiet = isInQuietHours(deps.now(), settings.quietHours, settings.timeZone);
      // Only urgent and wake-up messages pass quiet hours; digest-class messages always batch.
      const passes = message.class === "urgent" || message.isWakeUp;
      const deferred = message.class === "digest" || (quiet && !passes);
      await deps.inbox.add(userId, { message, pendingDigest: deferred });
      if (!deferred) {
        await attempt(userId, message, 0);
      }
      return { messageId: message.id, deferredToDigest: deferred };
    },

    async flushDigest(userId, kind) {
      const items = await deps.inbox.pending(userId);
      if (items.length === 0) return 0;
      await deps.deliverDigest(userId, items, kind);
      await deps.inbox.markDigested(
        userId,
        items.map((i) => i.message.id),
      );
      await deps.publish({
        name: "digest.sent",
        payload: notifyEvents["digest.sent"].parse({ digest: kind, itemCount: items.length }),
      });
      return items.length;
    },
  };
  return dispatcher;
}
