import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi as vitest } from "vitest";
import type { Task } from "@my-wife/contracts";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { DashboardView, type DashboardViewProps } from "../components/dashboard-view";
import { completeTask, dashboardProgress, taskChipState } from "../lib/dashboard";
import { defaultExpressionSettings } from "../lib/expressions";

const base: Task = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Write report",
  day: "2026-11-26",
  window: { start: "09:00", end: "10:00" },
  estimatedMinutes: 30,
  energyLevel: null,
  definitionOfDone: null,
  monitoringProfile: "none",
  kind: "desk",
  state: "planned",
  carriedCount: 0,
  parentRecurrenceId: null,
};
const second: Task = { ...base, id: "22222222-2222-4222-8222-222222222222", title: "Call bank" };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("taskChipState", () => {
  const cases: [string, Partial<Task>, string, string, string][] = [
    ["done task", { state: "done" }, "2026-11-26", "08:00", "done"],
    ["planned before its window ends", {}, "2026-11-26", "09:30", "upcoming"],
    ["planned after its window ended", {}, "2026-11-26", "10:01", "not_done"],
    ["planned from an earlier day", { day: "2026-11-25" }, "2026-11-26", "07:00", "not_done"],
    ["planned with no window", { window: null }, "2026-11-26", "23:00", "upcoming"],
    ["skipped task", { state: "skipped" }, "2026-11-26", "08:00", "not_done"],
  ];
  it.each(cases)("%s", (_n, patch, today, time, expected) => {
    expect(taskChipState({ ...base, ...patch }, today, time)).toBe(expected);
  });
});

describe("dashboardProgress", () => {
  it("is the share of done tasks, ignoring cancelled ones", () => {
    expect(dashboardProgress([])).toEqual({ done: 0, total: 0, percent: 0 });
    const tasks = [
      { ...base, state: "done" as const },
      second,
      { ...base, state: "cancelled" as const },
    ];
    expect(dashboardProgress(tasks)).toEqual({ done: 1, total: 2, percent: 50 });
  });
});

describe("completeTask", () => {
  it("returns the saved list and a reaction with the new counts", async () => {
    const saved = { ...base, state: "done" as const };
    const f = vitest.fn(async () => json(200, { ok: true, data: { task: saved } }));
    const res = await completeTask(base.id, [base, second], f as never);
    expect(res.ok).toBe(true);
    expect(res.tasks).toEqual([saved, second]);
    expect(res.reaction).toEqual({
      key: "dashboard.reaction.task_done",
      params: { title: "Write report", done: 1, total: 2 },
    });
  });

  it("gives no reaction and keeps the list when saving fails", async () => {
    const res = await completeTask(base.id, [base], (async () => json(500, {})) as never);
    expect(res.ok).toBe(false);
    expect(res.tasks).toEqual([base]);
    expect(res.reaction).toBeNull();
  });
});

const viewProps = (over: Partial<DashboardViewProps> = {}): DashboardViewProps => ({
  locale: "en",
  status: "ready",
  tasks: [{ ...base, state: "done" }, second],
  today: "2026-11-26",
  nowTime: "09:30",
  pendingId: null,
  tickedId: null,
  reaction: null,
  errorKey: null,
  remark: { status: "ready", text: "Keep going" },
  expressions: defaultExpressionSettings(),
  artAvailable: false,
  reducedMotion: false,
  messages: { status: "empty" },
  onTick: () => {},
  onRetry: () => {},
  ...over,
});
const render = (over: Partial<DashboardViewProps> = {}) =>
  renderToStaticMarkup(createElement(DashboardView, viewProps(over)));

describe("DashboardView acceptance", () => {
  const ticked = { text: "Nice, Write report is done (1 of 2).", state: "task_done" as const };

  it("a ticked task plays the check pop, advances the bar and announces a reaction", () => {
    const html = render({ tickedId: base.id, reaction: ticked });
    expect(html).toContain("check-pop");
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toMatch(/role="status"[^>]*>(?:(?!<\/div>)[^])*Nice, Write report is done/);
    expect(html).toContain("mascot-hop");
    expect(html).toContain("sparkle");
  });

  it("with reduced motion no animation class is rendered", () => {
    const html = render({ tickedId: base.id, reaction: ticked, reducedMotion: true });
    expect(html).toContain('data-motion="off"');
    for (const cls of [
      "check-pop",
      "mascot-hop",
      "sparkle",
      "mascot-float",
      "dash-wobble",
      "halo",
    ]) {
      expect(html).not.toContain(cls);
    }
    // The reaction is still announced and the bar still advances.
    expect(html).toContain("Nice, Write report is done");
    expect(html).toContain('aria-valuenow="50"');
  });

  it("idle motion is on by default and a late task wobbles", () => {
    const html = render({ nowTime: "11:00", tasks: [second] });
    expect(html).toContain('data-motion="on"');
    expect(html).toContain("mascot-float");
    expect(html).toContain("dash-wobble");
  });

  it("CSS declares animations only for no-preference motion", () => {
    const css = readFileSync(new URL("../app/dashboard.css", import.meta.url), "utf8");
    const withoutMotion = css.replace(
      /@media \(prefers-reduced-motion: no-preference\)\s*\{[^]*\n\}\n?/g,
      "",
    );
    expect(css).toContain("prefers-reduced-motion: no-preference");
    expect(withoutMotion).not.toMatch(/animation\s*:/);
    expect(withoutMotion).not.toMatch(/transition\s*:/);
  });

  it("shows loading, error and empty states", () => {
    expect(render({ status: "loading" })).toContain(en["dashboard.loading"]);
    expect(render({ status: "error" })).toContain('role="alert"');
    expect(render({ status: "ready", tasks: [] })).toContain(en["dashboard.empty.title"]);
  });

  it("falls back to the fixed sentence when the remark fails", () => {
    expect(render({ remark: { status: "error" } })).toContain(en["companion.fallback"]);
  });

  it("has every dashboard key in both locales", () => {
    const keys = Object.keys(en).filter((k) => k.startsWith("dashboard."));
    expect(keys.length).toBeGreaterThan(8);
    for (const k of keys) expect(vi).toHaveProperty(k);
  });
});
