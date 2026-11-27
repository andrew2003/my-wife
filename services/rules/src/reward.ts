import {
  EVENT_SCHEMA_VERSION,
  SETTINGS,
  type EventEnvelope,
  type EventPayload,
} from "@my-wife/contracts";
import type { FaultStore } from "./fault";
import { weekWindow } from "./weekly-fault-penalty";

/** Days in one closed week; the streak is counted in whole weeks. */
const DAYS_PER_WEEK = 7;
const DAY_MS = 24 * 3_600_000;

export type RewardSettings = {
  /** `reward.clean_streak_days`. */
  cleanStreakDays: number;
  /** `reward.unlock_amount_vnd`. */
  unlockAmountVnd: number;
  /** Where the reward goes: a `want` category id, or null for the penalty fund. */
  categoryId: string | null;
};

export const DEFAULT_REWARD_SETTINGS: RewardSettings = {
  cleanStreakDays: SETTINGS["reward.clean_streak_days"].default,
  unlockAmountVnd: SETTINGS["reward.unlock_amount_vnd"].default,
  categoryId: null,
};

/**
 * Pure rule. A clean week extends the streak by one week; a week with recorded points resets
 * it. The reward unlocks once the streak covers `cleanStreakDays`, and the streak then starts
 * again so the same weeks never pay twice.
 */
export function evaluateReward(input: {
  clean: boolean;
  priorCleanWeeks: number;
  settings: Pick<RewardSettings, "cleanStreakDays">;
}): { unlock: boolean; cleanWeeks: number } {
  if (!input.clean) return { unlock: false, cleanWeeks: 0 };
  const weeks = input.priorCleanWeeks + 1;
  if (weeks * DAYS_PER_WEEK >= input.settings.cleanStreakDays) {
    return { unlock: true, cleanWeeks: 0 };
  }
  return { unlock: false, cleanWeeks: weeks };
}

export type RewardWeekRecord = {
  weekId: string;
  firstDay: string;
  clean: boolean;
  unlocked: boolean;
  /** Clean weeks in the running streak after this week. */
  cleanWeeks: number;
  /** The reward event as it goes out; null when nothing was unlocked. */
  event: EventEnvelope | null;
  published: boolean;
};

export interface RewardStore {
  find(userId: string, weekId: string): RewardWeekRecord | undefined;
  /** Newest stored week that starts before `firstDay`. */
  previous(userId: string, firstDay: string): RewardWeekRecord | undefined;
  /** Synchronously inserts unless (user, weekId) exists; returns whether it did. */
  insertOnce(userId: string, record: RewardWeekRecord): boolean;
  markPublished(userId: string, weekId: string): void;
}

export class InMemoryRewardStore implements RewardStore {
  private readonly rows = new Map<string, RewardWeekRecord[]>();
  find(userId: string, weekId: string) {
    return this.rows.get(userId)?.find((r) => r.weekId === weekId);
  }
  previous(userId: string, firstDay: string) {
    return (this.rows.get(userId) ?? [])
      .filter((r) => r.firstDay < firstDay)
      .sort((a, b) => (a.firstDay < b.firstDay ? -1 : 1))
      .at(-1);
  }
  insertOnce(userId: string, record: RewardWeekRecord) {
    if (this.find(userId, record.weekId)) return false;
    const list = this.rows.get(userId) ?? [];
    list.push(Object.freeze(record));
    this.rows.set(userId, list);
    return true;
  }
  markPublished(userId: string, weekId: string) {
    const list = this.rows.get(userId) ?? [];
    const i = list.findIndex((r) => r.weekId === weekId);
    if (i >= 0) list[i] = Object.freeze({ ...list[i]!, published: true });
  }
}

export type RewardResult = {
  weekId: string;
  clean: boolean;
  unlocked: boolean;
  duplicate: boolean;
};

export type RewardServiceDeps = {
  faultStore: Pick<FaultStore, "list">;
  store: RewardStore;
  /** Reward settings in force for the user; registry defaults when absent. */
  readSettings?: (userId: string, at: Date) => Promise<RewardSettings>;
  publish?: (event: EventEnvelope) => void | Promise<void>;
  onPublishError?: (err: unknown) => void;
};

/** Every method takes `now`; nothing here reads the system clock. */
export function createRewardService(deps: RewardServiceDeps) {
  const readSettings = deps.readSettings ?? (async () => DEFAULT_REWARD_SETTINGS);

  async function publishOwed(userId: string, record: RewardWeekRecord) {
    if (!record.event || record.published) return;
    try {
      await deps.publish?.(record.event);
      deps.store.markPublished(userId, record.weekId);
    } catch (err) {
      deps.onPublishError?.(err);
    }
  }

  return {
    /**
     * Consumes `week.closed`: a week with no recorded fault points is clean. Once the clean
     * streak covers `reward.clean_streak_days` it emits `reward.unlocked` with
     * `reward.unlock_amount_vnd`. Once per (user, week); a redelivery only retries a
     * publish that failed. The reward only unlocks money: the bot never moves it.
     */
    async onWeekClosed(event: EventEnvelope, now: Date): Promise<RewardResult> {
      const { userId } = event;
      const p = event.payload as EventPayload<"week.closed">;
      const existing = deps.store.find(userId, p.weekId);
      if (existing) {
        await publishOwed(userId, existing);
        return {
          weekId: p.weekId,
          clean: existing.clean,
          unlocked: existing.unlocked,
          duplicate: true,
        };
      }
      const settings = await readSettings(userId, now);
      const { from, to } = weekWindow(p.firstDay);
      const clean = !deps.faultStore.list(userId).some((f) => {
        const t = Date.parse(f.occurredAt);
        return f.status === "recorded" && f.points > 0 && t >= from.getTime() && t < to.getTime();
      });
      const prev = deps.store.previous(userId, p.firstDay);
      // Only the directly preceding week continues a streak; a skipped week breaks it.
      const contiguous =
        prev !== undefined &&
        Date.parse(`${prev.firstDay}T00:00:00.000Z`) + DAYS_PER_WEEK * DAY_MS === from.getTime();
      const { unlock, cleanWeeks } = evaluateReward({
        clean,
        priorCleanWeeks: contiguous ? prev.cleanWeeks : 0,
        settings,
      });
      const rewardEvent = unlock
        ? ({
            id: `reward-unlocked-${p.weekId}`,
            type: "reward.unlocked",
            userId,
            occurredAt: now.toISOString(),
            schemaVersion: EVENT_SCHEMA_VERSION,
            payload: {
              amountVnd: settings.unlockAmountVnd,
              categoryId: settings.categoryId,
            } satisfies EventPayload<"reward.unlocked">,
          } as EventEnvelope)
        : null;
      const record: RewardWeekRecord = {
        weekId: p.weekId,
        firstDay: p.firstDay,
        clean,
        unlocked: unlock,
        cleanWeeks,
        event: rewardEvent,
        published: false,
      };
      const inserted = deps.store.insertOnce(userId, record);
      await publishOwed(userId, deps.store.find(userId, p.weekId)!);
      return { weekId: p.weekId, clean, unlocked: unlock, duplicate: !inserted };
    },
  };
}

export type RewardService = ReturnType<typeof createRewardService>;
