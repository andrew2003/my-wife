import { afterAll, beforeAll, expect, it } from "vitest";
import {
  DISCORD_AUTHOR,
  DISCORD_CHANNEL,
  DISCORD_USER,
  TELEGRAM_CHAT,
  TELEGRAM_USER,
  startRoutinesWorld,
  type RoutinesWorld,
} from "../support/routines-world";

/**
 * Scenario 4, extended: the routines flow on simulated time, past the happy path.
 *
 * Monday 2026-12-07 and the morning after, one user per channel (Asia/Ho_Chi_Minh, default
 * bedtime 23:00, wake time 06:00, quiet hours 23:00-06:30, grace 15 minutes). The scenario sets
 * the settings it needs and reads the rest from the registry defaults.
 *
 * - Levels: starter levels, a meal at `off` never appears, a meal at `remind` only sends a
 *   message, raising wake to `commit` applies at once, lowering it waits for next week.
 * - Late-night label: web activity after bedtime sets the soft label and one reminder, no fault.
 * - Quiet hours: that reminder is held back; the wake challenge still arrives at 06:00; a normal
 *   reminder passes again when the quiet range ends.
 * - Unclear photo: asks for another photo and records nothing.
 * - Late wake at `commit`: 14 minutes late with a 15 minute grace is recorded without a fault,
 *   16 minutes late emits `routine.late_detected`.
 * Every job receives `now` from the simulator. The steps build on the state of the previous one.
 */
async function step(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    throw new Error(`step failed: ${name}`, { cause: err });
  }
}

const START = "2026-12-07T04:00:00.000Z"; // 11:00 local
const FIRST_DAY = "2026-12-07";
const MIN = 60_000;
const GRACE = 15;
const pic = (text: string) => new TextEncoder().encode(text);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = { ok: boolean; data: Record<string, any> };

const settings: Record<string, unknown> = {
  // A photo may arrive up to 30 minutes after the challenge, so lateness can pass the grace.
  "routine.wake_photo_window_minutes": 30,
  "routine.wake_grace_minutes": GRACE,
};

let world: RoutinesWorld;
beforeAll(async () => {
  world = await startRoutinesWorld({ start: START, settings, routineJobs: true });
});
afterAll(async () => {
  await world.stop();
});

const keys = (chat: "telegram" | "discord") =>
  (chat === "telegram"
    ? world.telegram.botMessages(TELEGRAM_CHAT)
    : world.discord.botMessages(DISCORD_CHANNEL)
  ).map((m) => m.text);
const at = (iso: string) => world.clock.advanceTo(iso);
const routinesOf = async (userId: string, when?: string) => {
  const url = `${world.urls.schedule}/routines${when ? `?at=${when}` : ""}`;
  const body = (await (await world.getAs(userId, url)).json()) as Json;
  return Object.fromEntries(
    (body.data.routines as { id: string; level: string }[]).map((r) => [r.id, r.level]),
  );
};
const activity = async (userId: string) =>
  ((await (await world.postAs(userId, `${world.urls.schedule}/sleep/activity`)).json()) as Json)
    .data;
const lateNightEvents = () =>
  world
    .ofType("routine.reminder_due")
    .filter(
      (e) => (e.payload as { messageKey: string }).messageKey === "routine.late_night_reminder",
    );

it("routines extended: levels, late-night label, quiet hours, unclear photo and late wake", async () => {
  await step("both users have a planned week; starter levels apply", async () => {
    for (const user of [TELEGRAM_USER, DISCORD_USER]) {
      const res = await world.postAs(user, `${world.urls.schedule}/weeks`, {
        firstDay: FIRST_DAY,
      });
      expect(res.status).toBe(200);
    }
    expect(await routinesOf(TELEGRAM_USER)).toEqual({
      sleep: "track",
      wake: "remind",
      breakfast: "track",
      lunch: "track",
      dinner: "track",
    });
  });

  await step("a meal at off never appears, a meal at remind only sends a message", async () => {
    settings["routine.lunch.level"] = "off";
    settings["routine.dinner.level"] = "remind";
    expect(await routinesOf(TELEGRAM_USER)).toMatchObject({ lunch: "off", dinner: "remind" });
    await at("2026-12-07T05:00:00.000Z"); // 12:00, inside the lunch window
    expect(keys("telegram")).toEqual([]);
    expect(keys("discord")).toEqual([]);
    await at("2026-12-07T11:31:00.000Z"); // 18:31, dinner window open
    for (const chat of ["telegram", "discord"] as const) {
      expect(keys(chat)).toEqual(["routine.meal_reminder.dinner"]);
    }
    expect(world.types()).not.toContain("routine.checkin_recorded");
    expect(world.types()).not.toContain("routine.late_detected");
  });

  await step("raising wake to commit applies at once", async () => {
    settings["routine.wake.level"] = "commit";
    const res = await world.postAs(TELEGRAM_USER, `${world.urls.schedule}/routines/level-changes`, {
      routineId: "wake",
      from: "remind",
      to: "commit",
    });
    expect(res.status).toBe(200);
    expect(world.ofType("routine.level_changed")[0]!.payload).toMatchObject({
      routine: "wake",
      from: "remind",
      to: "commit",
      effectiveFrom: "2026-12-07T11:31:00.000Z",
    });
    expect((await routinesOf(TELEGRAM_USER)).wake).toBe("commit");
  });

  await step("activity before bedtime gets no label", async () => {
    await at("2026-12-07T15:50:00.000Z"); // 22:50, after the 22:45 reminder
    for (const chat of ["telegram", "discord"] as const) {
      expect(keys(chat)).toEqual(["routine.meal_reminder.dinner", "routine.bedtime_reminder"]);
    }
    expect(await activity(DISCORD_USER)).toMatchObject({ labelled: false, label: null });
    expect(lateNightEvents()).toHaveLength(0);
  });

  await step("activity after bedtime sets the soft label and one reminder, no fault", async () => {
    await at("2026-12-07T16:10:00.000Z"); // 23:10
    expect(await activity(TELEGRAM_USER)).toMatchObject({
      labelled: true,
      label: "late_night",
      quickReasons: ["urgent_work", "cannot_sleep"],
    });
    await at("2026-12-07T16:40:00.000Z");
    expect(await activity(TELEGRAM_USER)).toMatchObject({ labelled: true, label: "late_night" });
    expect(lateNightEvents()).toHaveLength(1);
    const night = (await (
      await world.getAs(TELEGRAM_USER, `${world.urls.schedule}/sleep/night?date=${FIRST_DAY}`)
    ).json()) as Json;
    expect(night.data.night).toMatchObject({ state: "sleeping" });
    expect(night.data.night.lateNightLabelledAt).toBe("2026-12-07T16:10:00.000Z");
    for (const forbidden of ["fault.detected", "fault.recorded", "routine.late_detected"]) {
      expect(world.types()).not.toContain(forbidden);
    }
  });

  await step("quiet hours hold the reminder back and the night stays silent", async () => {
    // 23:10 is inside 23:00-06:30: the reminder waits in the inbox for a digest.
    expect(keys("telegram")).toEqual(["routine.meal_reminder.dinner", "routine.bedtime_reminder"]);
    const held = await world.inbox.pending(TELEGRAM_USER);
    expect(held.map((i) => i.message.message.key)).toEqual(["routine.late_night_reminder"]);
    await at("2026-12-07T22:59:00.000Z"); // 05:59
    expect(keys("telegram")).toHaveLength(2);
    expect(keys("discord")).toHaveLength(2);
  });

  await step("the wake challenge passes quiet hours at 06:00", async () => {
    await at("2026-12-07T23:00:00.000Z"); // 06:00, quiet until 06:30
    expect(world.ofType("routine.wake_challenge_sent")).toHaveLength(2);
    for (const chat of ["telegram", "discord"] as const) {
      expect(keys(chat)).toHaveLength(3);
      expect(keys(chat)[2]).toMatch(/^ai\.wake\.challenge\./);
    }
  });

  await step("Telegram: an unclear photo asks for another and records nothing", async () => {
    await world.clock.advanceBy(MIN); // 06:01
    world.telegram.injectPhoto(TELEGRAM_CHAT, pic("unclear: a blurry ceiling"));
    await world.pollTelegram();
    const graded = world.ofType("routine.wake_graded");
    expect(graded).toHaveLength(1);
    expect(graded[0]!.payload).toMatchObject({ grade: "unclear", wakeTime: null });
    expect(keys("telegram")[3]).toBe("routine.wake_photo_unclear");
    const wake = (await (
      await world.getAs(TELEGRAM_USER, `${world.urls.schedule}/wake/today`)
    ).json()) as Json;
    expect(wake.data.wake).toMatchObject({ state: "sent", grade: null, wakeTime: null });
    expect(world.types()).not.toContain("routine.checkin_recorded");
    expect(world.types()).not.toContain("routine.late_detected");
  });

  await step("Telegram: 14 minutes late at commit is recorded without a fault", async () => {
    await at("2026-12-07T23:14:00.000Z"); // 06:14
    world.telegram.injectPhoto(TELEGRAM_CHAT, pic("pass: a person at the sink"));
    await world.pollTelegram();
    expect(world.ofType("routine.wake_graded")[1]!.payload).toMatchObject({
      grade: "pass",
      wakeTime: "2026-12-07T23:14:00.000Z",
      minutesLate: 14,
    });
    expect(keys("telegram")[4]).toBe("routine.wake_recorded_late");
    expect(world.ofType("routine.checkin_recorded")).toHaveLength(1);
    expect(world.ofType("routine.checkin_recorded")[0]!.payload).toMatchObject({
      kind: "wake",
      minutesLate: 14,
    });
    expect(world.ofType("routine.late_detected")).toHaveLength(0);
  });

  await step("Discord: 16 minutes late at commit emits routine.late_detected", async () => {
    await at("2026-12-07T23:16:00.000Z"); // 06:16
    world.discord.injectPhoto(DISCORD_CHANNEL, DISCORD_AUTHOR, pic("pass: a person at the sink"));
    await world.drainDiscord();
    expect(world.ofType("routine.late_detected")).toHaveLength(1);
    const late = world.ofType("routine.late_detected")[0]!;
    expect(late.userId).toBe(DISCORD_USER);
    expect(late.payload).toMatchObject({
      routine: "wake",
      faultType: "wake_late",
      occurredAt: "2026-12-07T23:16:00.000Z",
      minutesLate: 16,
    });
    expect(keys("discord")[3]).toBe("routine.wake_recorded_late");
    expect(world.ofType("routine.checkin_recorded")).toHaveLength(2);
  });

  await step("a normal reminder passes again when the quiet range ends", async () => {
    await at("2026-12-07T23:29:00.000Z"); // 06:29, breakfast window not open yet
    expect(keys("telegram")).toHaveLength(5);
    await at("2026-12-07T23:30:00.000Z"); // 06:30, quiet hours end (exclusive)
    expect(keys("telegram")[5]).toBe("routine.meal_reminder.breakfast");
    expect(keys("discord")[4]).toBe("routine.meal_reminder.breakfast");
  });

  await step("lowering wake from commit waits for next week", async () => {
    settings["routine.wake.level"] = "track";
    const res = await world.postAs(TELEGRAM_USER, `${world.urls.schedule}/routines/level-changes`, {
      routineId: "wake",
      from: "commit",
      to: "track",
    });
    expect(res.status).toBe(200);
    const change = world.ofType("routine.level_changed")[1]!.payload;
    expect(change).toMatchObject({
      routine: "wake",
      from: "commit",
      to: "track",
      effectiveFrom: "2026-12-13T17:00:00.000Z", // Monday 14 December, local midnight
    });
    expect((await routinesOf(TELEGRAM_USER)).wake).toBe("commit");
    expect((await routinesOf(TELEGRAM_USER, "2026-12-13T16:59:00.000Z")).wake).toBe("commit");
    expect((await routinesOf(TELEGRAM_USER, "2026-12-13T17:00:00.000Z")).wake).toBe("track");
  });

  await step("no urgent message and no other fault came out of the whole flow", async () => {
    expect(world.types().filter((t) => t === "urgent.sent")).toHaveLength(0);
    for (const forbidden of ["fault.detected", "fault.recorded"]) {
      expect(world.types()).not.toContain(forbidden);
    }
    expect(world.ofType("routine.late_detected")).toHaveLength(1);
  });
});
