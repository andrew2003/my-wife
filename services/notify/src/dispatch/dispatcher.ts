import { notifyEvents, type OutboundMessage, type TimeRange } from "@my-wife/contracts";

export type DigestKind = "morning" | "evening";

/** Per-user values read from the settings registry (`notify.quiet_hours`, `calendar.time_zone`). */
export interface DispatchSettings {
  quietHours: TimeRange;
  timeZone: string;
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
}

export class InMemoryInbox implements Inbox {
  private entries = new Map<string, InboxEntry[]>();

  async add(userId: string, entry: InboxEntry): Promise<void> {
    this.entries.set(userId, [...(this.entries.get(userId) ?? []), entry]);
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
  name: "digest.sent";
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
}

export interface Dispatcher {
  send(
    userId: string,
    message: OutboundMessage,
  ): Promise<{ messageId: string; deferredToDigest: boolean }>;
  /** Batches the held items into a digest; returns the item count (0 sends nothing). */
  flushDigest(userId: string, kind: DigestKind): Promise<number>;
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

/** `from` is inclusive, `to` exclusive; a range may cross midnight; `from == to` is empty. */
export function isInQuietHours(at: Date, range: TimeRange, timeZone: string): boolean {
  const from = minutesOfDay(range.from);
  const to = minutesOfDay(range.to);
  if (from === to) return false;
  const now = localMinutes(at, timeZone);
  return from < to ? now >= from && now < to : now >= from || now < to;
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  return {
    async send(userId, message) {
      const settings = await deps.settings.get(userId);
      const quiet = isInQuietHours(deps.now(), settings.quietHours, settings.timeZone);
      // Only urgent and wake-up messages pass quiet hours; digest-class messages always batch.
      const passes = message.class === "urgent" || message.isWakeUp;
      const deferred = message.class === "digest" || (quiet && !passes);
      await deps.inbox.add(userId, { message, pendingDigest: deferred });
      if (!deferred) {
        try {
          await deps.deliver(userId, message);
        } catch {
          // Chat delivery failed: the inbox entry above keeps the message visible.
        }
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
}
