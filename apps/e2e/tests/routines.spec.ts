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
 * Scenario 4: the routines happy path on simulated time, on Telegram and on Discord.
 *
 * One user per channel (Asia/Ho_Chi_Minh, the default zone: bedtime 23:00, wake time 06:00).
 * The bedtime reminder arrives once before bedtime; at wake time the bot sends a challenge; a
 * photo sent in chat is graded and confirmed back in the same chat. The wake time is the send
 * time of the photo (a hard fact), not the grade. The emulated chat servers receive locale keys
 * as text. Routines at the default level add no fault and no urgent message.
 */
async function step(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    throw new Error(`step failed: ${name}`, { cause: err });
  }
}

// 22:00 local time on Monday 7 December 2026.
const START = "2026-12-07T15:00:00.000Z";
const FIRST_DAY = "2026-12-07";
const MIN = 60_000;
const PHOTO = new TextEncoder().encode("pass: a person holding up fingers at the sink");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = { ok: boolean; data: Record<string, any> };

let world: RoutinesWorld;
beforeAll(async () => {
  world = await startRoutinesWorld({ start: START });
});
afterAll(async () => {
  await world.stop();
});

const keys = (chat: "telegram" | "discord") =>
  (chat === "telegram"
    ? world.telegram.botMessages(TELEGRAM_CHAT)
    : world.discord.botMessages(DISCORD_CHANNEL)
  ).map((m) => m.text);
const wakeOf = async (userId: string) =>
  ((await (await world.getAs(userId, `${world.urls.schedule}/wake/today`)).json()) as Json).data
    .wake;
const at = (iso: string) => world.clock.advanceTo(iso);

it("routines: bedtime reminder, wake challenge, photo and confirmation on both channels", async () => {
  await step("both users have a planned week, so the jobs consider them", async () => {
    for (const user of [TELEGRAM_USER, DISCORD_USER]) {
      const res = await world.postAs(user, `${world.urls.schedule}/weeks`, {
        firstDay: FIRST_DAY,
      });
      expect(res.status).toBe(200);
    }
    await world.clock.advanceBy(MIN);
    expect(keys("telegram")).toEqual([]);
    expect(keys("discord")).toEqual([]);
  });

  await step("no reminder goes out before the lead time", async () => {
    await at("2026-12-07T15:44:00.000Z"); // 22:44, one minute before the 15 minute lead
    expect(world.types()).not.toContain("routine.reminder_due");
    expect(keys("telegram")).toEqual([]);
  });

  await step("the bedtime reminder reaches each chat once", async () => {
    await at("2026-12-07T15:46:00.000Z");
    expect(world.ofType("routine.reminder_due")).toHaveLength(2);
    expect(keys("telegram")).toEqual(["routine.bedtime_reminder"]);
    expect(keys("discord")).toEqual(["routine.bedtime_reminder"]);
    const night = (await (
      await world.getAs(TELEGRAM_USER, `${world.urls.schedule}/sleep/night?date=${FIRST_DAY}`)
    ).json()) as Json;
    expect(night.data.night.state).toBe("bedtime_reminded");
    await at("2026-12-07T16:30:00.000Z"); // past 23:00
    const after = (await (
      await world.getAs(TELEGRAM_USER, `${world.urls.schedule}/sleep/night?date=${FIRST_DAY}`)
    ).json()) as Json;
    expect(after.data.night.state).toBe("sleeping");
    expect(world.ofType("routine.reminder_due")).toHaveLength(2);
    expect(keys("telegram")).toHaveLength(1);
  });

  await step("the night is quiet until the wake time", async () => {
    await at("2026-12-07T22:59:00.000Z"); // 05:59
    expect(world.types()).not.toContain("routine.wake_challenge_sent");
    expect(keys("telegram")).toHaveLength(1);
    expect(keys("discord")).toHaveLength(1);
  });

  await step("at wake time each chat gets a challenge", async () => {
    await at("2026-12-07T23:00:00.000Z"); // 06:00
    expect(world.ofType("routine.wake_challenge_sent")).toHaveLength(2);
    for (const chat of ["telegram", "discord"] as const) {
      expect(keys(chat)).toHaveLength(2);
      expect(keys(chat)[1]).toMatch(/^ai\.wake\.challenge\./);
    }
    for (const user of [TELEGRAM_USER, DISCORD_USER]) {
      expect(await wakeOf(user)).toMatchObject({ state: "sent", grade: null, wakeTime: null });
    }
  });

  await step("Discord: a photo at once is graded and confirmed on time", async () => {
    world.discord.injectPhoto(DISCORD_CHANNEL, DISCORD_AUTHOR, PHOTO);
    await world.drainDiscord();
    expect(world.ofType("routine.wake_photo_received")).toHaveLength(1);
    expect(world.ofType("ai.photo_graded")).toHaveLength(1);
    const graded = world.ofType("routine.wake_graded")[0]!.payload;
    expect(graded).toMatchObject({
      grade: "pass",
      wakeTime: "2026-12-07T23:00:00.000Z",
      minutesLate: 0,
    });
    expect(keys("discord")).toHaveLength(3);
    expect(keys("discord")[2]).toBe("routine.wake_recorded");
    expect(await wakeOf(DISCORD_USER)).toMatchObject({
      state: "graded",
      grade: "pass",
      wakeTime: "2026-12-07T23:00:00.000Z",
      minutesLate: 0,
    });
  });

  await step("Telegram: a photo two minutes later is confirmed with the lateness", async () => {
    await world.clock.advanceBy(2 * MIN);
    world.telegram.injectPhoto(TELEGRAM_CHAT, PHOTO);
    await world.pollTelegram();
    expect(world.ofType("routine.wake_photo_received")).toHaveLength(2);
    const graded = world.ofType("routine.wake_graded");
    expect(graded).toHaveLength(2);
    expect(graded[1]!.payload).toMatchObject({
      grade: "pass",
      wakeTime: "2026-12-07T23:02:00.000Z",
      minutesLate: 2,
    });
    expect(keys("telegram")).toHaveLength(3);
    expect(keys("telegram")[2]).toBe("routine.wake_recorded_late");
    expect(await wakeOf(TELEGRAM_USER)).toMatchObject({ minutesLate: 2 });
  });

  await step("a graded day stays closed and adds no fault, no urgent message", async () => {
    await world.clock.advanceBy(30 * MIN);
    expect(world.ofType("routine.wake_challenge_sent")).toHaveLength(2);
    expect(world.ofType("routine.wake_graded")).toHaveLength(2);
    for (const forbidden of ["fault.detected", "fault.recorded", "routine.late_detected"]) {
      expect(world.types()).not.toContain(forbidden);
    }
    expect(world.types().filter((t) => t === "urgent.sent")).toHaveLength(0);
    expect(keys("telegram")).toHaveLength(3);
    expect(keys("discord")).toHaveLength(3);
  });

  await step(
    "the photo never appears in an event and no business code read the clock",
    async () => {
      const start = Date.parse(START);
      expect(world.events.length).toBeGreaterThan(8);
      const text = JSON.stringify(world.events);
      expect(text).not.toContain(Buffer.from(PHOTO).toString("base64"));
      for (const e of world.events)
        expect(Date.parse(e.occurredAt), e.type).toBeGreaterThanOrEqual(start);
    },
  );
});
