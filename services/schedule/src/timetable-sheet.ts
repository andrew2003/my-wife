import { IsoDateSchema, TimeOfDaySchema, type CellRejectReason } from "@my-wife/contracts";
import type { PlanStore, PlanTask, PlanWeek } from "./plan";
import { addDays } from "./week-plan";

const WEEK_DAYS = 7;

/** Task fields a user may edit in the sheet; every other cell is computed and locked. */
export const EDITABLE_FIELDS = [
  "title",
  "day",
  "windowStart",
  "windowEnd",
  "estimatedMinutes",
  "definitionOfDone",
] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];
const isEditable = (field: string): field is EditableField =>
  (EDITABLE_FIELDS as readonly string[]).includes(field);

export interface SheetCell {
  field: string;
  value: string | number | null;
  editable: boolean;
}

export interface SheetRow {
  entityId: string;
  task: Omit<PlanTask, "userId">;
  cells: SheetCell[];
}

/** A week is past once its last day is before today in the user's zone. */
export const isPastWeek = (week: PlanWeek, today: string): boolean =>
  addDays(week.firstDay, WEEK_DAYS - 1) < today;

const weekOfDay = (store: PlanStore, userId: string, day: string): PlanWeek | undefined =>
  store
    .allWeeks()
    .find((w) => w.userId === userId && w.firstDay <= day && day <= addDays(w.firstDay, 6));

/** A day is read-only when its week is past, or (without a week) when the day itself is past. */
const dayIsPast = (store: PlanStore, userId: string, day: string, today: string): boolean => {
  const week = weekOfDay(store, userId, day);
  return week ? isPastWeek(week, today) : day < today;
};

const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

export function buildSheet(store: PlanStore, week: PlanWeek, today: string) {
  const readOnly = isPastWeek(week, today);
  const rows: SheetRow[] = [];
  for (let i = 0; i < WEEK_DAYS; i++) {
    for (const t of store.tasksOn(week.userId, addDays(week.firstDay, i))) {
      const { userId: _u, ...task } = t;
      const cell = (field: string, value: string | number | null, editable = false): SheetCell => ({
        field,
        value,
        editable: editable && !readOnly,
      });
      rows.push({
        entityId: t.id,
        task,
        cells: [
          cell("title", t.title, true),
          cell("day", t.day, true),
          cell("windowStart", t.window?.start ?? null, true),
          cell("windowEnd", t.window?.end ?? null, true),
          cell("estimatedMinutes", t.estimatedMinutes, true),
          cell("definitionOfDone", t.definitionOfDone, true),
          cell("state", t.state),
          cell("carriedCount", t.carriedCount),
        ],
      });
    }
  }
  const plannedMinutes = rows.reduce(
    (sum, r) => sum + (r.task.state === "cancelled" ? 0 : r.task.estimatedMinutes),
    0,
  );
  return {
    week: { id: week.id, firstDay: week.firstDay, state: week.state },
    readOnly,
    rows,
    computed: { plannedMinutes },
  };
}

export type EditResult =
  | { status: "applied" }
  | { status: "rejected"; reason: CellRejectReason }
  | { status: "not_found" };

/** Applies one cell edit with the same validation as a web edit; time is a parameter via `today`. */
export function applyCellEdit(
  store: PlanStore,
  userId: string,
  entityId: string,
  field: string,
  value: unknown,
  today: string,
): EditResult {
  const task = store.getTask(userId, entityId);
  if (!task) return { status: "not_found" };
  const reject = (reason: CellRejectReason): EditResult => ({ status: "rejected", reason });
  if (dayIsPast(store, userId, task.day, today)) return reject("past_week");
  if (!isEditable(field)) return reject("locked_cell");

  switch (field) {
    case "title":
      if (typeof value !== "string" || value.trim() === "") return reject("validation_failed");
      task.title = value;
      break;
    case "definitionOfDone":
      if (value !== null && typeof value !== "string") return reject("validation_failed");
      task.definitionOfDone = value === "" ? null : value;
      break;
    case "estimatedMinutes":
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
        return reject("validation_failed");
      task.estimatedMinutes = value;
      break;
    case "day": {
      if (!IsoDateSchema.safeParse(value).success || typeof value !== "string")
        return reject("validation_failed");
      if (dayIsPast(store, userId, value, today)) return reject("past_week");
      task.day = value;
      break;
    }
    case "windowStart":
    case "windowEnd": {
      if (!TimeOfDaySchema.safeParse(value).success || typeof value !== "string")
        return reject("validation_failed");
      const start = field === "windowStart" ? value : (task.window?.start ?? null);
      const end = field === "windowEnd" ? value : (task.window?.end ?? null);
      if (start === null || end === null) {
        // One edge alone cannot form a window; the other must already exist.
        return reject("validation_failed");
      }
      if (minutes(end) <= minutes(start)) return reject("validation_failed");
      task.window = { start, end };
      break;
    }
  }
  return { status: "applied" };
}
