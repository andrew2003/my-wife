import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp, type IdentityDeps } from "../src/index";

const NOW = new Date("2026-01-01T00:00:00Z");
const ADMIN = { "x-user-role": "admin" };

function setup(loginMethod: "google" | "magic_link", extra: Partial<IdentityDeps> = {}) {
  const config = loadConfig({
    SESSION_SECRET: "s".repeat(32),
    LOG_LEVEL: "silent",
    LOGIN_METHOD: loginMethod,
  });
  const clock = { now: NOW };
  const sent: { email: string; token: string }[] = [];
  const invited: { email: string; token: string }[] = [];
  const app = createApp(config, {
    now: () => clock.now,
    onMagicLink: (email, token) => void sent.push({ email, token }),
    onInvitation: (email, token) => void invited.push({ email, token }),
    googleVerifier: async (idToken) =>
      idToken.startsWith("good:") ? { email: idToken.slice(5) } : null,
    ...extra,
  });
  return { app, clock, sent, invited };
}

async function invite(app: ReturnType<typeof setup>["app"], email: string) {
  return app.inject({ method: "POST", url: "/invitations", headers: ADMIN, payload: { email } });
}

describe("invitations", () => {
  it("refuses to create an invitation without the admin role", async () => {
    const { app } = setup("google");
    const res = await app.inject({
      method: "POST",
      url: "/invitations",
      payload: { email: "a@x.com" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("creates an invitation that expires after identity.invitation_ttl_days", async () => {
    const { app, invited } = setup("google");
    const res = await invite(app, "a@x.com");
    expect(res.statusCode).toBe(201);
    expect(res.json().data.invitation.expiresAt).toBe("2026-01-08T00:00:00.000Z");
    expect(invited).toHaveLength(1);
    expect(JSON.stringify(res.json())).not.toContain(invited[0]!.token);
  });

  it("accepts an invitation token once and creates an active user", async () => {
    const { app, invited } = setup("google");
    await invite(app, "a@x.com");
    const token = invited[0]!.token;
    const ok = await app.inject({ method: "POST", url: "/invitations/accept", payload: { token } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.user).toMatchObject({ email: "a@x.com", state: "active", role: "user" });
    const again = await app.inject({
      method: "POST",
      url: "/invitations/accept",
      payload: { token },
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe("identity.invitation_invalid");
  });

  it("rejects an expired invitation", async () => {
    const { app, clock, invited } = setup("google");
    await invite(app, "a@x.com");
    clock.now = new Date("2026-02-01T00:00:00Z");
    const res = await app.inject({
      method: "POST",
      url: "/invitations/accept",
      payload: { token: invited[0]!.token },
    });
    expect(res.json().error.code).toBe("identity.invitation_invalid");
  });

  it("stops creating users beyond identity.max_users", async () => {
    const { app, invited } = setup("google", { settings: { "identity.max_users": 1 } });
    await invite(app, "a@x.com");
    await invite(app, "b@x.com");
    const first = await app.inject({
      method: "POST",
      url: "/invitations/accept",
      payload: { token: invited[0]!.token },
    });
    const second = await app.inject({
      method: "POST",
      url: "/invitations/accept",
      payload: { token: invited[1]!.token },
    });
    expect(first.statusCode).toBe(200);
    expect(second.json().error.code).toBe("identity.user_limit_reached");
  });
});

describe("LOGIN_METHOD=google", () => {
  it("rejects an email that was never invited", async () => {
    const { app } = setup("google");
    const res = await app.inject({
      method: "POST",
      url: "/auth/google",
      payload: { idToken: "good:x@x.com" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("identity.not_invited");
  });

  it("rejects an invalid Google token", async () => {
    const { app } = setup("google");
    const res = await app.inject({
      method: "POST",
      url: "/auth/google",
      payload: { idToken: "bad" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("signs up an invited email, then lets the user sign in again", async () => {
    const { app } = setup("google");
    await invite(app, "a@x.com");
    const first = await app.inject({
      method: "POST",
      url: "/auth/google",
      payload: { idToken: "good:a@x.com" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.user.email).toBe("a@x.com");
    expect(first.json().data.expiresAt).toBe("2026-01-31T00:00:00.000Z");
    const second = await app.inject({
      method: "POST",
      url: "/auth/google",
      payload: { idToken: "good:a@x.com" },
    });
    expect(second.statusCode).toBe(200);
  });

  it("disables the magic link endpoints", async () => {
    const { app } = setup("google");
    const res = await app.inject({
      method: "POST",
      url: "/auth/magic-link",
      payload: { email: "a@x.com" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("identity.method_disabled");
  });
});

describe("LOGIN_METHOD=magic_link", () => {
  it("answers 202 for unknown emails without sending a link", async () => {
    const { app, sent } = setup("magic_link");
    const res = await app.inject({
      method: "POST",
      url: "/auth/magic-link",
      payload: { email: "z@x.com" },
    });
    expect(res.statusCode).toBe(202);
    expect(sent).toHaveLength(0);
  });

  it("sends a link to an invited email and verifies it once", async () => {
    const { app, sent } = setup("magic_link");
    await invite(app, "a@x.com");
    await app.inject({ method: "POST", url: "/auth/magic-link", payload: { email: "a@x.com" } });
    expect(sent).toHaveLength(1);
    const token = sent[0]!.token;
    const ok = await app.inject({
      method: "POST",
      url: "/auth/magic-link/verify",
      payload: { token },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.user.email).toBe("a@x.com");
    const again = await app.inject({
      method: "POST",
      url: "/auth/magic-link/verify",
      payload: { token },
    });
    expect(again.statusCode).toBe(400);
  });

  it("expires a link after identity.magic_link_ttl_minutes", async () => {
    const { app, clock, sent } = setup("magic_link");
    await invite(app, "a@x.com");
    await app.inject({ method: "POST", url: "/auth/magic-link", payload: { email: "a@x.com" } });
    clock.now = new Date("2026-01-01T00:16:00Z");
    const res = await app.inject({
      method: "POST",
      url: "/auth/magic-link/verify",
      payload: { token: sent[0]!.token },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("identity.link_invalid");
  });

  it("disables the Google endpoint", async () => {
    const { app } = setup("magic_link");
    const res = await app.inject({
      method: "POST",
      url: "/auth/google",
      payload: { idToken: "good:a@x.com" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("sessions", () => {
  it("validates an issued session token and rejects a tampered one", async () => {
    const { app } = setup("google");
    await invite(app, "a@x.com");
    const login = await app.inject({
      method: "POST",
      url: "/auth/google",
      payload: { idToken: "good:a@x.com" },
    });
    const { sessionToken } = login.json().data;
    const ok = await app.inject({
      method: "POST",
      url: "/sessions/verify",
      payload: { token: sessionToken },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.user.email).toBe("a@x.com");
    const bad = await app.inject({
      method: "POST",
      url: "/sessions/verify",
      payload: { token: sessionToken.slice(0, -2) + "xx" },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("bootstraps the configured admin email without an invitation", async () => {
    const { app } = setup("google", { bootstrapAdminEmail: "root@x.com" });
    const res = await app.inject({
      method: "POST",
      url: "/auth/google",
      payload: { idToken: "good:root@x.com" },
    });
    expect(res.json().data.user.role).toBe("admin");
  });
});
