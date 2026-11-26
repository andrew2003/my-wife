import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { aiEvents } from "@my-wife/contracts";
import { createApp } from "../src/index";
import { createVisionModel, FakeVisionModel, type VisionModel } from "../src/wake";

const config = loadConfig({
  SESSION_SECRET: "x".repeat(32),
  LOG_LEVEL: "silent",
  UI_LANGUAGE: "en",
});
const NOW = new Date("2026-11-26T23:00:00.000Z");

async function setup(
  opts: {
    vision?: VisionModel;
    settings?: Record<string, unknown>;
    consent?: boolean;
    clock?: { now: Date };
  } = {},
) {
  const events: { name: string; payload: unknown }[] = [];
  const clock = opts.clock ?? { now: NOW };
  const app = await createApp(config, {
    readSettings: async () => opts.settings ?? {},
    visionModel: opts.vision ?? new FakeVisionModel(),
    hasWakePhotoConsent: async () => opts.consent ?? true,
    now: () => clock.now,
    publish: async (e) => {
      events.push(e);
    },
  });
  return { app, events, clock };
}
type App = Awaited<ReturnType<typeof setup>>["app"];
const challenge = async (app: App, user = "u1") =>
  app.inject({
    method: "POST",
    url: "/wake/challenges",
    headers: { "x-user-id": user },
    payload: {},
  });
const photo = (app: App, id: string, bytes: Buffer, user = "u1") =>
  app.inject({
    method: "POST",
    url: `/wake/challenges/${id}/photo`,
    headers: { "x-user-id": user },
    payload: { imageBase64: bytes.toString("base64") },
  });

describe("wake challenge", () => {
  it("creates a challenge with a rendered request and an expiry from the window setting", async () => {
    const { app } = await setup({ settings: { "routine.wake_photo_window_minutes": 15 } });
    const res = await challenge(app);
    expect(res.statusCode).toBe(201);
    const body = res.json().data;
    expect(body.challengeId).toBeTruthy();
    expect(body.text).not.toMatch(/^ai\./);
    expect(body.expiresAt).toBe("2026-11-26T23:15:00.000Z");
  });

  it("uses the default window when the setting is invalid", async () => {
    const { app } = await setup({ settings: { "routine.wake_photo_window_minutes": -3 } });
    const body = (await challenge(app)).json().data;
    expect(body.expiresAt).toBe("2026-11-26T23:10:00.000Z");
  });

  it("refuses a challenge without the wake_photo consent", async () => {
    const { app } = await setup({ consent: false });
    expect((await challenge(app)).statusCode).toBe(403);
  });
});

describe("photo grading", () => {
  it.each([
    ["pass", "ok-photo"],
    ["fail", "fail:bed"],
    ["unclear", "unclear:dark"],
  ])("emits ai.photo_graded with %s", async (grade, content) => {
    const { app, events } = await setup();
    const id = (await challenge(app)).json().data.challengeId;
    const res = await photo(app, id, Buffer.from(content));
    expect(res.statusCode).toBe(200);
    expect(res.json().data.grade).toBe(grade);
    const graded = events.filter((e) => e.name === "ai.photo_graded");
    expect(graded).toHaveLength(1);
    const payload = aiEvents["ai.photo_graded"].parse(graded[0]?.payload);
    expect(payload).toEqual({ challengeId: id, grade, gradedAt: NOW.toISOString() });
  });

  it("deletes the image after grading and never keeps it in the response or event", async () => {
    let seen: Buffer | undefined;
    const vision: VisionModel = {
      async grade(input) {
        seen = input.image;
        return "pass";
      },
    };
    const { app, events } = await setup({ vision });
    const id = (await challenge(app)).json().data.challengeId;
    const bytes = Buffer.from("secret-image-bytes");
    const res = await photo(app, id, bytes);
    expect(seen?.every((b) => b === 0)).toBe(true);
    const dump = JSON.stringify([res.body, events]);
    expect(dump).not.toContain(bytes.toString("base64"));
    expect(dump).not.toContain("secret-image-bytes");
  });

  it("deletes the image even when the vision model fails, and emits nothing", async () => {
    let seen: Buffer | undefined;
    const vision: VisionModel = {
      async grade(input) {
        seen = input.image;
        throw new Error("boom");
      },
    };
    const { app, events } = await setup({ vision });
    const id = (await challenge(app)).json().data.challengeId;
    const res = await photo(app, id, Buffer.from("img"));
    expect(res.statusCode).toBe(502);
    expect(seen?.every((b) => b === 0)).toBe(true);
    expect(events).toHaveLength(0);
  });

  it("unclear keeps the challenge open for another photo; pass closes it", async () => {
    const { app, events } = await setup();
    const id = (await challenge(app)).json().data.challengeId;
    expect((await photo(app, id, Buffer.from("unclear"))).json().data.grade).toBe("unclear");
    expect((await photo(app, id, Buffer.from("fine"))).json().data.grade).toBe("pass");
    expect((await photo(app, id, Buffer.from("fine"))).statusCode).toBe(409);
    expect(events.filter((e) => e.name === "ai.photo_graded")).toHaveLength(2);
  });

  it("rejects an empty photo, unknown challenge, other user and a photo after the window", async () => {
    const { app, events, clock } = await setup();
    const id = (await challenge(app)).json().data.challengeId;
    expect((await photo(app, id, Buffer.alloc(0))).statusCode).toBe(400);
    expect((await photo(app, "nope", Buffer.from("x"))).statusCode).toBe(404);
    expect((await photo(app, id, Buffer.from("x"), "u2")).statusCode).toBe(404);
    clock.now = new Date(NOW.getTime() + 11 * 60_000);
    expect((await photo(app, id, Buffer.from("x"))).statusCode).toBe(410);
    expect(events).toHaveLength(0);
  });
});

describe("M1 vision model", () => {
  it("uses the fake vision model by default and has no real provider before M4", () => {
    expect(createVisionModel()).toBeInstanceOf(FakeVisionModel);
    expect(() => createVisionModel("openai")).toThrow(/M4/);
  });
});
