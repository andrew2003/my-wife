import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp } from "../src/index";
import { FakeVisionModel, InMemoryFailedPhotoStore } from "../src/wake";

const MASTER = randomBytes(32).toString("base64");
const NOW = new Date("2026-11-26T23:00:00.000Z");
const HOUR = 3_600_000;

const config = (master: string | undefined) =>
  loadConfig({
    SESSION_SECRET: "x".repeat(32),
    LOG_LEVEL: "silent",
    UI_LANGUAGE: "en",
    ...(master ? { SECRETS_MASTER_KEY: master } : {}),
  });

async function setup(opts: { settings?: Record<string, unknown>; master?: string | null } = {}) {
  const events: { name: string; payload: unknown }[] = [];
  const clock = { now: NOW };
  const failedPhotos = new InMemoryFailedPhotoStore();
  const app = await createApp(config(opts.master === null ? undefined : MASTER), {
    readSettings: async () => opts.settings ?? {},
    visionModel: new FakeVisionModel(),
    failedPhotoStore: failedPhotos,
    now: () => clock.now,
    publish: async (e) => {
      events.push(e);
    },
  });
  return { app, events, clock, failedPhotos };
}
type App = Awaited<ReturnType<typeof setup>>["app"];
const H = { "x-user-id": "u1" };
const newChallenge = async (app: App) =>
  (await app.inject({ method: "POST", url: "/wake/challenges", headers: H, payload: {} })).json()
    .data.challengeId as string;
const photo = (app: App, id: string, body: string) =>
  app.inject({
    method: "POST",
    url: `/wake/challenges/${id}/photo`,
    headers: H,
    payload: { imageBase64: Buffer.from(body).toString("base64") },
  });
const purge = (app: App) => app.inject({ method: "POST", url: "/jobs/wake-photos", payload: {} });

describe("unclear grade", () => {
  it("requests another photo and records nothing as failed", async () => {
    const { app, events, failedPhotos } = await setup();
    const id = await newChallenge(app);
    const res = await photo(app, id, "unclear:dark");
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ grade: "unclear", next: "retake" });
    expect(res.json().data.text).not.toMatch(/^ai\./);
    expect(failedPhotos.size()).toBe(0);
    expect(JSON.stringify(events)).not.toContain('"fail"');
    // the same challenge still accepts the next photo
    expect((await photo(app, id, "fine")).json().data).toMatchObject({
      grade: "pass",
      next: "done",
    });
  });

  it("stops asking after routine.wake_nudge_max unclear photos and falls back to a button", async () => {
    const { app, failedPhotos } = await setup({ settings: { "routine.wake_nudge_max": 2 } });
    const id = await newChallenge(app);
    expect((await photo(app, id, "unclear")).json().data.next).toBe("retake");
    expect((await photo(app, id, "unclear")).json().data.next).toBe("button_check_in");
    expect(failedPhotos.size()).toBe(0);
    expect((await photo(app, id, "fine")).statusCode).toBe(409);
  });
});

describe("failing photo retention", () => {
  it("keeps a failing photo encrypted until the appeal window ends, then deletes it", async () => {
    const { app, clock, failedPhotos } = await setup({
      settings: { "routine.retention.failed_wake_photo_hours": 6 },
    });
    const id = await newChallenge(app);
    const res = await photo(app, id, "fail:selfie-bytes");
    expect(res.json().data).toMatchObject({ grade: "fail", next: "done" });
    expect(failedPhotos.size()).toBe(1);
    const raw = JSON.stringify(failedPhotos.dump());
    expect(raw).not.toContain("selfie-bytes");
    expect(raw).not.toContain(Buffer.from("fail:selfie-bytes").toString("base64"));

    clock.now = new Date(NOW.getTime() + 6 * HOUR - 1);
    expect((await purge(app)).json().data.deleted).toBe(0);
    expect(failedPhotos.size()).toBe(1);

    clock.now = new Date(NOW.getTime() + 6 * HOUR);
    expect((await purge(app)).json().data.deleted).toBe(1);
    expect(failedPhotos.size()).toBe(0);
  });

  it("uses the default retention (24 hours) when the setting is invalid", async () => {
    const { app, clock, failedPhotos } = await setup({
      settings: { "routine.retention.failed_wake_photo_hours": 0 },
    });
    await photo(app, await newChallenge(app), "fail");
    clock.now = new Date(NOW.getTime() + 23 * HOUR);
    await purge(app);
    expect(failedPhotos.size()).toBe(1);
    clock.now = new Date(NOW.getTime() + 24 * HOUR);
    await purge(app);
    expect(failedPhotos.size()).toBe(0);
  });

  it("never keeps a passing or unclear photo", async () => {
    const { app, failedPhotos } = await setup();
    await photo(app, await newChallenge(app), "fine");
    await photo(app, await newChallenge(app), "unclear");
    expect(failedPhotos.size()).toBe(0);
  });

  it("keeps nothing when no encryption key is configured", async () => {
    const { app, failedPhotos } = await setup({ master: null });
    const res = await photo(app, await newChallenge(app), "fail");
    expect(res.json().data.grade).toBe("fail");
    expect(failedPhotos.size()).toBe(0);
  });

  it("deletes the user's kept photos at once when the consent is revoked", async () => {
    const { app, failedPhotos } = await setup();
    await photo(app, await newChallenge(app), "fail");
    const res = await app.inject({ method: "DELETE", url: "/wake/photos", headers: H });
    expect(res.json().data.deleted).toBe(1);
    expect(failedPhotos.size()).toBe(0);
  });
});
