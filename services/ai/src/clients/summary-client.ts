import { BudgetOverviewResponseSchema, ListPenaltiesResponseSchema } from "@my-wife/contracts";
import { getJson, InternalCallError } from "./http";
import { createRulesClient } from "./rules-client";

export interface SummaryUrls {
  budget: string;
  schedule: string;
  rules: string;
}

const FAULT_PAGE = 100;

/** Read routes behind `/summary`, `/today`, `/week` and `/budget`. Nothing here writes. */
export interface SummaryClient {
  schedule(
    userId: string,
  ): Promise<{ firstDay: string; tasks: { day: string; state: string }[] } | null>;
  budget(userId: string): Promise<{
    weekIndex: number;
    categories: { weeklyLimitVnd: number; spentVnd: number; remainingVnd: number }[];
    anomalies: number;
  } | null>;
  faults(userId: string): Promise<{ occurredAt: string; points: number; status: string }[]>;
  penalties(userId: string): Promise<{ suspendedTotalVnd: number }>;
}

/** A missing week or cycle is an empty answer, not an error. */
async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof InternalCallError && error.status === 404) return null;
    throw error;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Reads `{ week: { firstDay }, rows: [{ task: { day, state } }] }` of the timetable sheet. */
function readSheet(data: unknown): { firstDay: string; tasks: { day: string; state: string }[] } {
  const week = isRecord(data) && isRecord(data.week) ? data.week : null;
  const rows = isRecord(data) && Array.isArray(data.rows) ? data.rows : null;
  if (!week || typeof week.firstDay !== "string" || !rows)
    throw new InternalCallError("schedule", 200);
  const tasks = rows.map((row) => {
    const task = isRecord(row) && isRecord(row.task) ? row.task : null;
    if (!task || typeof task.day !== "string" || typeof task.state !== "string")
      throw new InternalCallError("schedule", 200);
    return { day: task.day, state: task.state };
  });
  return { firstDay: week.firstDay, tasks };
}

export function createSummaryClient(
  urls: SummaryUrls,
  fetchFn: typeof fetch = fetch,
): SummaryClient {
  const rules = createRulesClient(urls.rules, fetchFn);
  return {
    schedule: (userId) =>
      orNull(async () =>
        readSheet(await getJson(fetchFn, "schedule", `${urls.schedule}/timetable-sheet`, userId)),
      ),
    budget: (userId) =>
      orNull(async () => {
        const data = await getJson(fetchFn, "budget", `${urls.budget}/budget/overview`, userId);
        const parsed = BudgetOverviewResponseSchema.parse({ ok: true, data });
        if (!parsed.ok) throw new InternalCallError("budget", 200);
        return {
          weekIndex: parsed.data.weekIndex,
          categories: parsed.data.categories,
          anomalies: parsed.data.anomalies.length,
        };
      }),
    faults: (userId) => rules.latestFaults(userId, FAULT_PAGE),
    async penalties(userId) {
      const data = await getJson(fetchFn, "rules", `${urls.rules}/penalties`, userId);
      const parsed = ListPenaltiesResponseSchema.parse({ ok: true, data });
      if (!parsed.ok) throw new InternalCallError("rules", 200);
      return { suspendedTotalVnd: parsed.data.suspendedTotalVnd };
    },
  };
}
