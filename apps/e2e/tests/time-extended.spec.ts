import { afterAll, beforeAll, expect, it } from "vitest";
import { SETTINGS } from "@my-wife/contracts";
import { startTimeWorld, type TimeWorld } from "../support/time-world";

/**
 * Scenario 3, extended: the time flow over three simulated weeks on Chrome's counterpart for
 * the server side (the hidden-tab countdown runs in the browser: tests/hidden-tab-countdown.spec.ts).
 *
 * Week 1 (Mon 2026-12-07): a lost camera escalates from the web to chat and becomes a hard fault;
 * the user appeals it and the appeal is overturned. Unfinished tasks are carried over until the
 * carry-over limit makes the bot ask. A second fault on 2026-12-08 stands. A third fault on
 * 2026-12-11 is waived because a sick day is activated retroactively (special mode). Week 1
 * closes with its review. Weeks 2 and 3 are clean, so after the configured number of clean weeks
 * the monitor proposes a lower supervision level and the user accepts.
 *
 * Every number is a setting: the scenario sets the two it needs (carry-over limit, clean weeks)
 * and reads every other default from the registry. Every job receives `now` from the simulator.
 * The steps depend on each other, so each test builds on the state the previous one left.
 */
const START = "2026-12-07T02:00:00.000Z";
const WEEK1 = "2026-12-07";
const WEEK2 = "2026-12-14";
const WEEK3 = "2026-12-21";
const SEC = 1000;
const MIN = 60_000;
const HOUR = 3_600_000;

// Responses are read untyped on purpose: the scenario checks the outcome, not the schema.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = { ok: boolean; data: Record<string, any> };

const TAPER_CLEAN_WEEKS = 2;
const CARRY_OVER_MAX = 2;

let world: TimeWorld;
const ids: Record<string, string> = {};
const faultIds: string[] = [];
let weekId = "";

beforeAll(async () => {
  world = await startTimeWorld({
    start: START,
    extended: true,
    settings: {
      "schedule.carry_over_rule": "roll_forward",
      "schedule.carry_over_max_times": CARRY_OVER_MAX,
      "monitor.taper_clean_weeks": TAPER_CLEAN_WEEKS,
    },
  });
});
afterAll(async () => {
  await world.stop();
});

const json = async (res: Response) => (await res.json()) as Json;
const sent = (channel: string) =>
  world.ofType("urgent.sent").filter((e) => (e.payload as { channel: string }).channel === channel);
const checklist = async (day: string) =>
  (await json(await world.get(`${world.urls.schedule}/checklist?date=${day}`))).data.tasks as {
    id: string;
    title: string;
    state: string;
    day: string;
    carriedCount: number;
    priority: string;
  }[];

/** Camera lost, no reason given: the urgent message escalates and one hard fault is scored. */
async function silentCameraLoss(taskId: string): Promise<string> {
  const before = world.ofType("fault.recorded").length;
  const started = await world.startMonitoring(taskId);
  expect(started.status).toBe(200);
  await world.clock.advanceBy(2 * MIN);
  world.setCamera(false);
  const lost = SETTINGS["monitor.heartbeat_missing_seconds"].default;
  const chat = SETTINGS["monitor.urgent_chat_after_seconds"].default;
  const silent = SETTINGS["monitor.urgent_silent_fault_after_seconds"].default;
  await world.clock.advanceBy((lost + 30) * SEC);
  await world.clock.advanceBy((chat + 10) * SEC);
  await world.clock.advanceBy((silent + 10) * SEC);
  await world.post(`${world.urls.monitor}/sessions/${started.sessionId}/end`);
  const recorded = world.ofType("fault.recorded");
  expect(recorded).toHaveLength(before + 1);
  return (recorded.at(-1)!.payload as { faultId: string }).faultId;
}

it("setup: three planned weeks and the tasks of the first day", async () => {
  const { schedule } = world.urls;
  for (const firstDay of [WEEK1, WEEK2, WEEK3]) {
    const week = await json(await world.post(`${schedule}/weeks`, { firstDay }));
    expect(week.ok).toBe(true);
    if (firstDay === WEEK1) weekId = week.data.week.id;
    expect((await world.post(`${schedule}/weeks/${week.data.week.id}/approve`)).status).toBe(200);
  }
  for (const [key, title, profile] of [
    ["focus", "Write the report", "camera"],
    ["bill", "Pay the bill", "none"],
    ["bank", "Call the bank", "none"],
    ["tidy", "Tidy the desk", "none"],
  ] as const) {
    const res = await json(
      await world.post(`${schedule}/tasks`, {
        title,
        day: WEEK1,
        kind: "desk",
        monitoringProfile: profile,
      }),
    );
    ids[key] = res.data.task.id;
  }
  expect((await world.post(`${schedule}/tasks/complete`, { taskId: ids.tidy })).status).toBe(200);
  expect((await world.post(`${schedule}/tasks/complete`, { taskId: ids.focus })).status).toBe(200);
});

it("escalation: a silent camera loss goes web, then chat, then one scored fault", async () => {
  const gap = SETTINGS["monitor.heartbeat_missing_seconds"].default;
  const started = await world.startMonitoring(ids.focus!);
  expect(started.status).toBe(200);
  await world.clock.advanceBy(2 * MIN);
  world.setCamera(false);
  await world.clock.advanceBy((gap - 15) * SEC);
  expect(world.types()).not.toContain("urgent.sent");
  await world.clock.advanceBy(30 * SEC);
  expect(sent("web")).toHaveLength(1);
  expect(sent("chat")).toHaveLength(0);
  expect(world.urgentMessages).toHaveLength(1);

  const chatAfter = SETTINGS["monitor.urgent_chat_after_seconds"].default;
  await world.clock.advanceBy((chatAfter + 10) * SEC);
  expect(sent("chat")).toHaveLength(1);
  expect(world.types()).not.toContain("fault.detected");

  const silent = SETTINGS["monitor.urgent_silent_fault_after_seconds"].default;
  await world.clock.advanceBy((silent + 10) * SEC);
  expect(world.ofType("reason.expired")).toHaveLength(1);
  expect(world.ofType("fault.detected")).toHaveLength(1);
  const recorded = world.ofType("fault.recorded");
  expect(recorded).toHaveLength(1);
  expect(recorded[0]!.payload).toMatchObject({
    type: "heartbeat_lost",
    points: SETTINGS["fault.weight.heartbeat_lost"].default,
  });
  faultIds.push((recorded[0]!.payload as { faultId: string }).faultId);
  expect((await world.post(`${world.urls.monitor}/sessions/${started.sessionId}/end`)).status).toBe(
    200,
  );
});

it("appeal: the fault is appealed inside the window and the overturn removes it", async () => {
  const { rules } = world.urls;
  const opened = await world.post(`${rules}/appeals`, {
    subjectKind: "fault",
    subjectId: faultIds[0],
    reasonText: "The router restarted; I was at my desk the whole time.",
  });
  expect(opened.status).toBe(200);
  const appeal = (await json(opened)).data.appeal;
  expect(appeal).toMatchObject({ status: "open", subjectId: faultIds[0] });
  expect(world.ofType("appeal.opened")).toHaveLength(1);

  // A second appeal on the same fault is refused while one is open.
  const again = await world.post(`${rules}/appeals`, {
    subjectKind: "fault",
    subjectId: faultIds[0],
    reasonText: "Again.",
  });
  expect(again.status).toBe(409);

  await world.clock.advanceBy(HOUR);
  const decided = await json(
    await world.post(`${rules}/appeals/decide`, {
      appealId: appeal.id,
      outcome: "overturned",
      note: "The heartbeat log shows the network outage.",
    }),
  );
  expect(decided.data.appeal).toMatchObject({ status: "overturned" });
  const events = world.ofType("fault.appeal_decided");
  expect(events).toHaveLength(1);
  expect(events[0]!.payload).toMatchObject({ faultId: faultIds[0], outcome: "overturned" });
  // Spec 12 section 3: an overturned fault is removed from the totals (`fault.waived`).
  expect(
    world.ofType("fault.waived").map((e) => (e.payload as { faultId: string }).faultId),
  ).toContain(faultIds[0]);
});

it("carry-over: unfinished tasks roll forward, then the bot asks after the limit", async () => {
  world.disarmMonitorJobs();
  // 2026-12-07T17:00Z is local midnight (UTC+7): the day-end job carries what is unfinished.
  await world.clock.advanceTo("2026-12-07T18:00:00.000Z");
  expect(world.ofType("task.carried")).toHaveLength(2);
  let day = await checklist("2026-12-08");
  expect(day.map((t) => [t.title, t.carriedCount])).toEqual([
    ["Pay the bill", 1],
    ["Call the bank", 1],
  ]);

  // A fault on the second day stands: it is the one the review lists.
  await world.clock.advanceTo("2026-12-08T03:00:00.000Z");
  faultIds.push(await silentCameraLoss(ids.focus!));
  world.disarmMonitorJobs();

  await world.clock.advanceTo("2026-12-09T12:00:00.000Z");
  day = await checklist("2026-12-09");
  expect(day.map((t) => t.carriedCount)).toEqual([2, 2]);
  expect(world.ofType("ask.carry_over")).toHaveLength(0);

  // The limit is reached: the next day end (local midnight) asks instead of carrying.
  await world.clock.advanceTo("2026-12-09T18:00:00.000Z");
  const asks = world.ofType("ask.carry_over");
  expect(asks).toHaveLength(2);
  const askOf = (taskId: string) =>
    asks.find((e) => (e.payload as { subjectRef: string }).subjectRef === `task:${taskId}`)!
      .payload as { questionId: string };
  const answered = await json(
    await world.post(`${world.urls.schedule}/tasks/carry-over-answer`, {
      taskId: ids.bill,
      questionId: askOf(ids.bill!).questionId,
      value: "lower_priority",
    }),
  );
  expect(answered.data.task).toMatchObject({ carriedCount: 3, priority: "low", state: "planned" });
  // A repeated answer is refused.
  const stale = await world.post(`${world.urls.schedule}/tasks/carry-over-answer`, {
    taskId: ids.bill,
    questionId: askOf(ids.bill!).questionId,
    value: "roll_forward",
  });
  expect(stale.status).toBe(409);

  // The other question stays unanswered; once it expires the task rolls forward by itself.
  await world.clock.advanceBy(26 * HOUR);
  const rolled = world.ofType("task.carried").filter((e) => {
    const p = e.payload as { taskId: string; carriedCount: number };
    return p.taskId === ids.bank && p.carriedCount === 3;
  });
  expect(rolled).toHaveLength(1);
});

it("special mode: a retroactive sick day waives the fault of that day", async () => {
  await world.clock.advanceTo("2026-12-11T05:00:00.000Z");
  faultIds.push(await silentCameraLoss(ids.focus!));
  world.disarmMonitorJobs();

  // The quota and the retroactive window come from settings; this is the next local morning.
  await world.clock.advanceTo("2026-12-12T02:00:00.000Z");
  const refused = await world.post(`${world.urls.schedule}/special-modes`, {
    kind: "sick",
    fromDay: "2026-12-11",
    toDay: "2026-12-11",
  });
  expect(refused.status).toBe(409); // a retroactive period needs a reason
  const res = await world.post(`${world.urls.schedule}/special-modes`, {
    kind: "sick",
    fromDay: "2026-12-11",
    toDay: "2026-12-11",
    reason: "fever",
  });
  expect(res.status).toBe(201);
  const period = (await json(res)).data.period;
  expect(period.waivedFaults).toEqual([{ faultId: faultIds[2], reason: "special_mode" }]);
  expect(world.ofType("special_mode.started")).toHaveLength(1);

  await world.clock.advanceBy(2 * HOUR);
  expect(world.ofType("special_mode.ended")).toHaveLength(1);
  await world.clock.advanceBy(3 * HOUR);
  expect(world.ofType("special_mode.ended")).toHaveLength(1);
});

it("review: week 1 closes once and lists only the fault that stands", async () => {
  await world.clock.advanceTo("2026-12-14T00:00:00.000Z");
  expect(world.ofType("week.closed")).toHaveLength(1);
  expect(world.ofType("review.ready")).toHaveLength(1);
  expect(world.types().filter((t) => t === "week.closed" || t === "review.ready")).toEqual([
    "week.closed",
    "review.ready",
  ]);
  const review = (await json(await world.get(`${world.urls.schedule}/weeks/${weekId}/review`))).data
    .review;
  // Carried tasks still count in the week they sit in; one rolled into the next week by now.
  expect(review.tasks.completed).toBe(2);
  expect(review.tasks.completedTasks.map((t: { title: string }) => t.title).sort()).toEqual([
    "Tidy the desk",
    "Write the report",
  ]);
  expect(review.tasks.planned).toBe(review.tasks.completed + review.tasks.open);
  expect(review.faults.items.map((f: { faultId: string }) => f.faultId)).toEqual([faultIds[1]]);
  expect(review.faults.totalPoints).toBe(SETTINGS["fault.weight.heartbeat_lost"].default);
});

it("tapering: clean weeks propose a lower level and the user accepts", async () => {
  // Week 1 held a special-mode day, so it counts neither as clean nor as unclean.
  expect(world.supervision()).toMatchObject({ level: "full", cleanWeeks: 0 });

  await world.clock.advanceTo("2026-12-21T00:00:00.000Z");
  expect(world.ofType("week.closed")).toHaveLength(2);
  expect(world.supervision()).toMatchObject({ cleanWeeks: 1 });
  expect(world.ofType("ask.supervision_taper")).toHaveLength(0);

  await world.clock.advanceTo("2026-12-28T00:00:00.000Z");
  expect(world.ofType("week.closed")).toHaveLength(3);
  const asks = world.ofType("ask.supervision_taper");
  expect(asks).toHaveLength(1);
  const question = asks[0]!.payload as { questionId: string };
  // The level never changes before the user answers.
  expect(world.ofType("supervision.level_changed")).toHaveLength(0);

  await world.reply(question.questionId, "supervision_taper", "accept");
  const changed = world.ofType("supervision.level_changed");
  expect(changed).toHaveLength(1);
  expect(changed[0]!.payload).toMatchObject({
    from: "full",
    to: "no_camera",
    cause: "taper_accepted",
  });
  expect(world.supervision()).toMatchObject({ level: "no_camera", cleanWeeks: 0 });

  // A repeated answer changes nothing.
  await world.reply(question.questionId, "supervision_taper", "accept");
  expect(world.ofType("supervision.level_changed")).toHaveLength(1);
});

it("no business code read the system clock", () => {
  const start = Date.parse(START);
  expect(world.events.length).toBeGreaterThan(20);
  for (const e of world.events)
    expect(Date.parse(e.occurredAt), e.type).toBeGreaterThanOrEqual(start);
});
