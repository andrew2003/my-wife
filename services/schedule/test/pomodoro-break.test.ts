import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";
import { planBreak } from "../src/pomodoro";
import en from "../src/locales/en.json";
import vi from "../src/locales/vi.json";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };
const MIN = 60_000;

describe("planBreak (table-driven)", () => {
  const settings = { shortMinutes: 5, longMinutes: 15, longEvery: 4 };
  it.each([
    [1, "break", 5],
    [3, "break", 5],
    [4, "long_break", 15],
    [5, "break", 5],
    [8, "long_break", 15],
  ])("pomodoro %i gives %s of %i minutes", (n, kind, minutes) => {
    expect(planBreak(n, settings)).toEqual({ kind, minutes });
  });
  it("uses user settings, not constants", () => {
    expect(planBreak(2, { shortMinutes: 7, longMinutes: 30, longEvery: 2 })).toEqual({
      kind: "long_break",
      minutes: 30,
    });
  });
});

function setup(settings: Record<string, unknown> = {}) {
  let t = new Date("2026-11-23T08:00:00.000Z");
  const events: EventEnvelope[] = [];
  const appP = createApp(config, {
    now: () => t,
    publish: (e: EventEnvelope) => void events.push(e),
    readSettings: async () => settings,
  });
  return { appP, events, advance: (ms: number) => (t = new Date(t.getTime() + ms)) };
}

type App = Awaited<ReturnType<typeof createApp>>;

async function start(app: App, taskId?: string) {
  let id = taskId;
  if (!id) {
    const created = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: H,
      payload: { title: "Write", day: "2026-11-23", kind: "desk", monitoringProfile: "none" },
    });
    id = created.json().data.task.id as string;
  }
  const res = await app.inject({
    method: "POST",
    url: "/sessions/start",
    headers: H,
    payload: { taskId: id },
  });
  return { id: id!, session: res.json().data.session };
}

const read = async (app: App, id: string) =>
  (await app.inject({ method: "GET", url: `/sessions/${id}`, headers: H })).json().data.session;

describe("pomodoro break", () => {
  it("starts a break and pauses monitoring without fault when the pomodoro ends", async () => {
    const { appP, events, advance } = setup();
    const app = await appP;
    const { session } = await start(app);
    expect(session.phase).toBe("work");
    expect(session.monitoringPaused).toBe(false);
    advance(25 * MIN);
    const s = await read(app, session.id);
    expect(s.phase).toBe("break");
    expect(s.monitoringPaused).toBe(true);
    expect(s.break).toMatchObject({
      kind: "break",
      startedAt: "2026-11-23T08:25:00.000Z",
      endsAt: "2026-11-23T08:30:00.000Z",
      remainingSeconds: 300,
    });
    expect(events.some((e) => e.type === "fault.detected")).toBe(false);
    advance(5 * MIN);
    const after = await read(app, session.id);
    expect(after.phase).toBe("done");
    expect(after.monitoringPaused).toBe(false);
  });

  it("takes break lengths from user settings", async () => {
    const { appP, advance } = setup({
      "schedule.pomodoro_work_minutes": 10,
      "schedule.pomodoro_break_minutes": 2,
    });
    const app = await appP;
    const { session } = await start(app);
    advance(10 * MIN);
    expect((await read(app, session.id)).break.endsAt).toBe("2026-11-23T08:12:00.000Z");
  });

  it("gives a long break after every Nth completed pomodoro of the task", async () => {
    const { appP, advance } = setup({ "schedule.pomodoro_long_break_every": 2 });
    const app = await appP;
    const first = await start(app);
    advance(25 * MIN);
    await app.runSessionJob(new Date("2026-11-23T08:25:00.000Z"));
    expect((await read(app, first.session.id)).break.kind).toBe("break");
    advance(5 * MIN);
    const second = await start(app, first.id);
    advance(25 * MIN);
    expect((await read(app, second.session.id)).break.kind).toBe("long_break");
  });

  it("starts no break when the user stops early", async () => {
    const { appP, advance } = setup();
    const app = await appP;
    const { session } = await start(app);
    advance(10 * MIN);
    await app.inject({ method: "POST", url: `/sessions/${session.id}/stop`, headers: H });
    const s = await read(app, session.id);
    expect(s.break).toBeNull();
    expect(s.monitoringPaused).toBe(false);
  });

  it("has the same locale keys in vi and en", () => {
    const keys = Object.keys(en).filter((k) => k.startsWith("schedule.pomodoro."));
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(vi).toHaveProperty([k]);
  });
});
