import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../locales/en.json";
import vi_ from "../locales/vi.json";
import { WeekPlannerView } from "../components/week-planner-view";
import { applyTemplate, approveWeek, groupByDay, loadPlanner, weekDays } from "../lib/week-planner";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const WEEK = { id: "11111111-1111-4111-8111-111111111111", firstDay: "2026-11-30", state: "draft" };
const task = (over: Record<string, unknown>) => ({
  id: "22222222-2222-4222-8222-222222222222",
  title: "Write report",
  day: "2026-11-30",
  window: null,
  estimatedMinutes: 90,
  energyLevel: null,
  definitionOfDone: null,
  monitoringProfile: "none",
  kind: "desk",
  state: "planned",
  carriedCount: 0,
  parentRecurrenceId: null,
  ...over,
});
const TEMPLATES = [{ id: "33333333-3333-4333-8333-333333333333", name: "Student week", tasks: [] }];

describe("week helpers", () => {
  it("lists the seven UTC days from the first day", () => {
    const days = weekDays("2026-11-30");
    expect(days).toHaveLength(7);
    expect(days[0]).toBe("2026-11-30");
    expect(days[6]).toBe("2026-12-06");
  });
  it("groups tasks by day and keeps empty days", () => {
    const g = groupByDay(weekDays("2026-11-30"), [
      task({}),
      task({ id: "x", day: "2026-12-02" }),
    ] as never);
    expect(g["2026-11-30"]).toHaveLength(1);
    expect(g["2026-12-01"]).toEqual([]);
    expect(g["2026-12-02"]).toHaveLength(1);
  });
});

describe("loadPlanner", () => {
  it("loads the week, templates and the tasks of its seven days", async () => {
    const doFetch = vi.fn(async (url: string) => {
      if (url.startsWith("/api/weeks/current"))
        return json(200, { ok: true, data: { week: WEEK } });
      if (url.startsWith("/api/templates"))
        return json(200, { ok: true, data: { templates: TEMPLATES } });
      const date = new URL(url, "http://x").searchParams.get("date");
      return json(200, {
        ok: true,
        data: { date, tasks: date === "2026-11-30" ? [task({})] : [] },
      });
    });
    const res = await loadPlanner(doFetch);
    expect(res.status).toBe("ready");
    if (res.status !== "ready") return;
    expect(res.week.id).toBe(WEEK.id);
    expect(res.templates).toHaveLength(1);
    expect(res.tasks).toHaveLength(1);
  });
  it("reports empty when there is no week yet", async () => {
    const doFetch = async () =>
      json(404, { ok: false, error: { code: "schedule.week_not_found" } });
    expect((await loadPlanner(doFetch)).status).toBe("empty");
  });
  it("reports an error when the service fails", async () => {
    expect((await loadPlanner(async () => json(500, {}))).status).toBe("error");
    expect(
      (
        await loadPlanner(async () => {
          throw new Error("x");
        })
      ).status,
    ).toBe("error");
  });
});

describe("applyTemplate and approveWeek", () => {
  it("posts the template id and returns the load", async () => {
    const doFetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      json(200, {
        ok: true,
        data: {
          week: WEEK,
          recurringTasks: [],
          overloaded: true,
          overloadMinutes: 120,
          plannedMinutes: 5000,
          availableMinutes: 4880,
        },
      }),
    );
    const res = await applyTemplate(WEEK.id, TEMPLATES[0]!.id, doFetch);
    expect(res).toEqual({ ok: true, overloaded: true, overloadMinutes: 120 });
    const [url, init] = doFetch.mock.calls[0]!;
    expect(url).toBe(`/api/weeks/${WEEK.id}/plan`);
    expect(JSON.parse(String(init?.body))).toEqual({ templateId: TEMPLATES[0]!.id });
  });
  it("maps an already applied template to its own error", async () => {
    const res = await applyTemplate(WEEK.id, "t", async () =>
      json(409, { ok: false, error: { code: "schedule.template_already_applied" } }),
    );
    expect(res).toEqual({ ok: false, errorKey: "weekplan.error.already_applied" });
  });
  it("approves the week", async () => {
    const ok = async () => json(200, { ok: true, data: { week: { ...WEEK, state: "planned" } } });
    expect(await approveWeek(WEEK.id, ok)).toEqual({ ok: true });
    expect(await approveWeek(WEEK.id, async () => json(409, { ok: false }))).toEqual({
      ok: false,
      errorKey: "weekplan.error.approve",
    });
  });
});

const view = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(WeekPlannerView, {
      locale: "en",
      status: "ready",
      week: WEEK,
      templates: TEMPLATES,
      tasks: [task({}), task({ id: "a", title: "Gym", day: "2026-12-01", estimatedMinutes: 60 })],
      load: null,
      selectedTemplateId: "",
      busy: false,
      errorKey: null,
      onSelectTemplate: () => {},
      onApply: () => {},
      onApprove: () => {},
      onRetry: () => {},
      ...props,
    } as never),
  );

describe("WeekPlannerView", () => {
  it("shows the tasks of the week board by day", () => {
    const html = view({});
    expect(html).toContain("Write report");
    expect(html).toContain("Gym");
    expect(html).toContain("Student week");
    expect(html).not.toContain(en["weekplan.overload.title"]);
  });
  it("shows the overload banner with the minutes over", () => {
    const html = view({ load: { overloaded: true, overloadMinutes: 150 } });
    expect(html).toContain('role="alert"');
    expect(html).toContain(en["weekplan.overload.title"]);
    expect(html).toContain("2 h 30 min");
  });
  it("shows no banner when the load fits", () => {
    const html = view({ load: { overloaded: false, overloadMinutes: 0 } });
    expect(html).not.toContain(en["weekplan.overload.title"]);
    expect(html).toContain(en["weekplan.load_ok"]);
  });
  it("disables apply until a template is chosen and hides approve outside draft", () => {
    expect(view({})).toMatch(/<button[^>]*disabled[^>]*>Apply template/);
    const planned = view({ week: { ...WEEK, state: "planned" } });
    expect(planned).toContain(en["weekplan.state.planned"]);
    expect(planned).not.toContain(">Approve plan<");
  });
  it("has loading, empty and error states and a no-templates note", () => {
    expect(view({ status: "loading" })).toContain(en["weekplan.loading"]);
    expect(view({ status: "empty" })).toContain(en["weekplan.empty"]);
    const err = view({ status: "error" });
    expect(err).toContain(en["weekplan.error"]);
    expect(err).toContain(en["weekplan.retry"]);
    expect(view({ templates: [] })).toContain(en["weekplan.no_templates"]);
  });
  it("renders Vietnamese from the locale file", () => {
    expect(view({ locale: "vi" })).toContain(vi_["weekplan.apply"]);
  });
});

describe("locale keys", () => {
  it("every weekplan key exists in vi and en", () => {
    const keys = Object.keys(en).filter((k) => k.startsWith("weekplan."));
    expect(keys.length).toBeGreaterThan(10);
    for (const k of keys) expect(vi_).toHaveProperty(k);
  });
});
