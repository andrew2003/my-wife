import type { CalendarProvider } from "@my-wife/contracts";
import type { CalendarItem } from "./calendar-sync";

export type { CalendarItem };

/** What every calendar provider (Google, Apple) offers; `CalendarSyncService` fits it. */
export interface ProviderCalendar {
  upsert(userId: string, item: CalendarItem, now: Date): Promise<void>;
  remove(userId: string, entityId: string, now: Date): Promise<void>;
  reconcile(userId: string, items: CalendarItem[], now: Date): Promise<void>;
}

export type CalendarProviderRouterDeps = {
  providers: Partial<Record<CalendarProvider, ProviderCalendar>>;
  /** The user's `sync.calendar_providers` (none, one or both). */
  chosen(userId: string): Promise<CalendarProvider[]>;
};

/** Fans a push out to the providers the user chose, and to no others (ADR 0015). */
export class CalendarProviderRouter implements ProviderCalendar {
  constructor(private readonly deps: CalendarProviderRouterDeps) {}

  upsert(userId: string, item: CalendarItem, now: Date) {
    return this.fanOut(userId, (p) => p.upsert(userId, item, now));
  }

  remove(userId: string, entityId: string, now: Date) {
    return this.fanOut(userId, (p) => p.remove(userId, entityId, now));
  }

  reconcile(userId: string, items: CalendarItem[], now: Date) {
    return this.fanOut(userId, (p) => p.reconcile(userId, items, now));
  }

  /** Runs every chosen provider; a failure in one never blocks the others. */
  private async fanOut(userId: string, run: (p: ProviderCalendar) => Promise<void>) {
    const chosen = [...new Set(await this.deps.chosen(userId))];
    const targets = chosen.flatMap((name) => {
      const provider = this.deps.providers[name];
      return provider ? [provider] : [];
    });
    const results = await Promise.allSettled(targets.map(run));
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
  }
}
