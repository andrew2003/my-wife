import {
  CalendarEventExistsError,
  CalendarSyncService,
  type CalendarClient,
  type CalendarEventBody,
  type CalendarItem,
  type EventMap,
} from "../calendar/calendar-sync";
import type { ProviderCalendar } from "../calendar/calendar-providers";
import { decryptToken, encryptToken } from "../auth/token-crypto";

export type AppleCredentials = {
  appleId: string;
  /** The app-specific password; plaintext only in memory. */
  appPassword: string;
  /** Collection URL of the dedicated calendar the app created (ends with `/`). */
  calendarUrl: string;
};

export interface AppleCredentialStore {
  save(userId: string, credentials: AppleCredentials): Promise<void>;
  load(userId: string): Promise<AppleCredentials | null>;
}

/** Encrypts the whole credential blob at rest (AES-256-GCM, same scheme as Google tokens). */
export class InMemoryAppleCredentialStore implements AppleCredentialStore {
  private rows = new Map<string, string>();
  constructor(private readonly secret: string) {}

  async save(userId: string, credentials: AppleCredentials) {
    this.rows.set(userId, encryptToken(JSON.stringify(credentials), this.secret));
  }

  async load(userId: string) {
    const raw = this.rows.get(userId);
    return raw ? (JSON.parse(decryptToken(raw, this.secret)) as AppleCredentials) : null;
  }

  /** What would be written to the database; for tests only. */
  rawRow(userId: string) {
    return this.rows.get(userId);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FetchLike = (url: string, init: any) => Promise<Response>;

/** Raised for a CalDAV failure; carries the status only, never credentials. */
export class CalDavError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
  ) {
    super(`caldav_${operation}_failed_${status}`);
  }
}

const icsStamp = (iso: string) =>
  new Date(iso)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
const icsText = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

export function toIcs(body: CalendarEventBody, now: Date): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//my-wife//sync//EN",
    "BEGIN:VEVENT",
    `UID:${body.id}@my-wife`,
    `DTSTAMP:${icsStamp(now.toISOString())}`,
    `DTSTART:${icsStamp(body.startsAt)}`,
    `DTEND:${icsStamp(body.endsAt)}`,
    `SUMMARY:${icsText(body.title)}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

/** Hand-written CalDAV client (no library): MKCALENDAR, PUT and DELETE only. */
class CalDavClient implements CalendarClient {
  constructor(
    private readonly fetchFn: FetchLike,
    private readonly creds: AppleCredentials,
    private readonly now: Date,
  ) {}

  private send(method: string, url: string, headers: Record<string, string>, body?: string) {
    const auth = Buffer.from(`${this.creds.appleId}:${this.creds.appPassword}`).toString("base64");
    return this.fetchFn(url, {
      method,
      headers: { Authorization: `Basic ${auth}`, ...headers },
      body,
    });
  }

  private eventUrl(id: string) {
    return `${this.creds.calendarUrl}${id}.ics`;
  }

  /** Creates the dedicated calendar; one that already exists (405) is fine. */
  async ensureCalendar() {
    const res = await this.send("MKCALENDAR", this.creds.calendarUrl, {});
    if (!res.ok && res.status !== 405) throw new CalDavError(res.status, "mkcalendar");
  }

  private put(body: CalendarEventBody, id: string, extra: Record<string, string>) {
    return this.send(
      "PUT",
      this.eventUrl(id),
      { "Content-Type": "text/calendar; charset=utf-8", ...extra },
      toIcs(body, this.now),
    );
  }

  async createEvent(_token: string, body: CalendarEventBody) {
    const res = await this.put(body, body.id, { "If-None-Match": "*" });
    if (res.status === 412) throw new CalendarEventExistsError();
    if (!res.ok) throw new CalDavError(res.status, "create");
  }

  async updateEvent(_token: string, id: string, body: CalendarEventBody) {
    const res = await this.put(body, id, {});
    if (!res.ok) throw new CalDavError(res.status, "update");
  }

  async deleteEvent(_token: string, id: string) {
    const res = await this.send("DELETE", this.eventUrl(id), {});
    if (!res.ok && res.status !== 404) throw new CalDavError(res.status, "delete");
  }
}

export type AppleCalendarDeps = {
  fetch: FetchLike;
  credentials: AppleCredentialStore;
  /** The user's `apple_calendar_sync` consent; false means no CalDAV call at all. */
  consent(userId: string): Promise<boolean>;
  map: EventMap;
  maskTitles(userId: string): Promise<boolean>;
  horizonWeeks(userId: string): Promise<number>;
  maskedTitle(): string;
  /** Receives non-secret messages only. */
  log?: (message: string) => void;
};

/** Apple Calendar mirror over iCloud CalDAV; same behaviour as the Google mirror. */
export class AppleCalendarProvider implements ProviderCalendar {
  private readonly ready = new Set<string>();
  constructor(private readonly deps: AppleCalendarDeps) {}

  upsert(userId: string, item: CalendarItem, now: Date) {
    return this.run(userId, now, (s) => s.upsert(userId, item, now));
  }

  remove(userId: string, entityId: string, now: Date) {
    return this.run(userId, now, (s) => s.remove(userId, entityId, now));
  }

  reconcile(userId: string, items: CalendarItem[], now: Date) {
    return this.run(userId, now, (s) => s.reconcile(userId, items, now));
  }

  private async run(userId: string, now: Date, op: (s: CalendarSyncService) => Promise<void>) {
    if (!(await this.deps.consent(userId))) return;
    const creds = await this.deps.credentials.load(userId);
    if (!creds) return;
    const client = new CalDavClient(this.deps.fetch, creds, now);
    const service = new CalendarSyncService({
      client,
      map: this.deps.map,
      accessToken: async () => "caldav",
      maskTitles: this.deps.maskTitles,
      horizonWeeks: this.deps.horizonWeeks,
      maskedTitle: this.deps.maskedTitle,
    });
    try {
      if (!this.ready.has(userId)) {
        await client.ensureCalendar();
        this.ready.add(userId);
      }
      await op(service);
    } catch (e) {
      this.deps.log?.(
        `apple calendar push failed: ${e instanceof CalDavError ? e.message : "unexpected error"}`,
      );
      throw e;
    }
  }
}
