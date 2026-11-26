import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };
type App = Awaited<ReturnType<typeof createApp>>;

const AT_WEEK_END = {};

function setup(opts: { failReview?: { n: number }; settings?: Record<string, unknown> } = {}) {
  let t = new Date("2026-11-23T08:00:00Z");
  const events: EventEnvelope[] = [];
  const appP = createApp(config, {
    now: () => t,
    readSettings: async () => (opts.settings ?? AT_WEEK_END) as never,
    publish: (e: EventEnvelope) => {
      if (e.type === "review.ready" && opts.failReview && opts.failReview.n-- > 0) {
        throw new Error("bus down");
      }
      events.push(e);
    },
  });
  return { appP, events, setNow: (s: string) => (t = new Date(s)) };
}

const job = (app: App) => app.inject({ method: "POST", url: "/jobs/week-boundary" });
const post = (app: App, url: string, payload: object, headers: Record<string, string> = H) =>
  app.inject({ method: "POST", url, headers, payload });

async function plannedWeek(app: App) {
  const created = await post(app, "/weeks", { firstDay: "2026-11-23" });
  const weekId = created.json().data.week.id as string;
  await app.inject({ method: "POST", url: `/weeks/${weekId}/approve`, headers: H });
  return weekId;
}

async function addTask(app: App, title: string, day: string, done: boolean) {
  const res = await post(app, "/tasks", {
    title,
    day,
    kind: "desk",
    estimatedMinutes: 60,
    monitoringProfile: "none",
  });
  const taskId = res.json().data.task.id as string;
  if (done) await post(app, "/tasks/complete", { taskId });
  return taskId;
}

const ledger = (type: string, id: string, payload: unknown, at = "2026-11-30T00:05:00Z") => ({
  id,
  type,
  occurredAt: at,
  userId: "u1",
  schemaVersion: 1,
  payload,
});
const fault = (id: string, points: number, at = "2026-11-25T09:00:00Z") =>
  ledger(
    "fault.recorded",
    `fr-${id}`,
    { faultId: id, type: "wake_late", points, occurredAt: at },
    at,
  );
const overspend = (id: string, excess: number) =>
  ledger("overspend.detected", id, {
    cycleId: "c1",
    weekIndex: 1,
    categoryId: "cat-" + id,
    priority: "want",
    weeklyLimitVnd: 500_000,
    spentVnd: 500_000 + excess,
    excessVnd: excess,
  });

const cycleOpened = (firstDay = "2026-11-23") =>
  ledger("cycle.opened", "co-1", { cycleId: "c1", sequence: 1, firstDay }, "2026-11-22T00:00:00Z");
const txn = (id: string, amount: number, at: string, direction = "out", categoryId = "cat-x") =>
  ledger(
    "txn.recorded",
    `tr-${id}`,
    {
      transactionId: id,
      cycleId: "c1",
      amountVnd: amount,
      direction,
      transactionType: "coded_unplanned",
      reconciliationResult: "unplanned",
      categoryId,
      bankAccountId: "acc",
      memo: "",
    },
    at,
  );

const types = (events: EventEnvelope[]) =>
  events.map((e) => e.type).filter((x) => x !== "week.planned");

describe("weekly review", () => {
  it("emits review.ready after week.closed once the review time has arrived", async () => {
    const { appP, events, setNow } = setup();
    const app = await appP;
    const weekId = await plannedWeek(app);
    await addTask(app, "A", "2026-11-24", true);
    setNow("2026-11-29T21:00:00Z"); // review time (Sunday 20:00) but the week is not over
    await job(app);
    expect(types(events)).not.toContain("review.ready");
    expect(types(events)).not.toContain("week.closed");
    setNow("2026-11-30T00:00:01Z");
    await job(app);
    await job(app);
    expect(types(events).filter((x) => x === "review.ready")).toHaveLength(1);
    const ready = events.find((e) => e.type === "review.ready")!;
    expect(ready.payload).toMatchObject({ weekId, firstDay: "2026-11-23" });
  });

  it("emits week.closed before review.ready, never the other way round", async () => {
    const { appP, events, setNow } = setup();
    const app = await appP;
    await plannedWeek(app);
    setNow("2026-12-07T00:00:00Z"); // long after the review time: both are due in one run
    await job(app);
    expect(types(events).filter((x) => x === "week.closed" || x === "review.ready")).toEqual([
      "week.closed",
      "review.ready",
    ]);
  });

  it("is due at week close by default, even though the default review day is Sunday", async () => {
    const { appP, events, setNow } = setup();
    const app = await appP;
    await plannedWeek(app);
    setNow("2026-11-30T00:00:01Z");
    await job(app);
    expect(types(events)).toEqual(["week.closed", "review.ready"]);
  });

  it("waits for the review time in the user's time zone when it falls on the closing day", async () => {
    const { appP, events, setNow } = setup({
      settings: {
        "schedule.weekly_review_time": { weekday: "monday", time: "09:00" },
        "calendar.time_zone": "Asia/Ho_Chi_Minh",
      },
    });
    const app = await appP;
    await plannedWeek(app);
    setNow("2026-11-30T01:59:00Z"); // 08:59 Monday in Ho Chi Minh City
    await job(app);
    expect(types(events)).toEqual(["week.closed"]);
    setNow("2026-11-30T02:00:00Z"); // 09:00
    await job(app);
    expect(types(events)).toEqual(["week.closed", "review.ready"]);
  });

  it("retries a failed review.ready without duplicating week.closed", async () => {
    const { appP, events, setNow } = setup({ failReview: { n: 1 } });
    const app = await appP;
    await plannedWeek(app);
    setNow("2026-11-30T00:00:01Z");
    await job(app);
    expect(types(events)).toEqual(["week.closed"]);
    await job(app);
    await job(app);
    expect(types(events)).toEqual(["week.closed", "review.ready"]);
  });

  it("shows completed tasks, faults and spending that match the ledgers", async () => {
    const { appP, setNow } = setup();
    const app = await appP;
    const weekId = await plannedWeek(app);
    await addTask(app, "Done one", "2026-11-24", true);
    await addTask(app, "Done two", "2026-11-26", true);
    await addTask(app, "Open", "2026-11-27", false);
    await addTask(app, "Next week", "2026-12-01", true);
    setNow("2026-11-30T00:00:01Z");
    await job(app);
    await post(app, "/events/ledger", cycleOpened());
    await post(app, "/events/ledger", txn("t1", 620_000, "2026-11-24T10:00:00Z", "out", "cat-o1"));
    await post(app, "/events/ledger", txn("t1", 620_000, "2026-11-24T10:00:00Z", "out", "cat-o1"));
    await post(app, "/events/ledger", txn("t2", 80_000, "2026-11-25T10:00:00Z", "out", "cat-fine"));
    await post(app, "/events/ledger", txn("t3", 900_000, "2026-11-26T10:00:00Z", "in"));
    await post(app, "/events/ledger", txn("t4", 70_000, "2026-12-01T10:00:00Z")); // next week
    await post(app, "/events/ledger", fault("f1", 10));
    await post(app, "/events/ledger", fault("f2", 5, "2026-11-28T09:00:00Z"));
    await post(app, "/events/ledger", fault("f2", 5, "2026-11-28T09:00:00Z")); // redelivery
    await post(app, "/events/ledger", fault("f3", 7, "2026-12-02T09:00:00Z")); // other week
    await post(app, "/events/ledger", overspend("o1", 120_000));
    await post(app, "/events/ledger", overspend("o2", 30_000));
    await post(app, "/events/ledger", overspend("o2", 30_000)); // redelivery
    const res = await app.inject({ method: "GET", url: `/weeks/${weekId}/review`, headers: H });
    expect(res.statusCode).toBe(200);
    const r = res.json().data.review;
    expect(r.tasks).toMatchObject({ planned: 3, completed: 2, open: 1 });
    expect(r.tasks.completedTasks.map((t: { title: string }) => t.title).sort()).toEqual([
      "Done one",
      "Done two",
    ]);
    expect(r.faults.totalPoints).toBe(15);
    expect(r.faults.items).toHaveLength(2);
    // Weekly spending is all outgoing money of the week, including categories that did not overspend.
    expect(r.spending.spentVnd).toBe(700_000);
    expect(r.spending.overspentExcessVnd).toBe(150_000);
    expect(r.spending.overspent).toHaveLength(2);
  });

  it("maps an overspend to its week by cycle and week index, whenever it is delivered", async () => {
    const { appP, setNow } = setup();
    const app = await appP;
    const weekId = await plannedWeek(app);
    setNow("2026-12-20T00:00:00Z"); // delivered very late
    await job(app);
    const view = async () =>
      (await app.inject({ method: "GET", url: `/weeks/${weekId}/review`, headers: H })).json().data
        .review.spending;
    await post(app, "/events/ledger", {
      ...overspend("o1", 50_000),
      occurredAt: "2026-12-19T00:00:00Z",
    });
    expect((await view()).overspent).toHaveLength(0); // cycle not known yet: not attributed
    await post(app, "/events/ledger", cycleOpened());
    expect((await view()).overspentExcessVnd).toBe(50_000);
    // week index 2 of the cycle is another week
    const second = overspend("o2", 10_000);
    (second.payload as { weekIndex: number }).weekIndex = 2;
    await post(app, "/events/ledger", second);
    expect((await view()).overspentExcessVnd).toBe(50_000);
  });

  it("excludes waived faults from the review", async () => {
    const { appP, setNow } = setup();
    const app = await appP;
    const weekId = await plannedWeek(app);
    setNow("2026-11-30T00:00:01Z");
    await job(app);
    await post(app, "/events/ledger", fault("f1", 10));
    await post(app, "/events/ledger", fault("f2", 4));
    await post(
      app,
      "/events/ledger",
      ledger("fault.waived", "fw-1", {
        faultId: "f1",
        cause: "heartbeat_gap_outage",
        kind: "system",
      }),
    );
    const res = await app.inject({ method: "GET", url: `/weeks/${weekId}/review`, headers: H });
    expect(res.json().data.review.faults.totalPoints).toBe(4);
  });

  it("refuses the review of a week that is not closed or not the caller's", async () => {
    const { appP, setNow } = setup();
    const app = await appP;
    const weekId = await plannedWeek(app);
    const early = await app.inject({ method: "GET", url: `/weeks/${weekId}/review`, headers: H });
    expect(early.statusCode).toBe(409);
    setNow("2026-11-30T00:00:01Z");
    await job(app);
    const other = await app.inject({
      method: "GET",
      url: `/weeks/${weekId}/review`,
      headers: { "x-user-id": "u2" },
    });
    expect(other.statusCode).toBe(404);
  });

  it("rejects a malformed ledger event", async () => {
    const { appP } = setup();
    const app = await appP;
    const res = await post(app, "/events/ledger", { nope: true });
    expect(res.statusCode).toBe(400);
  });
});
