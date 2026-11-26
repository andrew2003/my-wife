import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp, createMemoryStore } from "../src/index";

const NOW = new Date("2026-01-01T00:00:00Z");
const ADMIN = { "x-user-role": "admin", "x-user-id": "admin-1" };

function setup(failing = false) {
  const config = loadConfig({
    SESSION_SECRET: "s".repeat(32),
    LOG_LEVEL: "silent",
    LOGIN_METHOD: "google",
  });
  const state = { failing };
  const events: EventEnvelope[] = [];
  const store = createMemoryStore();
  const app = createApp(config, {
    store,
    now: () => NOW,
    publish: (e) => {
      if (state.failing) throw new Error("nats down");
      events.push(e);
    },
    googleVerifier: async (t) => ({ email: t }),
  });
  return { app, store, state, events };
}

type Ctx = ReturnType<typeof setup>;
const invite = (c: Ctx) =>
  c.app.inject({
    method: "POST",
    url: "/invitations",
    headers: ADMIN,
    payload: { email: "a@x.com" },
  });
const signIn = (c: Ctx) =>
  c.app.inject({ method: "POST", url: "/auth/google", payload: { idToken: "a@x.com" } });
const count = (c: Ctx, type: string) => c.events.filter((e) => e.type === type).length;

describe("publish failures", () => {
  it("keeps the sign-in and emits user.activated on the next sign-in", async () => {
    const c = setup();
    await invite(c);
    c.state.failing = true;
    const first = await signIn(c);
    expect(first.statusCode).toBe(200);
    expect(count(c, "user.activated")).toBe(0);
    c.state.failing = false;
    expect((await signIn(c)).statusCode).toBe(200);
    expect(count(c, "user.activated")).toBe(1);
    await signIn(c);
    expect(count(c, "user.activated")).toBe(1);
  });

  it("answers 201 for an invitation when publish fails, then re-emits once on retry", async () => {
    const c = setup(true);
    const first = await invite(c);
    expect(first.statusCode).toBe(201);
    c.state.failing = false;
    const retry = await invite(c);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().data.invitation.id).toBe(first.json().data.invitation.id);
    expect(count(c, "user.invited")).toBe(1);
    expect(c.events[0]!.userId).toBe("admin-1");
    await invite(c);
    expect(count(c, "user.invited")).toBe(1);
  });
});

describe("invitation endpoint guard", () => {
  it("requires the admin user id header", async () => {
    const res = await setup().app.inject({
      method: "POST",
      url: "/invitations",
      headers: { "x-user-role": "admin" },
      payload: { email: "a@x.com" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a non-admin role", async () => {
    const res = await setup().app.inject({
      method: "POST",
      url: "/invitations",
      headers: { "x-user-role": "user", "x-user-id": "u1" },
      payload: { email: "a@x.com" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("concurrent first sign-in", () => {
  it("returns the winner's user when the email is taken at insert time", async () => {
    const c = setup();
    await invite(c);
    const real = c.store.insertUser.bind(c.store);
    c.store.insertUser = async (u) => {
      await real({ ...u, id: "winner" });
      return false;
    };
    const res = await signIn(c);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.user.id).toBe("winner");
  });
});
