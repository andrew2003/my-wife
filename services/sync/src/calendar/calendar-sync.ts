/** A task or routine block as it must appear in Google Calendar (lunar dates already solar). */
export type CalendarItem = {
  /** Stable entity id (`task.id`); the mapping table links it to the external id. */
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
};

export type CalendarEventBody = {
  /** External event id, derived from the entity id so a create is idempotent. */
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
};

/** Thrown by the client when an event with that id already exists (HTTP 409). */
export class CalendarEventExistsError extends Error {
  constructor() {
    super("calendar_event_exists");
  }
}

/** Port to Google Calendar; the real HTTP client implements it, tests use a fake. */
export interface CalendarClient {
  createEvent(accessToken: string, body: CalendarEventBody): Promise<void>;
  updateEvent(accessToken: string, id: string, body: CalendarEventBody): Promise<void>;
  deleteEvent(accessToken: string, id: string): Promise<void>;
}

export type EventMapEntry = { entityId: string; externalId: string; fingerprint: string };

/** Mapping `entity id -> external id` (spec: mapping table). */
export interface EventMap {
  get(userId: string, entityId: string): Promise<EventMapEntry | undefined>;
  put(userId: string, entry: EventMapEntry): Promise<void>;
  delete(userId: string, entityId: string): Promise<void>;
  list(userId: string): Promise<EventMapEntry[]>;
}

export class InMemoryEventMap implements EventMap {
  private rows = new Map<string, EventMapEntry>();
  async get(userId: string, entityId: string) {
    return this.rows.get(`${userId}:${entityId}`);
  }
  async put(userId: string, entry: EventMapEntry) {
    this.rows.set(`${userId}:${entry.entityId}`, { ...entry });
  }
  async delete(userId: string, entityId: string) {
    this.rows.delete(`${userId}:${entityId}`);
  }
  async list(userId: string) {
    const prefix = `${userId}:`;
    return [...this.rows.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
  }
}

export type CalendarSyncDeps = {
  client: CalendarClient;
  map: EventMap;
  /** Null when the link is unusable (revoked consent, not linked): no Google call is made. */
  accessToken(userId: string): Promise<string | null>;
  maskTitles(userId: string): Promise<boolean>;
  /** The user's `sync.calendar_horizon_weeks`. */
  horizonWeeks(userId: string): Promise<number>;
  /** Locale lookup for the title shown when titles are masked. */
  maskedTitle(): string;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Google event ids allow only a-v and 0-9, so the entity id is hex encoded. */
export const externalEventId = (entityId: string) => Buffer.from(entityId, "utf8").toString("hex");

export class CalendarSyncService {
  constructor(private readonly deps: CalendarSyncDeps) {}

  /** Creates the event, or updates the one already mapped; never creates a second. */
  async upsert(userId: string, item: CalendarItem, now: Date): Promise<void> {
    const token = await this.deps.accessToken(userId);
    if (!token) return;
    await this.apply(userId, token, item, now);
  }

  async remove(userId: string, entityId: string, _now: Date): Promise<void> {
    const token = await this.deps.accessToken(userId);
    if (!token) return;
    await this.drop(userId, token, entityId);
  }

  /** Makes the calendar match the schedule: creates, updates and deletes. */
  async reconcile(userId: string, items: CalendarItem[], now: Date): Promise<void> {
    const token = await this.deps.accessToken(userId);
    if (!token) return;
    const wanted = new Set(items.map((i) => i.id));
    for (const entry of await this.deps.map.list(userId)) {
      if (!wanted.has(entry.entityId)) await this.drop(userId, token, entry.entityId);
    }
    for (const item of items) await this.apply(userId, token, item, now);
  }

  private async apply(userId: string, token: string, item: CalendarItem, now: Date) {
    const weeks = await this.deps.horizonWeeks(userId);
    if (Date.parse(item.startsAt) >= now.getTime() + weeks * WEEK_MS) {
      await this.drop(userId, token, item.id);
      return;
    }
    const masked = await this.deps.maskTitles(userId);
    const body: CalendarEventBody = {
      id: externalEventId(item.id),
      title: masked ? this.deps.maskedTitle() : item.title,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
    };
    const fingerprint = JSON.stringify([body.title, body.startsAt, body.endsAt]);
    const mapped = await this.deps.map.get(userId, item.id);
    if (mapped?.fingerprint === fingerprint) return;
    if (mapped) {
      await this.deps.client.updateEvent(token, mapped.externalId, body);
    } else {
      try {
        await this.deps.client.createEvent(token, body);
      } catch (e) {
        if (!(e instanceof CalendarEventExistsError)) throw e;
        // The mapping was lost but the event exists: update it instead of duplicating.
        await this.deps.client.updateEvent(token, body.id, body);
      }
    }
    await this.deps.map.put(userId, { entityId: item.id, externalId: body.id, fingerprint });
  }

  private async drop(userId: string, token: string, entityId: string) {
    const mapped = await this.deps.map.get(userId, entityId);
    if (!mapped) return;
    await this.deps.client.deleteEvent(token, mapped.externalId);
    await this.deps.map.delete(userId, entityId);
  }
}
