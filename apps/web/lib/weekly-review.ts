import { ScheduleWeekSchema } from "@my-wife/contracts";
import { z } from "zod";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// The review has no contract schema yet, so this local shape mirrors `buildReview` in the
// schedule service. Every figure is computed by code there; the screen only displays it.
const OverranTaskSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  estimatedMinutes: z.number().int().nonnegative(),
  actualMinutes: z.number().int().nonnegative(),
  suggestedMinutes: z.number().int().nonnegative(),
});
const SuggestionSchema = z.object({
  kind: z.literal("adjust_durations"),
  informational: z.literal(true),
  messageKey: z.string(),
  overranCount: z.number().int().nonnegative(),
  tasks: z.array(OverranTaskSchema),
});
const ReviewSchema = z.object({
  weekId: z.string(),
  firstDay: z.string(),
  tasks: z.object({
    planned: z.number().int(),
    completed: z.number().int(),
    carried: z.number().int(),
    open: z.number().int(),
    completedTasks: z.array(z.object({ id: z.string(), title: z.string(), day: z.string() })),
  }),
  estimates: z.object({
    measured: z.number().int(),
    overran: z.number().int(),
    estimatedMinutes: z.number().int(),
    actualMinutes: z.number().int(),
  }),
  suggestions: z.array(SuggestionSchema),
  faults: z.object({
    totalPoints: z.number(),
    items: z.array(
      z.object({
        faultId: z.string(),
        type: z.string(),
        points: z.number(),
        occurredAt: z.string(),
      }),
    ),
  }),
  spending: z.object({
    spentVnd: z.number().int(),
    overspentExcessVnd: z.number().int(),
    overspent: z.array(z.unknown()),
  }),
});

export type Review = z.infer<typeof ReviewSchema>;
export type ReviewSuggestion = z.infer<typeof SuggestionSchema>;

const ReviewEnvelope = z.object({ ok: z.literal(true), data: z.object({ review: ReviewSchema }) });
const WeekEnvelope = z.object({
  ok: z.literal(true),
  data: z.object({ week: ScheduleWeekSchema }),
});

export type ReviewResult =
  | { status: "ready"; review: Review }
  | { status: "not_ready" }
  | { status: "empty" }
  | { status: "error" };

export type AcceptResult = { ok: true } | { ok: false; errorKey: string };

/** Reads the review of a week (the current week when no id is given). */
export async function loadReview(
  weekId: string | undefined,
  doFetch: FetchLike = fetch,
): Promise<ReviewResult> {
  try {
    let id = weekId;
    if (!id) {
      const res = await doFetch("/api/weeks/current", { cache: "no-store" });
      if (res.status === 404) return { status: "empty" };
      if (!res.ok) return { status: "error" };
      const week = WeekEnvelope.safeParse(await res.json());
      if (!week.success) return { status: "error" };
      id = week.data.data.week.id;
    }
    const res = await doFetch(`/api/weeks/${encodeURIComponent(id)}/review`, {
      cache: "no-store",
    });
    if (res.status === 409) return { status: "not_ready" };
    if (res.status === 404) return { status: "empty" };
    if (!res.ok) return { status: "error" };
    const parsed = ReviewEnvelope.safeParse(await res.json());
    return parsed.success
      ? { status: "ready", review: parsed.data.data.review }
      : { status: "error" };
  } catch {
    return { status: "error" };
  }
}

/** Accepts a suggestion: the service applies the suggested durations to the listed tasks. */
export async function acceptSuggestion(
  weekId: string,
  suggestion: ReviewSuggestion,
  doFetch: FetchLike = fetch,
): Promise<AcceptResult> {
  try {
    const res = await doFetch(`/api/weeks/${encodeURIComponent(weekId)}/review/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: suggestion.kind,
        tasks: suggestion.tasks.map((t) => ({ taskId: t.taskId, minutes: t.suggestedMinutes })),
      }),
    });
    return res.ok ? { ok: true } : { ok: false, errorKey: "review.error.accept" };
  } catch {
    return { ok: false, errorKey: "review.error.accept" };
  }
}
