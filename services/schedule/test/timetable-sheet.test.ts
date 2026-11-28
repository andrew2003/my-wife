import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { CellEditResponseSchema } from "@my-wife/contracts";
import { createApp } from "../src/index";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };

/** Simulated "now": Wednesday of the week starting 2026-11-23. */
async function setup() {
  const app = await createApp(config, { now: () => new Date("2026-11-25T08:00:00Z") });
  const mk = async (firstDay: string, day: string) => {
    const w = await app.inject({
      method: "POST",
      url: "/weeks",
      headers: H,
      payload: { firstDay },
    });
    const t = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: H,
      payload: {
        title: "Read",
        day,
        window: { start: "09:00", end: "10:00" },
        estimatedMinutes: 60,
        monitoringProfile: "none",
        kind: "desk",
      },
    });
    return { weekId: w.json().data.week.id as string, taskId: t.json().data.task.id as string };
  };
  return { app, mk };
}

const edit = (taskId: string | undefined, field: string, value: unknown) => ({
  sheet: "timetable",
  tab: "week",
  cellRef: "B2",
  entityId: taskId,
  field,
  value,
});

describe("timetable sheet read (#524)", () => {
  it("marks editable cells and locks computed ones in the current week", async () => {
    const { app, mk } = await setup();
    const { weekId, taskId } = await mk("2026-11-23", "2026-11-26");
    const res = await app.inject({
      method: "GET",
      url: `/timetable-sheet?weekId=${weekId}`,
      headers: H,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.readOnly).toBe(false);
    const row = data.rows.find((r: { entityId: string }) => r.entityId === taskId);
    const byField = Object.fromEntries(row.cells.map((c: { field: string }) => [c.field, c]));
    expect(byField.title).toMatchObject({ value: "Read", editable: true });
    expect(byField.windowStart).toMatchObject({ value: "09:00", editable: true });
    expect(byField.state).toMatchObject({ value: "planned", editable: false });
    expect(data.computed.plannedMinutes).toBe(60);
  });

  it("marks a past week read-only", async () => {
    const { app, mk } = await setup();
    const { weekId } = await mk("2026-11-09", "2026-11-10");
    const res = await app.inject({
      method: "GET",
      url: `/timetable-sheet?weekId=${weekId}`,
      headers: H,
    });
    const data = res.json().data;
    expect(data.readOnly).toBe(true);
    expect(data.rows[0].cells.every((c: { editable: boolean }) => !c.editable)).toBe(true);
  });

  it("404 for an unknown week and 401 without a user", async () => {
    const { app } = await setup();
    const a = await app.inject({ method: "GET", url: "/timetable-sheet?weekId=nope", headers: H });
    expect(a.statusCode).toBe(404);
    const b = await app.inject({ method: "GET", url: "/timetable-sheet" });
    expect(b.statusCode).toBe(401);
  });
});

describe("timetable sheet write (#524)", () => {
  it("refuses a write in a past week and leaves the task unchanged", async () => {
    const { app, mk } = await setup();
    const { weekId, taskId } = await mk("2026-11-09", "2026-11-10");
    const res = await app.inject({
      method: "POST",
      url: "/timetable-sheet/cells",
      headers: H,
      payload: edit(taskId, "title", "Changed"),
    });
    const body = res.json();
    expect(CellEditResponseSchema.safeParse(body).success).toBe(true);
    expect(body.data).toEqual({ status: "rejected", reason: "past_week" });
    const sheet = await app.inject({
      method: "GET",
      url: `/timetable-sheet?weekId=${weekId}`,
      headers: H,
    });
    expect(sheet.json().data.rows[0].task.title).toBe("Read");
  });

  it.each(["state", "carriedCount", "plannedMinutes", "unknownField"])(
    "refuses a computed or unknown cell: %s",
    async (field) => {
      const { app, mk } = await setup();
      const { taskId } = await mk("2026-11-23", "2026-11-26");
      const res = await app.inject({
        method: "POST",
        url: "/timetable-sheet/cells",
        headers: H,
        payload: edit(taskId, field, "done"),
      });
      expect(res.json().data).toEqual({ status: "rejected", reason: "locked_cell" });
    },
  );

  it.each([
    ["title", "New title", "title", "New title"],
    ["day", "2026-11-27", "day", "2026-11-27"],
    ["windowStart", "08:30", "window", { start: "08:30", end: "10:00" }],
    ["windowEnd", "11:00", "window", { start: "09:00", end: "11:00" }],
    ["estimatedMinutes", 45, "estimatedMinutes", 45],
    ["definitionOfDone", "Ten pages", "definitionOfDone", "Ten pages"],
  ])("applies an editable cell: %s", async (field, value, taskField, expected) => {
    const { app, mk } = await setup();
    const { weekId, taskId } = await mk("2026-11-23", "2026-11-26");
    const res = await app.inject({
      method: "POST",
      url: "/timetable-sheet/cells",
      headers: H,
      payload: edit(taskId, field, value),
    });
    expect(res.json().data).toEqual({ status: "applied" });
    const sheet = await app.inject({
      method: "GET",
      url: `/timetable-sheet?weekId=${weekId}`,
      headers: H,
    });
    const row = sheet.json().data.rows.find((r: { entityId: string }) => r.entityId === taskId);
    expect(row.task[taskField]).toEqual(expected);
  });

  it.each([
    ["title", ""],
    ["day", "tomorrow"],
    ["windowStart", "25:99"],
    ["windowEnd", "08:00"],
    ["estimatedMinutes", -5],
    ["estimatedMinutes", "ten"],
  ])("rejects an invalid value: %s=%j", async (field, value) => {
    const { app, mk } = await setup();
    const { taskId } = await mk("2026-11-23", "2026-11-26");
    const res = await app.inject({
      method: "POST",
      url: "/timetable-sheet/cells",
      headers: H,
      payload: edit(taskId, field, value),
    });
    expect(res.json().data).toEqual({ status: "rejected", reason: "validation_failed" });
  });

  it("rejects moving a task into a past day", async () => {
    const { app, mk } = await setup();
    const { taskId } = await mk("2026-11-23", "2026-11-26");
    const res = await app.inject({
      method: "POST",
      url: "/timetable-sheet/cells",
      headers: H,
      payload: edit(taskId, "day", "2026-11-10"),
    });
    expect(res.json().data).toEqual({ status: "rejected", reason: "past_week" });
  });

  it("rejects a budget sheet request, a missing entity and another user's task", async () => {
    const { app, mk } = await setup();
    const { taskId } = await mk("2026-11-23", "2026-11-26");
    const post = (payload: object, headers: Record<string, string> = H) =>
      app.inject({ method: "POST", url: "/timetable-sheet/cells", headers, payload });
    expect((await post({ ...edit(taskId, "title", "x"), sheet: "budget" })).statusCode).toBe(400);
    expect((await post(edit(undefined, "title", "x"))).statusCode).toBe(400);
    expect(
      (await post(edit("11111111-1111-4111-8111-111111111111", "title", "x"))).statusCode,
    ).toBe(404);
    expect((await post(edit(taskId, "title", "x"), { "x-user-id": "u2" })).statusCode).toBe(404);
    expect((await post(edit(taskId, "title", "x"), {})).statusCode).toBe(401);
  });
});
