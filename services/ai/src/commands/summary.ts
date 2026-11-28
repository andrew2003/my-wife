import type { Locale, MessageRef } from "@my-wife/contracts";
import { renderMessage } from "../i18n";
import type { CaptureOutcome } from "./capture";

/**
 * What the summary commands read. Every port wraps an existing read route (schedule timetable
 * sheet, budget overview, rules faults and penalties). Nothing here writes.
 */
export interface SummaryPorts {
  timeZone(userId: string): Promise<string>;
  /** The current week's tasks; null when the user has no week yet. */
  schedule(
    userId: string,
  ): Promise<{ firstDay: string; tasks: { day: string; state: string }[] } | null>;
  /** The current budget week; null when the user has no cycle yet. */
  budget(userId: string): Promise<{
    weekIndex: number;
    categories: { weeklyLimitVnd: number; spentVnd: number; remainingVnd: number }[];
    anomalies: number;
  } | null>;
  faults(userId: string): Promise<{ occurredAt: string; points: number; status: string }[]>;
  penalties(userId: string): Promise<{ suspendedTotalVnd: number }>;
}

export type SummaryScope = "summary" | "today" | "week" | "budget";

export const SUMMARY_SCOPES: readonly SummaryScope[] = ["summary", "today", "week", "budget"];

/** Fault statuses whose points still stand; waived, overturned and expired ones do not. */
const STANDING_FAULTS = new Set(["pending_reason", "recorded", "appealed", "upheld"]);

export interface SummaryContext {
  userId: string;
  locale: Locale;
  scope: SummaryScope;
  summary: SummaryPorts | undefined;
  now: Date;
  /** The command name and its description, for the model context. */
  command: { name: string; description: string };
  /** Runs the chat model; absent when no model is wired. */
  runPrompt?: (text: string) => Promise<MessageRef | { text: string }>;
}

const localDate = (at: Date, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);

const vnd = (amount: number): string => amount.toLocaleString("en-US");

const part = (locale: Locale, key: string, params: MessageRef["params"]): string =>
  renderMessage({ key: `commands.summary.${key}`, params }, locale);

async function attempt<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    // Never echo the error: a failed read only drops that part of the summary.
    return null;
  }
}

/** Counts done and planned tasks; cancelled tasks are not part of the plan. */
function countTasks(tasks: { state: string }[]): { done: number; total: number } {
  const live = tasks.filter((t) => t.state !== "cancelled");
  return { done: live.filter((t) => t.state === "done").length, total: live.length };
}

/** Facts are built by code from read routes; the model only phrases them. */
async function buildFacts(ctx: SummaryContext, ports: SummaryPorts): Promise<string[]> {
  const { userId, locale, scope, now } = ctx;
  const wants = (...scopes: SummaryScope[]) => scopes.includes(scope);
  const lines: string[] = [];
  const zone = await attempt(() => ports.timeZone(userId));
  if (zone === null) return lines;
  const today = localDate(now, zone);

  const week = wants("summary", "today", "week")
    ? await attempt(() => ports.schedule(userId))
    : null;
  if (week && wants("summary", "today")) {
    const t = countTasks(week.tasks.filter((x) => x.day === today));
    lines.push(part(locale, "tasks_today", { done: t.done, total: t.total }));
  }
  if (week && wants("summary", "week")) {
    const t = countTasks(week.tasks);
    lines.push(part(locale, "tasks_week", { done: t.done, total: t.total }));
  }
  if (wants("summary", "week") && week) {
    const faults = await attempt(() => ports.faults(userId));
    if (faults) {
      const points = faults
        .filter(
          (f) =>
            STANDING_FAULTS.has(f.status) &&
            localDate(new Date(f.occurredAt), zone) >= week.firstDay,
        )
        .reduce((sum, f) => sum + f.points, 0);
      lines.push(part(locale, "faults", { points }));
    }
  }
  if (wants("summary", "budget")) {
    const budget = await attempt(() => ports.budget(userId));
    if (budget) {
      const limit = budget.categories.reduce((s, c) => s + c.weeklyLimitVnd, 0);
      const spent = budget.categories.reduce((s, c) => s + c.spentVnd, 0);
      const remaining = budget.categories.reduce((s, c) => s + c.remainingVnd, 0);
      lines.push(
        part(locale, "budget", {
          week: budget.weekIndex,
          limit: vnd(limit),
          spent: vnd(spent),
          remaining: vnd(remaining),
          over: budget.categories.filter((c) => c.remainingVnd < 0).length,
          anomalies: budget.anomalies,
        }),
      );
    }
    const penalties = await attempt(() => ports.penalties(userId));
    if (penalties)
      lines.push(part(locale, "penalties", { amount: vnd(penalties.suspendedTotalVnd) }));
  }
  return lines;
}

const digitRuns = (text: string): string[] => text.match(/\d+/g) ?? [];

/** A model reply may only repeat numbers that the facts contain. */
function numbersMatch(reply: string, facts: string): boolean {
  const known = new Set(digitRuns(facts));
  return digitRuns(reply).every((n) => known.has(n));
}

export async function runSummary(ctx: SummaryContext): Promise<CaptureOutcome> {
  if (!ctx.summary)
    return {
      status: "refused",
      reply: { key: "commands.not_available", params: {} },
      reason: "not_allowed",
    };
  const lines = await buildFacts(ctx, ctx.summary);
  if (lines.length === 0)
    return {
      status: "refused",
      reply: { key: "commands.summary.unavailable", params: {} },
      reason: "not_allowed",
    };
  const facts = lines.join("\n");
  const plain: CaptureOutcome = {
    status: "ok",
    reply: { key: "commands.summary.reply", params: { facts } },
  };
  if (!ctx.runPrompt) return plain;
  try {
    const prompt = part(ctx.locale, "instruction", { facts });
    const answer = await ctx.runPrompt(prompt);
    if ("text" in answer && answer.text.trim() !== "" && numbersMatch(answer.text, facts))
      return {
        status: "ok",
        reply: { key: "commands.prompt_reply", params: { text: answer.text } },
      };
  } catch {
    // The model is optional here: the facts alone are a complete answer.
  }
  return plain;
}
