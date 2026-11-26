import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { parseEvent, type EventEnvelope } from "@my-wife/contracts";
import { createApp, createMemoryStore } from "../src/index";

const NOW = new Date("2026-01-01T00:00:00Z");
const ADMIN = { "x-user-role": "admin", "x-user-id": "admin-1" };

function setup() {
  const config = loadConfig({
    SESSION_SECRET: "s".repeat(32),
    LOG_LEVEL: "silent",
    LOGIN_METHOD: "google",
  });
  const events: EventEnvelope[] = [];
  const store = createMemoryStore();
  const clock = { now: NOW };
  const invited: { email: string; token: string }[] = [];
  const app = createApp(config, {
    store,
    now: () => clock.now,
    publish: (e) => void events.push(e),
    onInvitation: (email, token) => void invited.push({ email, token }),
    googleVerifier: async (t) => (t.startsWith("good:") ? { email: t.slice(5) } : null),
  });
  return { app, store, events, clock, invited };
}

type App = ReturnType<typeof setup>["app"];

const invite = (app: App, email: string) =>
  app.inject({ method: "POST", url: "/invitations", headers: ADMIN, payload: { email } });

const signIn = (app: App, email: string) =>
  app.inject({ method: "POST", url: "/auth/google", payload: { idToken: `good:${email}` } });

describe("sign-up events", () => {
  it("emits user.invited with the invitation id and expiry", async () => {
    const { app, events } = setup();
    const res = await invite(app, "a@x.com");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "user.invited",
      payload: {
        invitationId: res.json().data.invitation.id,
        expiresAt: "2026-01-08T00:00:00.000Z",
      },
    });
    expect(parseEvent(events[0]).success).toBe(true);
  });

  it("creates a user, a session and user.activated when the invited user signs in", async () => {
    const { app, store, events } = setup();
    await invite(app, "a@x.com");
    const res = await signIn(app, "a@x.com");
    expect(res.statusCode).toBe(200);
    const user = await store.findUserByEmail("a@x.com");
    expect(user?.state).toBe("active");
    const activated = events.filter((e) => e.type === "user.activated");
    expect(activated).toHaveLength(1);
    expect(activated[0]!.userId).toBe(user!.id);
    expect(parseEvent(activated[0]).success).toBe(true);
    const verify = await app.inject({
      method: "POST",
      url: "/sessions/verify",
      payload: { token: res.json().data.sessionToken },
    });
    expect(verify.statusCode).toBe(200);
  });

  it("emits user.activated only once, not on later sign-ins", async () => {
    const { app, events } = setup();
    await invite(app, "a@x.com");
    await signIn(app, "a@x.com");
    await signIn(app, "a@x.com");
    expect(events.filter((e) => e.type === "user.activated")).toHaveLength(1);
  });

  it("emits user.activated when an invitation is accepted", async () => {
    const { app, events, invited } = setup();
    await invite(app, "a@x.com");
    await app.inject({
      method: "POST",
      url: "/invitations/accept",
      payload: { token: invited[0]!.token },
    });
    expect(events.filter((e) => e.type === "user.activated")).toHaveLength(1);
  });

  it("refuses sign-up and emits nothing for an invitation older than its TTL", async () => {
    const { app, store, events, clock } = setup();
    await invite(app, "a@x.com");
    clock.now = new Date("2026-01-09T00:00:00Z");
    const res = await signIn(app, "a@x.com");
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("identity.not_invited");
    expect(await store.findUserByEmail("a@x.com")).toBeUndefined();
    expect(events.filter((e) => e.type === "user.activated")).toHaveLength(0);
  });

  it("honours a configured invitation TTL", async () => {
    const config = loadConfig({ SESSION_SECRET: "s".repeat(32), LOG_LEVEL: "silent" });
    const app = createApp(config, {
      now: () => NOW,
      settings: { "identity.invitation_ttl_days": 1 },
    });
    const res = await invite(app, "a@x.com");
    expect(res.json().data.invitation.expiresAt).toBe("2026-01-02T00:00:00.000Z");
  });
});

describe("persisted sessions", () => {
  it("stores the session and rejects it once revoked", async () => {
    const { app, store } = setup();
    await invite(app, "a@x.com");
    const res = await signIn(app, "a@x.com");
    const user = (await store.findUserByEmail("a@x.com"))!;
    const sessions = await store.listSessions(user.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.expiresAt).toBe(res.json().data.expiresAt);
    await store.revokeSession(sessions[0]!.id, NOW.toISOString());
    const verify = await app.inject({
      method: "POST",
      url: "/sessions/verify",
      payload: { token: res.json().data.sessionToken },
    });
    expect(verify.statusCode).toBe(401);
  });

  it("never stores the raw session token", async () => {
    const { app, store } = setup();
    await invite(app, "a@x.com");
    const res = await signIn(app, "a@x.com");
    const user = (await store.findUserByEmail("a@x.com"))!;
    const stored = JSON.stringify(await store.listSessions(user.id));
    expect(stored).not.toContain(res.json().data.sessionToken);
  });
});
