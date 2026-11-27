import { afterAll, beforeAll, expect, it } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import { SETTINGS } from "@my-wife/contracts";
import { DAY_MS } from "@my-wife/test-kit";
import { startTimeWorld, type TimeWorld } from "../support/time-world";

/**
 * Scenario 3: the time happy path on simulated time.
 *
 * A planned week has a checklist; one task is ticked off, another runs a countdown that ends on
 * the server clock. A camera monitoring session loses its heartbeat (the fake camera is turned
 * off): an urgent message goes out and an honest reason answers it. A second loss stays silent,
 * escalates to chat and ends as a hard fault scored by rules. The week closes once and its
 * review lists the completed task and the fault points.
 *
 * Every job receives `now` from the simulator; the real clock is before the simulated start, so
 * any event stamped earlier than the start would show business code reading the system clock.
 */
async function step(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    throw new Error(`step failed: ${name}`, { cause: err });
  }
}

const START = "2026-12-07T02:00:00.000Z";
const FIRST_DAY = "2026-12-07";
const WEEK_END = "2026-12-14T00:00:00.000Z";
const SEC = 1000;
const MIN = 60_000;

// Responses are read untyped on purpose: the scenario checks the outcome, not the schema.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = { ok: boolean; data: Record<string, any> };

let world: TimeWorld;
beforeAll(async () => {
  world = await startTimeWorld({ start: START });
});
afterAll(async () => {
  await world.stop();
});

const json = async (res: Response) => (await res.json()) as Json;
const sent = (channel: string) =>
  world.ofType("urgent.sent").filter((e) => (e.payload as { channel: string }).channel === channel);

it("time: checklist, countdown, monitoring, urgent reason, faults, weekly review", async () => {
  const { schedule, monitor } = world.urls;
  const ids: Record<string, string> = {};
  let weekId = "";

  await step("a planned week gives a checklist of the day", async () => {
    const week = await json(await world.post(`${schedule}/weeks`, { firstDay: FIRST_DAY }));
    weekId = week.data.week.id;
    for (const [key, title, profile] of [
      ["write", "Write the report", "camera"],
      ["mail", "Answer the mail", "none"],
      ["tidy", "Tidy the desk", "none"],
    ] as const) {
      const res = await json(
        await world.post(`${schedule}/tasks`, {
          title,
          day: FIRST_DAY,
          kind: "desk",
          monitoringProfile: profile,
        }),
      );
      ids[key] = res.data.task.id;
    }
    expect((await world.post(`${schedule}/weeks/${weekId}/approve`)).status).toBe(200);
    expect(world.types()).toContain("week.planned");
    const checklist = await json(await world.get(`${schedule}/checklist?date=${FIRST_DAY}`));
    expect(checklist.data.tasks.map((t: { title: string }) => t.title)).toEqual([
      "Write the report",
      "Answer the mail",
      "Tidy the desk",
    ]);
  });

  await step("ticking a task done emits task.ended and sends no chat message", async () => {
    const res = await world.post(`${schedule}/tasks/complete`, { taskId: ids.tidy });
    expect(res.status).toBe(200);
    expect(world.ofType("task.ended")).toHaveLength(1);
    expect(world.urgentMessages).toHaveLength(0);
    const checklist = await json(await world.get(`${schedule}/checklist?date=${FIRST_DAY}`));
    const states = checklist.data.tasks.map((t: { state: string }) => t.state);
    expect(states).toEqual(["planned", "planned", "done"]);
  });

  let sessionId = "";
  await step("the countdown runs on the server clock and ends once", async () => {
    const started = await json(
      await world.post(`${schedule}/sessions/start`, { taskId: ids.write, durationMinutes: 25 }),
    );
    sessionId = started.data.session.id;
    expect(started.data.session).toMatchObject({ remainingSeconds: 1500, endedAt: null });
    expect(started.data.session.startedAt).toBe(START);

    await world.clock.advanceBy(10 * MIN);
    const mid = await json(await world.get(`${schedule}/sessions/${sessionId}`));
    expect(mid.data.session.remainingSeconds).toBe(900);
    expect(mid.data.session.serverNow).toBe("2026-12-07T02:10:00.000Z");

    await world.clock.advanceBy(14 * MIN);
    expect(world.types()).not.toContain("session.ended");
    await world.clock.advanceBy(2 * MIN);
    expect(world.ofType("session.ended")).toHaveLength(1);
    const done = await json(await world.get(`${schedule}/sessions/${sessionId}`));
    expect(done.data.session).toMatchObject({ remainingSeconds: 0 });
    expect(done.data.session.endedAt).not.toBeNull();
    expect((await world.get(`${schedule}/sessions/active?taskId=${ids.write}`)).status).toBe(404);
  });

  await step("monitoring with a steady fake camera raises nothing", async () => {
    const started = await world.startMonitoring(ids.write!);
    expect(started.status).toBe(200);
    // A second device is refused while a session is active.
    const second = await world.post(`${monitor}/sessions/start`, {
      taskId: null,
      profile: "camera",
      deviceId: "other",
    });
    expect(second.status).toBe(409);
    await world.clock.advanceBy(5 * MIN);
    expect(world.types()).not.toContain("urgent.sent");
    expect(world.types()).not.toContain("fault.detected");
  });

  const gapSeconds = SETTINGS["monitor.heartbeat_missing_seconds"].default;
  let ticketId = "";
  await step("losing the camera sends one urgent message and no fault yet", async () => {
    world.setCamera(false);
    await world.clock.advanceBy((gapSeconds - 15) * SEC);
    expect(world.types()).not.toContain("urgent.sent");
    await world.clock.advanceBy(30 * SEC);
    expect(sent("web")).toHaveLength(1);
    expect(world.urgentMessages).toHaveLength(1);
    expect(world.urgentMessages[0]).toMatchObject({
      class: "urgent",
      message: { key: "monitor.urgent.heartbeat_lost" },
    });
    expect(world.types()).not.toContain("fault.detected");
    ticketId = (sent("web")[0]!.payload as { ticketId: string }).ticketId;
  });

  await step("an honest reason within the delay answers the ticket without a fault", async () => {
    const res = await json(
      await world.post(`${monitor}/reasons`, { ticketId, kind: "network_problem" }),
    );
    expect(res).toMatchObject({ ok: true, data: { ticketId, state: "answered" } });
    expect(world.ofType("reason.given")).toHaveLength(1);
    await world.clock.advanceBy(10 * MIN);
    expect(sent("chat")).toHaveLength(0);
    expect(world.types()).not.toContain("reason.expired");
    expect(world.types()).not.toContain("fault.detected");
  });

  await step("a silent loss escalates to chat and becomes one scored fault", async () => {
    world.setCamera(true);
    await world.clock.advanceBy(2 * MIN);
    world.setCamera(false);
    await world.clock.advanceBy(60 * SEC);
    expect(sent("web")).toHaveLength(2);
    const chatAfter = SETTINGS["monitor.urgent_chat_after_seconds"].default;
    await world.clock.advanceBy((chatAfter + 10) * SEC);
    expect(sent("chat")).toHaveLength(1);
    expect(world.types()).not.toContain("fault.detected");

    const silent = SETTINGS["monitor.urgent_silent_fault_after_seconds"].default;
    await world.clock.advanceBy(silent * SEC);
    expect(world.ofType("reason.expired")).toHaveLength(1);
    const detected = world.ofType("fault.detected");
    expect(detected).toHaveLength(1);
    expect(detected[0]!.payload).toMatchObject({ type: "heartbeat_lost", reason: "none" });
    const recorded = world.ofType("fault.recorded");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.payload).toMatchObject({
      type: "heartbeat_lost",
      points: SETTINGS["fault.weight.heartbeat_lost"].default,
    });
    // Later runs of the jobs add nothing.
    await world.clock.advanceBy(10 * MIN);
    expect(world.ofType("fault.detected")).toHaveLength(1);
    expect(world.ofType("fault.recorded")).toHaveLength(1);
  });

  await step("ending monitoring closes the session", async () => {
    const started = world.ofType("monitor.session_started")[0]!.payload as { sessionId: string };
    const res = await world.post(`${monitor}/sessions/${started.sessionId}/end`);
    expect(res.status).toBe(200);
    expect(world.ofType("monitor.session_ended")).toHaveLength(1);
  });

  await step("the week closes once and its review has the numbers from code", async () => {
    expect(world.types()).not.toContain("week.closed");
    await world.clock.advanceTo(WEEK_END);
    expect(world.ofType("week.closed")).toHaveLength(1);
    expect(world.ofType("review.ready")).toHaveLength(1);
    const order = world.types().filter((t) => t === "week.closed" || t === "review.ready");
    expect(order).toEqual(["week.closed", "review.ready"]);

    const review = await json(await world.get(`${schedule}/weeks/${weekId}/review`));
    expect(review.data.review.tasks).toMatchObject({ planned: 3, completed: 1 });
    expect(review.data.review.faults.totalPoints).toBe(
      SETTINGS["fault.weight.heartbeat_lost"].default,
    );
    expect(review.data.review.faults.items).toHaveLength(1);

    await world.clock.advanceBy(2 * DAY_MS);
    expect(world.ofType("week.closed")).toHaveLength(1);
    expect(world.ofType("review.ready")).toHaveLength(1);
  });

  await step("no business code read the system clock", async () => {
    const start = Date.parse(START);
    const stamped = (e: EventEnvelope) => Date.parse(e.occurredAt);
    expect(world.events.length).toBeGreaterThan(10);
    for (const e of world.events) expect(stamped(e), e.type).toBeGreaterThanOrEqual(start);
  });
});
