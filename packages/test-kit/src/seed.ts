import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  SETTINGS,
  type BankAccount,
  type BudgetCategory,
  type BudgetCycle,
  type PlannedItem,
  type Task,
} from "@my-wife/contracts";
import { DAY_MS } from "./clock";

/** Demo time zone offset; the user's time zone is a setting, the seed only needs a default. */
const DEMO_UTC_OFFSET_HOURS = 7;

export interface SeedData {
  user: {
    id: string;
    email: string;
    state: "active";
    role: "user";
    locale: "vi" | "en";
    lastSeenAt: string | null;
  };
  invitation: {
    id: string;
    email: string;
    expiresAt: string;
    usedAt: string | null;
    revokedAt: string | null;
  };
  bankAccounts: BankAccount[];
  categories: BudgetCategory[];
  plannedItems: PlannedItem[];
  cycle: BudgetCycle;
  scheduleWeek: { id: string; firstDay: string; state: "active" };
  tasks: Task[];
}

function localDate(ms: number): string {
  return new Date(ms + DEMO_UTC_OFFSET_HOURS * 3_600_000).toISOString().slice(0, 10);
}

/** Monday (week start default) of the week containing `now`, as a local date. */
function weekStart(now: Date): { date: string; ms: number } {
  const local = new Date(now.getTime() + DEMO_UTC_OFFSET_HOURS * 3_600_000);
  const sinceMonday = (local.getUTCDay() + 6) % 7;
  const ms =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) -
    sinceMonday * DAY_MS;
  return { date: new Date(ms).toISOString().slice(0, 10), ms };
}

/** Builds a deterministic demo data set from `now`. Uses contract shapes only. */
export function buildSeed(now: Date, locale: "vi" | "en" = "vi"): SeedData {
  const week = weekStart(now);
  const day = (offset: number) => localDate(week.ms + offset * DAY_MS);
  const account = (
    id: string,
    name: string,
    code: string,
    kind: BankAccount["kind"],
  ): BankAccount => ({
    id,
    name,
    code,
    kind,
    emailNotificationsConfirmed: true,
  });
  const cat = (
    id: string,
    name: string,
    shortCode: string,
    priority: BudgetCategory["priority"],
    kind: BudgetCategory["kind"],
    cycleLimitVnd: number,
    wantOrder: number | null = null,
  ): BudgetCategory => ({
    id,
    name,
    shortCode,
    priority,
    kind,
    countsTowardSurplus: priority !== "fund",
    bankAccountId: "seed-account-spending",
    cycleLimitVnd,
    wantOrder,
  });
  const planned = (
    categoryId: string,
    number: number,
    amountVnd: number,
    code: string,
  ): PlannedItem => ({
    id: `seed-planned-${code.toLowerCase()}`,
    categoryId,
    number,
    amountVnd,
    transferCode: code,
    status: "planned",
  });
  const task = (
    n: number,
    title: string,
    offset: number,
    window: Task["window"],
    minutes: number,
    monitoringProfile: Task["monitoringProfile"],
    kind: Task["kind"],
  ): Task => ({
    id: `seed-task-${n}`,
    title,
    day: day(offset),
    window,
    estimatedMinutes: minutes,
    energyLevel: null,
    definitionOfDone: null,
    monitoringProfile,
    kind,
    state: "planned",
    carriedCount: 0,
    parentRecurrenceId: null,
  });

  const cycleWeeks = SETTINGS["budget.cycle_weeks"].default;
  const openedAt = new Date(week.ms - DEMO_UTC_OFFSET_HOURS * 3_600_000).toISOString();
  return {
    user: {
      id: "seed-user-demo",
      email: "demo@example.test",
      state: "active",
      role: "user",
      locale,
      lastSeenAt: null,
    },
    invitation: {
      id: "seed-invitation-demo",
      email: "demo@example.test",
      expiresAt: new Date(week.ms + 21 * DAY_MS).toISOString(),
      usedAt: null,
      revokedAt: null,
    },
    bankAccounts: [
      account("seed-account-spending", "Demo spending account", "SPEND", "spending"),
      account("seed-account-penalty", "Demo penalty savings", "PEN", "penalty_savings"),
    ],
    categories: [
      cat("seed-cat-rent", "Rent", "RENT", "need", "fixed", 3_000_000),
      cat("seed-cat-food", "Food", "FOOD", "need", "variable", 2_400_000),
      cat("seed-cat-study", "Courses", "STUDY", "should", "variable", 800_000),
      cat("seed-cat-coffee", "Coffee and fun", "FUN", "want", "variable", 600_000, 1),
      cat("seed-cat-save", "Emergency fund", "SAVE", "fund", "fixed", 500_000),
    ],
    plannedItems: [
      planned("seed-cat-rent", 1, 3_000_000, "RENT1"),
      planned("seed-cat-study", 1, 800_000, "STUDY1"),
      planned("seed-cat-save", 1, 500_000, "SAVE1"),
    ],
    cycle: {
      id: "seed-cycle-1",
      sequence: 1,
      weeks: cycleWeeks,
      firstDay: week.date,
      state: "running",
      openedAt,
      closedAt: null,
      commitmentId: null,
    },
    scheduleWeek: { id: "seed-week-1", firstDay: week.date, state: "active" },
    tasks: [
      task(
        1,
        "Write the project report",
        0,
        { start: "09:00", end: "11:00" },
        120,
        "camera",
        "desk",
      ),
      task(
        2,
        "Read two chapters",
        1,
        { start: "14:00", end: "15:30" },
        90,
        "checklist_only",
        "desk",
      ),
      task(3, "Morning run", 2, { start: "06:00", end: "06:45" }, 45, "offline_checkin", "offline"),
      task(4, "Pay the course fee", 3, null, 15, "none", "money"),
      task(
        5,
        "Weekly review prep",
        6,
        { start: "19:00", end: "19:30" },
        30,
        "checklist_only",
        "desk",
      ),
    ],
  };
}

export interface SeedStore {
  get(collection: string, id: string): Promise<unknown | undefined>;
  upsert(collection: string, id: string, value: unknown): Promise<void>;
}

type Collections = Record<string, Record<string, unknown>>;

export class MemorySeedStore implements SeedStore {
  protected data: Collections = {};
  async get(collection: string, id: string) {
    return this.data[collection]?.[id];
  }
  async upsert(collection: string, id: string, value: unknown) {
    (this.data[collection] ??= {})[id] = value;
  }
  snapshot(): Collections {
    return structuredClone(this.data);
  }
}

/** JSON file store for the demo; stands in for the service databases until they exist. */
export class FileSeedStore extends MemorySeedStore {
  constructor(private readonly file: string) {
    super();
    if (existsSync(file)) this.data = JSON.parse(readFileSync(file, "utf8")) as Collections;
  }
  override async upsert(collection: string, id: string, value: unknown) {
    const before = JSON.stringify(this.data[collection]?.[id]);
    await super.upsert(collection, id, value);
    if (before !== JSON.stringify(value)) this.flush();
  }
  private flush() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`);
    renameSync(tmp, this.file);
  }
}

export interface ApplyResult {
  created: number;
  updated: number;
  unchanged: number;
}

/** Writes the seed with upsert by stable id, so running it again changes nothing. */
export async function applySeed(store: SeedStore, seed: SeedData): Promise<ApplyResult> {
  const result: ApplyResult = { created: 0, updated: 0, unchanged: 0 };
  const put = async (collection: string, id: string, value: unknown) => {
    const existing = await store.get(collection, id);
    if (existing === undefined) result.created++;
    else if (JSON.stringify(existing) === JSON.stringify(value)) {
      result.unchanged++;
      return;
    } else result.updated++;
    await store.upsert(collection, id, value);
  };
  await put("user", seed.user.id, seed.user);
  await put("invitation", seed.invitation.id, seed.invitation);
  for (const r of seed.bankAccounts) await put("bank_account", r.id, r);
  for (const r of seed.categories) await put("category", r.id, r);
  for (const r of seed.plannedItems) await put("planned_item", r.id, r);
  await put("cycle", seed.cycle.id, seed.cycle);
  await put("schedule_week", seed.scheduleWeek.id, seed.scheduleWeek);
  for (const r of seed.tasks) await put("task", r.id, r);
  return result;
}
