import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi as vitest } from "vitest";
import type { Task } from "@my-wife/contracts";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { ChecklistView } from "../components/checklist-view";
import { applyTaskAction, loadChecklist, utcDate } from "../lib/checklist";

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

describe("loadChecklist", () => {
  it("reads the tasks of the day through the gateway", async () => {
    const f = vitest.fn(async (_u: string) =>
      json(200, { ok: true, data: { date: "2026-11-26", tasks: [base, second] } }),
    );
    const res = await loadChecklist("2026-11-26", f as never);
    expect(f.mock.calls[0]![0]).toBe("/api/checklist?date=2026-11-26");
    expect(res).toEqual({ ok: true, tasks: [base, second] });
  });

  it("reports an error for a failed response or a network error", async () => {
    expect((await loadChecklist("2026-11-26", (async () => json(502, {})) as never)).ok).toBe(
      false,
    );
    const down = async () => {
      throw new Error("down");
    };
    expect((await loadChecklist("2026-11-26", down as never)).ok).toBe(false);
  });
});

describe("applyTaskAction", () => {
  it("start replaces only that task with the saved one", async () => {
    const saved = { ...base, state: "in_progress" as const };
    const f = vitest.fn(async (_u: string, _i: RequestInit) =>
      json(200, { ok: true, data: { task: saved } }),
    );
    const res = await applyTaskAction("start", base.id, [base, second], f as never);
    expect(f.mock.calls[0]![0]).toBe("/api/tasks/start");
    expect(JSON.parse(String(f.mock.calls[0]![1].body))).toEqual({ taskId: base.id });
    expect(res).toEqual({ ok: true, tasks: [saved, second] });
  });

  it("done calls complete and updates the list without a reload", async () => {
    const saved = { ...second, state: "done" as const };
    const f = vitest.fn(async (_u: string, _i: RequestInit) =>
      json(200, { ok: true, data: { task: saved } }),
    );
    const res = await applyTaskAction("done", second.id, [base, second], f as never);
    expect(f.mock.calls[0]![0]).toBe("/api/tasks/complete");
    expect(res).toEqual({ ok: true, tasks: [base, saved] });
  });

  it("keeps the list and reports the error when saving fails", async () => {
    const f = async () => json(409, { ok: false, error: { code: "schedule.task_invalid_state" } });
    const res = await applyTaskAction("done", base.id, [base], f as never);
    expect(res).toEqual({ ok: false, tasks: [base], code: "schedule.task_invalid_state" });
  });
});

describe("utcDate", () => {
  it("formats the UTC day", () => {
    expect(utcDate(new Date("2026-11-26T23:30:00Z"))).toBe("2026-11-26");
  });
});

describe("ChecklistView", () => {
  const view = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(ChecklistView, {
        locale: "vi",
        status: "ready",
        tasks: [],
        pendingId: null,
        errorKey: null,
        onAction: () => {},
        onRetry: () => {},
        ...props,
      } as never),
    );

  it("lists tasks with start and done actions", () => {
    const html = view({ tasks: [base, second] });
    expect(html).toContain("Write report");
    expect(html).toContain("Call bank");
    expect(html).toContain(vi["checklist.start"]);
    expect(html).toContain(vi["checklist.done"]);
  });

  it("offers only done for a task in progress and no action for a done task", () => {
    const progress = view({ tasks: [{ ...base, state: "in_progress" }] });
    expect(progress).not.toContain(vi["checklist.start"]);
    expect(progress).toContain(vi["checklist.done"]);
    const finished = view({ tasks: [{ ...second, state: "done" }] });
    expect(finished).not.toContain(`>${vi["checklist.done"]}<`);
    expect(finished).toContain(vi["checklist.state.done"]);
  });

  it("shows empty, loading and error states", () => {
    expect(view({ tasks: [] })).toContain(vi["checklist.empty"]);
    expect(view({ status: "loading" })).toContain(vi["checklist.loading"]);
    const err = view({ status: "error" });
    expect(err).toContain(vi["checklist.error"]);
    expect(err).toContain(vi["checklist.retry"]);
  });

  it("renders English strings", () => {
    expect(view({ locale: "en", tasks: [base] })).toContain(en["checklist.start"]);
  });

  it("has every checklist key in both locales", () => {
    const keys = Object.keys(en).filter((k) => k.startsWith("checklist."));
    expect(keys.length).toBeGreaterThan(5);
    for (const k of keys) expect(vi).toHaveProperty([k]);
  });
});
