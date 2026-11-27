import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../locales/en.json";
import vi_ from "../locales/vi.json";
import { WeeklyReviewView } from "../components/weekly-review-view";
import { acceptSuggestion, loadReview, type Review } from "../lib/weekly-review";
import { NAV_ITEMS } from "../lib/nav";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const WEEK_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const REVIEW: Review = {
  weekId: WEEK_ID,
  firstDay: "2026-11-23",
  tasks: {
    planned: 5,
    completed: 3,
    carried: 1,
    open: 1,
    completedTasks: [{ id: TASK_ID, title: "Write report", day: "2026-11-24" }],
  },
  estimates: { measured: 2, overran: 2, estimatedMinutes: 120, actualMinutes: 200 },
  suggestions: [
    {
      kind: "adjust_durations",
      informational: true,
      messageKey: "schedule.review.suggest_adjust_durations",
      overranCount: 2,
      tasks: [
        {
          taskId: TASK_ID,
          title: "Write report",
          estimatedMinutes: 60,
          actualMinutes: 100,
          suggestedMinutes: 100,
        },
      ],
    },
  ],
  faults: {
    totalPoints: 3,
    items: [
      {
        faultId: "f1",
        type: "camera_off",
        points: 3,
        occurredAt: "2026-11-25T03:00:00.000Z",
      },
    ],
  },
  spending: { spentVnd: 1500000, overspentExcessVnd: 200000, overspent: [] },
};

describe("loadReview", () => {
  it("returns a ready review for the given week", async () => {
    const doFetch = vi.fn(async (_url: string) =>
      json(200, { ok: true, data: { review: REVIEW } }),
    );
    const res = await loadReview(WEEK_ID, doFetch);
    expect(res.status).toBe("ready");
    expect(doFetch.mock.calls[0]![0]).toBe(`/api/weeks/${WEEK_ID}/review`);
  });
  it("is not_ready on 409", async () => {
    const res = await loadReview(WEEK_ID, async () =>
      json(409, { ok: false, error: { code: "schedule.review_not_ready" } }),
    );
    expect(res.status).toBe("not_ready");
  });
  it("uses the current week when none is given", async () => {
    const doFetch = vi.fn(async (url: string) =>
      url === "/api/weeks/current"
        ? json(200, {
            ok: true,
            data: { week: { id: WEEK_ID, firstDay: "2026-11-23", state: "reviewing" } },
          })
        : json(200, { ok: true, data: { review: REVIEW } }),
    );
    expect((await loadReview(undefined, doFetch)).status).toBe("ready");
  });
  it("is empty when there is no week", async () => {
    expect((await loadReview(undefined, async () => json(404, { ok: false }))).status).toBe(
      "empty",
    );
  });
  it("is error on a failure or a bad body", async () => {
    expect((await loadReview(WEEK_ID, async () => json(500, {}))).status).toBe("error");
    expect((await loadReview(WEEK_ID, async () => json(200, { ok: true, data: {} }))).status).toBe(
      "error",
    );
    expect(
      (
        await loadReview(WEEK_ID, async () => {
          throw new Error("x");
        })
      ).status,
    ).toBe("error");
  });
});

describe("acceptSuggestion", () => {
  it("posts the accepted durations", async () => {
    const doFetch = vi.fn(async () => json(200, { ok: true }));
    const res = await acceptSuggestion(WEEK_ID, REVIEW.suggestions[0]!, doFetch);
    expect(res).toEqual({ ok: true });
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/weeks/${WEEK_ID}/review/accept`);
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "adjust_durations",
      tasks: [{ taskId: TASK_ID, minutes: 100 }],
    });
  });
  it("reports an error key on failure", async () => {
    const res = await acceptSuggestion(WEEK_ID, REVIEW.suggestions[0]!, async () => json(404, {}));
    expect(res).toEqual({ ok: false, errorKey: "review.error.accept" });
  });
});

const base = {
  status: "ready" as const,
  review: REVIEW,
  accepted: [] as string[],
  busy: false,
  errorKey: null,
  onAccept: () => {},
  onRetry: () => {},
};
const render = (over: Record<string, unknown>, locale: "en" | "vi" = "en") =>
  renderToStaticMarkup(createElement(WeeklyReviewView, { locale, ...base, ...over } as never));

describe("WeeklyReviewView", () => {
  it("shows tasks, faults, spend, suggestions and accept actions", () => {
    const html = render({});
    expect(html).toContain(en["review.tasks.title"]);
    expect(html).toContain("Write report");
    expect(html).toContain(en["review.faults.title"]);
    expect(html).toContain(en["fault.type.camera_off"]);
    expect(html).toContain(en["review.spend.title"]);
    expect(html).toContain("1,500,000");
    expect(html).toContain(en["review.suggestions.title"]);
    expect(html).toContain(en["review.accept"]);
  });
  it("renders in Vietnamese", () => {
    expect(render({}, "vi")).toContain(vi_["review.accept"]);
  });
  it("hides the accept button once accepted", () => {
    expect(render({ accepted: ["adjust_durations"] })).not.toContain(`>${en["review.accept"]}<`);
  });
  it("shows empty suggestions text", () => {
    expect(render({ review: { ...REVIEW, suggestions: [] } })).toContain(
      en["review.suggestions.none"],
    );
  });
  it("shows loading, empty, not ready and error states", () => {
    expect(render({ status: "loading", review: null })).toContain(en["review.loading"]);
    expect(render({ status: "empty", review: null })).toContain(en["review.empty"]);
    expect(render({ status: "not_ready", review: null })).toContain(en["review.not_ready"]);
    const err = render({ status: "error", review: null });
    expect(err).toContain(en["review.error"]);
    expect(err).toContain(en["review.retry"]);
  });
  it("has the same keys in both locales", () => {
    const keys = (o: Record<string, string>) =>
      Object.keys(o).filter((k) => k.startsWith("review."));
    expect(keys(vi_).sort()).toEqual(keys(en).sort());
    expect(keys(en).length).toBeGreaterThan(10);
  });
  it("is reachable from the navigation", () => {
    expect(NAV_ITEMS.some((i) => i.href === "/schedule/review")).toBe(true);
  });
});
