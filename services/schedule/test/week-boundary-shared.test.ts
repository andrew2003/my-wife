import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { parseEvent, type EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };

function setup() {
  let t = new Date("2026-11-23T08:00:00Z");
  const events: EventEnvelope[] = [];
  const appP = createApp(config, {
    now: () => t,
    publish: (e: EventEnvelope) => void events.push(e),
  });
  return { appP, events, setNow: (s: string) => (t = new Date(s)) };
}
type App = Awaited<ReturnType<typeof setup>["appP"]>;

const cycleOpened = (firstDay: string) => ({
  id: "cycle-opened-c1",
  type: "cycle.opened",
  occurredAt: "2026-11-02T00:00:00Z",
  userId: "u1",
  schemaVersion: 1,
  payload: { cycleId: "c1", sequence: 1, firstDay },
});

async function openCycle(app: App, firstDay: string) {
  const res = await app.inject({
    method: "POST",
    url: "/events/ledger",
    payload: cycleOpened(firstDay),
  });
  expect(res.statusCode).toBe(200);
}

const createWeek = (app: App, firstDay: string) =>
  app.inject({ method: "POST", url: "/weeks", headers: H, payload: { firstDay } });

async function approve(app: App, firstDay: string) {
  const created = await createWeek(app, firstDay);
  const weekId = created.json().data.week.id as string;
  await app.inject({ method: "POST", url: `/weeks/${weekId}/approve`, headers: H });
  return weekId;
}

describe("shared week boundary", () => {
  const job = (app: App) => app.inject({ method: "POST", url: "/jobs/week-boundary" });

  it("emits week.closed once with the cycle first day and week index when the boundary passes", async () => {
    const { appP, events, setNow } = setup();
    const app = await appP;
    await openCycle(app, "2026-11-09");
    const weekId = await approve(app, "2026-11-23");
    setNow("2026-11-30T00:00:01Z");
    await job(app);
    await job(app);
    const closed = events.filter((e) => e.type === "week.closed");
    expect(closed).toHaveLength(1);
    expect(parseEvent(closed[0]).success).toBe(true);
    expect(closed[0]!.payload).toEqual({ weekId, firstDay: "2026-11-23", weekIndexInCycle: 3 });
  });

  it("keeps the week index null while no cycle is known", async () => {
    const { appP, events, setNow } = setup();
    const app = await appP;
    await approve(app, "2026-11-23");
    setNow("2026-11-30T00:00:01Z");
    await job(app);
    const closed = events.find((e) => e.type === "week.closed")!;
    expect(closed.payload).toMatchObject({ weekIndexInCycle: null });
  });

  it("refuses a week whose first day is not a week start of the running cycle", async () => {
    const { appP } = setup();
    const app = await appP;
    await openCycle(app, "2026-11-09");
    const bad = await createWeek(app, "2026-11-24");
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error.code).toBe("schedule.week_not_aligned");
    const good = await createWeek(app, "2026-11-16");
    expect(good.statusCode).toBe(200);
  });

  it("does not constrain weeks that start before the cycle", async () => {
    const { appP } = setup();
    const app = await appP;
    await openCycle(app, "2026-11-09");
    const early = await createWeek(app, "2026-11-04");
    expect(early.statusCode).toBe(200);
  });
});
