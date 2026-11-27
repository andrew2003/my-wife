import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp, createMemoryStore } from "../src/index";

const ADMIN = { "x-user-id": "admin1", "x-user-role": "admin" };
const USER = { "x-user-id": "u1", "x-user-role": "user" };
const OTHER = { "x-user-id": "u2", "x-user-role": "user" };
const NOW = new Date("2026-11-27T10:00:00Z");

function setup() {
  const events: EventEnvelope[] = [];
  const app = createApp(loadConfig({ SESSION_SECRET: "s".repeat(32), LOG_LEVEL: "silent" }), {
    store: createMemoryStore(),
    now: () => NOW,
    publish: (e) => void events.push(e),
  });
  const set = (payload: Record<string, unknown>, headers: Record<string, string> = ADMIN) =>
    app.inject({ method: "PUT", url: "/admin/feature-flags", headers, payload });
  const check = (flag: string, headers: Record<string, string> = USER) =>
    app.inject({ method: "GET", url: `/feature-flags/${flag}/check`, headers });
  return { app, events, set, check };
}

describe("feature flags per user", () => {
  it("is enabled by default", async () => {
    const { check } = setup();
    const res = await check("camera_supervision");
    expect(res.json().data).toMatchObject({ flag: "camera_supervision", enabled: true });
    expect(res.json().data.noticeKey).toBeUndefined();
  });

  it("makes a disabled feature unavailable on the next request with a notice", async () => {
    const { set, check } = setup();
    const res = await set({ userId: "u1", flag: "camera_supervision", enabled: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.flag).toEqual({
      userId: "u1",
      flag: "camera_supervision",
      enabled: false,
    });
    const next = await check("camera_supervision");
    expect(next.json().data).toEqual({
      flag: "camera_supervision",
      enabled: false,
      noticeKey: "feature.disabled.camera_supervision",
    });
  });

  it("affects only that user and that flag", async () => {
    const { set, check } = setup();
    await set({ userId: "u1", flag: "sync", enabled: false });
    expect((await check("sync", OTHER)).json().data.enabled).toBe(true);
    expect((await check("wake_photo")).json().data.enabled).toBe(true);
  });

  it("re-enables a feature", async () => {
    const { set, check } = setup();
    await set({ userId: "u1", flag: "sync", enabled: false });
    await set({ userId: "u1", flag: "sync", enabled: true });
    expect((await check("sync")).json().data.enabled).toBe(true);
  });

  it("lists the caller's flags with notices for the disabled ones", async () => {
    const { app, set } = setup();
    await set({ userId: "u1", flag: "wake_photo", enabled: false });
    const res = await app.inject({ method: "GET", url: "/feature-flags", headers: USER });
    expect(res.json().data.flags).toEqual({
      camera_supervision: true,
      wake_photo: false,
      sync: true,
      email_ingest: true,
    });
    expect(res.json().data.notices).toEqual(["feature.disabled.wake_photo"]);
  });

  it("announces the change and audits it without personal content", async () => {
    const { app, set, events } = setup();
    await set({ userId: "u1", flag: "email_ingest", enabled: false });
    const ev = events.filter((e) => e.type === "feature_flag.changed");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      userId: "u1",
      payload: { flag: "email_ingest", enabled: false },
    });
    const res = await app.inject({ method: "GET", url: "/admin/audit", headers: ADMIN });
    const audit = res.json().data.entries;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: "admin1",
      action: "feature_flag.changed",
      targetId: "u1",
      before: { flag: "email_ingest", enabled: true },
      after: { flag: "email_ingest", enabled: false },
    });
  });

  it("rejects non-admins and invalid input", async () => {
    const { set, check } = setup();
    expect((await set({ userId: "u1", flag: "sync", enabled: false }, USER)).statusCode).toBe(403);
    expect((await set({ userId: "u1", flag: "nope", enabled: false })).statusCode).toBe(400);
    expect((await check("nope")).statusCode).toBe(400);
    expect((await check("sync", {})).statusCode).toBe(401);
  });
});
