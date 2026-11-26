import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };
const CID = "7b0f6f58-0c52-4a3c-9a43-2a0f4b1b9a11";

// Defaults: wake 06:00 local (UTC+7 = 23:00Z the day before), photo window 10 minutes.
async function setup(settings: Record<string, unknown> = {}) {
  const events: EventEnvelope[] = [];
  const requests: { userId: string; key: string; challengeId: string }[] = [];
  const replies: { userId: string; key: string; params: Record<string, unknown> }[] = [];
  const app = await createApp(config, {
    publish: (e: EventEnvelope) => void events.push(e),
    readSettings: async () => settings,
    generateWakeChallenge: async () => ({
      challengeId: CID,
      key: "routine.wake_challenge.sink",
      params: {},
    }),
    sendPhotoRequest: async (userId, message, challengeId) => {
      requests.push({ userId, key: message.key, challengeId });
    },
    sendReply: async (userId, message) => {
      replies.push({ userId, key: message.key, params: message.params });
    },
  });
  await app.inject({
    method: "POST",
    url: "/weeks",
    headers: H,
    payload: { firstDay: "2026-11-23" },
  });
  const ofType = (t: string) => events.filter((e) => e.type === t);
  const photo = async (sentAt: string) =>
    (
      await app.inject({
        method: "POST",
        url: "/wake/photos",
        headers: H,
        payload: { challengeId: CID, sentAt },
      })
    ).json();
  const graded = async (grade: string, gradedAt = "2026-11-23T23:03:00.000Z") =>
    app.inject({
      method: "POST",
      url: "/events/photo-graded",
      payload: {
        id: `g-${grade}-${gradedAt}`,
        type: "ai.photo_graded",
        occurredAt: gradedAt,
        userId: "u1",
        schemaVersion: 1,
        payload: { challengeId: CID, grade, gradedAt },
      },
    });
  return { app, events, requests, replies, ofType, photo, graded };
}

describe("wake photo flow", () => {
  it("sends the daily challenge at wake time and emits routine.wake_challenge_sent", async () => {
    const { app, requests, ofType } = await setup();
    await app.runWakeJob(new Date("2026-11-23T22:59:00.000Z"));
    expect(requests).toHaveLength(0);
    await app.runWakeJob(new Date("2026-11-23T23:00:00.000Z"));
    await app.runWakeJob(new Date("2026-11-23T23:02:00.000Z"));
    expect(requests).toEqual([
      { userId: "u1", key: "routine.wake_challenge.sink", challengeId: CID },
    ]);
    expect(ofType("routine.wake_challenge_sent")).toHaveLength(1);
    expect(ofType("routine.wake_challenge_sent")[0]!.payload).toEqual({
      challengeId: CID,
      sentAt: "2026-11-23T23:00:00.000Z",
    });
  });

  it("emits nothing when the send fails and retries next run", async () => {
    const events: EventEnvelope[] = [];
    let fail = true;
    const app = await createApp(config, {
      publish: (e: EventEnvelope) => void events.push(e),
      generateWakeChallenge: async () => ({ challengeId: CID, key: "k", params: {} }),
      sendPhotoRequest: async () => {
        if (fail) throw new Error("down");
      },
    });
    await app.inject({
      method: "POST",
      url: "/weeks",
      headers: H,
      payload: { firstDay: "2026-11-23" },
    });
    const first = await app.runWakeJob(new Date("2026-11-23T23:01:00.000Z"));
    expect(first.failed).toEqual(["u1"]);
    expect(events.filter((e) => e.type === "routine.wake_challenge_sent")).toHaveLength(0);
    fail = false;
    await app.runWakeJob(new Date("2026-11-23T23:02:00.000Z"));
    expect(events.filter((e) => e.type === "routine.wake_challenge_sent")).toHaveLength(1);
  });

  it("does nothing when the wake routine is off", async () => {
    const { app, requests } = await setup({ "routine.wake.level": "off" });
    await app.runWakeJob(new Date("2026-11-23T23:01:00.000Z"));
    expect(requests).toHaveLength(0);
  });

  it("emits routine.wake_photo_received with the send time for a photo inside the window", async () => {
    const { app, ofType, photo } = await setup();
    await app.runWakeJob(new Date("2026-11-23T23:00:00.000Z"));
    const res = await photo("2026-11-23T23:09:59.000Z");
    expect(res.data.accepted).toBe(true);
    expect(res.data.challengeKey).toBe("routine.wake_challenge.sink");
    expect(ofType("routine.wake_photo_received")[0]!.payload).toEqual({
      challengeId: CID,
      receivedAt: "2026-11-23T23:09:59.000Z",
    });
  });

  it("reads the window length from settings", async () => {
    const { app, ofType, photo } = await setup({ "routine.wake_photo_window_minutes": 3 });
    await app.runWakeJob(new Date("2026-11-23T23:00:00.000Z"));
    expect((await photo("2026-11-23T23:04:00.000Z")).data.accepted).toBe(false);
    expect(ofType("routine.wake_photo_received")).toHaveLength(0);
  });

  it("does not accept a photo after the window and replies in plain words", async () => {
    const { app, replies, ofType, photo } = await setup();
    await app.runWakeJob(new Date("2026-11-23T23:00:00.000Z"));
    const res = await photo("2026-11-23T23:10:01.000Z");
    expect(res.data.accepted).toBe(false);
    expect(replies.map((r) => r.key)).toEqual(["routine.wake_photo_late"]);
    expect(ofType("routine.wake_photo_received")).toHaveLength(0);
    expect(ofType("routine.wake_graded")).toHaveLength(0);
  });

  it("records the send time of a passing photo as the wake time", async () => {
    const { app, replies, ofType, photo, graded } = await setup();
    await app.runWakeJob(new Date("2026-11-23T23:00:00.000Z"));
    await photo("2026-11-23T23:02:00.000Z");
    expect((await graded("pass")).statusCode).toBe(200);
    expect(ofType("routine.wake_graded")[0]!.payload).toEqual({
      challengeId: CID,
      grade: "pass",
      wakeTime: "2026-11-23T23:02:00.000Z",
      minutesLate: 2,
    });
    expect(replies.at(-1)!.key).toBe("routine.wake_recorded_late");
  });

  it("replies on time when the photo is sent at the wake minute", async () => {
    const { app, replies, photo, graded } = await setup();
    await app.runWakeJob(new Date("2026-11-23T23:00:00.000Z"));
    await photo("2026-11-23T23:00:30.000Z");
    await graded("pass");
    expect(replies.at(-1)).toMatchObject({
      key: "routine.wake_recorded",
      params: { time: "06:00" },
    });
  });

  it("reports minutes late relative to the wake time", async () => {
    const { app, replies, ofType, photo, graded } = await setup({
      "routine.wake_photo_window_minutes": 30,
    });
    await app.runWakeJob(new Date("2026-11-23T23:00:00.000Z"));
    await photo("2026-11-23T23:14:30.000Z");
    await graded("pass");
    const payload = ofType("routine.wake_graded")[0]!.payload as { minutesLate: number };
    expect(payload.minutesLate).toBe(14);
    expect(replies.at(-1)!.params).toMatchObject({ minutes: 14 });
  });

  it("asks for another photo on unclear and records nothing", async () => {
    const { app, replies, ofType, photo, graded } = await setup();
    await app.runWakeJob(new Date("2026-11-23T23:00:00.000Z"));
    await photo("2026-11-23T23:02:00.000Z");
    await graded("unclear");
    expect(replies.at(-1)!.key).toBe("routine.wake_photo_unclear");
    expect(
      ofType("routine.wake_graded").every(
        (e) => (e.payload as { wakeTime: unknown }).wakeTime === null,
      ),
    ).toBe(true);
    // A second photo is accepted and its own send time becomes the wake time.
    expect((await photo("2026-11-23T23:05:00.000Z")).data.accepted).toBe(true);
    await graded("pass", "2026-11-23T23:06:00.000Z");
    const last = ofType("routine.wake_graded").at(-1)!.payload as { wakeTime: string };
    expect(last.wakeTime).toBe("2026-11-23T23:05:00.000Z");
  });

  it("records no wake time for a failed photo", async () => {
    const { app, replies, ofType, photo, graded } = await setup();
    await app.runWakeJob(new Date("2026-11-23T23:00:00.000Z"));
    await photo("2026-11-23T23:02:00.000Z");
    await graded("fail");
    expect(ofType("routine.wake_graded")[0]!.payload).toMatchObject({
      grade: "fail",
      wakeTime: null,
      minutesLate: null,
    });
    expect(replies.at(-1)!.key).toBe("routine.wake_photo_failed");
  });

  it("handles a repeated ai.photo_graded delivery once", async () => {
    const { app, ofType, photo, graded } = await setup();
    await app.runWakeJob(new Date("2026-11-23T23:00:00.000Z"));
    await photo("2026-11-23T23:02:00.000Z");
    await graded("pass");
    await graded("pass");
    expect(ofType("routine.wake_graded")).toHaveLength(1);
  });

  it("rejects a photo for an unknown challenge", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/wake/photos",
      headers: H,
      payload: { challengeId: CID, sentAt: "2026-11-23T23:02:00.000Z" },
    });
    expect(res.statusCode).toBe(404);
  });
});
