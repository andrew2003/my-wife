import type { AiToolCall } from "@my-wife/contracts";

/** Tools that take effect without a confirm button (spec 30 section 2). */
export const QUICK_CAPTURE_TOOLS = ["create_task", "record_cash_expense"] as const;

export function isQuickCapture(
  call: AiToolCall,
): call is Extract<AiToolCall, { tool: (typeof QUICK_CAPTURE_TOOLS)[number] }> {
  return (QUICK_CAPTURE_TOOLS as readonly string[]).includes(call.tool);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar date of `now` in `timeZone`, as `YYYY-MM-DD`. */
function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function addDays(isoDay: string, days: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Code decides the day: the model may propose `today`, `tomorrow` or an ISO date. Anything else
 * (or an impossible date) is dropped rather than guessed. `now` and the zone are parameters.
 */
export function resolveDay(
  proposed: string | undefined,
  now: Date,
  timeZone: string,
): string | undefined {
  if (!proposed) return undefined;
  const value = proposed.trim().toLowerCase();
  let today: string;
  try {
    today = localDate(now, timeZone);
  } catch {
    return undefined;
  }
  if (value === "today") return today;
  if (value === "tomorrow") return addDays(today, 1);
  if (!ISO_DAY.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? undefined
    : value;
}
