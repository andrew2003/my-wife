import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import {
  AcceptInvitationRequestSchema,
  GetSettingsResponseSchema,
  SessionResponseSchema,
} from "@my-wife/contracts";
import { createApp, SESSION_COOKIE } from "../src/index";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const user = {
  id: "u1",
  email: "a@example.com",
  role: "user",
  state: "active",
  locale: "vi",
  lastSeenAt: null,
};
const session = { ok: true, data: { user, expiresAt: "2026-02-01T00:00:00.000Z" } };

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
function setup() {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body as string | undefined,
    });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url === "http://identity/sessions/verify") {
      const token = JSON.parse(String(init.body)).token;
      return token === "good"
        ? json(200, session)
        : json(401, { ok: false, error: { code: "identity.invalid_session" } });
    }
    if (url.startsWith("http://schedule/")) return json(200, { ok: true, data: { sched: 1 } });
    if (url.startsWith("http://budget/")) return json(201, { ok: true, data: { raw: 1 } });
    if (url === "http://identity/settings") return json(200, { ok: true, data: { values: {} } });
    if (url === "http://identity/invitations/accept")
      return json(200, { ok: true, data: { user } });
    return json(404, { ok: false, error: { code: "x" } });
  }) as unknown as typeof fetch;
  const app = createApp(
    config,
    {},
    {
      fetch: fetchFn,
      upstreams: {
        identity: "http://identity",
        budget: "http://budget",
        schedule: "http://schedule",
      },
    },
  );
  return { app, calls };
}

describe("gateway session proxy", () => {
  it("serves GET /api/me from identity for a valid session", async () => {
    const { app } = setup();
    const res = await (
      await app
    ).inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: `${SESSION_COOKIE}=good` },
    });
    expect(res.statusCode).toBe(200);
    expect(SessionResponseSchema.safeParse(res.json()).success).toBe(true);
  });

  it("returns 401 envelope and forwards nothing without a session", async () => {
    const { app, calls } = setup();
    const res = await (await app).inject({ method: "GET", url: "/api/settings" });
    expect(res.statusCode).toBe(401);
    expect(GetSettingsResponseSchema.safeParse(res.json()).success).toBe(true);
    expect(res.json().ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("rejects an invalid session without forwarding the request", async () => {
    const { app, calls } = setup();
    const res = await (
      await app
    ).inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie: `${SESSION_COOKIE}=bad` },
    });
    expect(res.statusCode).toBe(401);
    expect(calls.map((c) => c.url)).toEqual(["http://identity/sessions/verify"]);
  });

  it("forwards identity routes with the user id", async () => {
    const { app, calls } = setup();
    const res = await (
      await app
    ).inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie: `${SESSION_COOKIE}=good` },
    });
    expect(GetSettingsResponseSchema.safeParse(res.json()).success).toBe(true);
    expect(calls[1]?.headers["x-user-id"]).toBe("u1");
    expect(calls[1]?.headers.cookie).toBeUndefined();
  });

  it("forwards budget routes with the user id and returns the response unchanged", async () => {
    const { app, calls } = setup();
    const res = await (
      await app
    ).inject({
      method: "POST",
      url: "/api/budget/cycles",
      headers: { cookie: `${SESSION_COOKIE}=good`, "content-type": "application/json" },
      payload: { weeks: 4 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true, data: { raw: 1 } });
    expect(calls[1]).toMatchObject({
      url: "http://budget/budget/cycles",
      method: "POST",
      headers: { "x-user-id": "u1" },
    });
    expect(JSON.parse(calls[1]!.body!)).toEqual({ weeks: 4 });
  });

  it("forwards checklist and task routes to schedule with the user id", async () => {
    const { app, calls } = setup();
    const headers = { cookie: `${SESSION_COOKIE}=good`, "content-type": "application/json" };
    const get = await (
      await app
    ).inject({ method: "GET", url: "/api/checklist?date=2026-11-26", headers });
    expect(get.json()).toEqual({ ok: true, data: { sched: 1 } });
    expect(calls[1]).toMatchObject({
      url: "http://schedule/checklist?date=2026-11-26",
      headers: { "x-user-id": "u1" },
    });
    await (
      await app
    ).inject({ method: "POST", url: "/api/tasks/complete", headers, payload: { taskId: "t" } });
    expect(calls.at(-1)).toMatchObject({ url: "http://schedule/tasks/complete", method: "POST" });
  });

  it("forwards session routes to schedule with the user id", async () => {
    const { app, calls } = setup();
    const headers = { cookie: `${SESSION_COOKIE}=good` };
    await (await app).inject({ method: "GET", url: "/api/sessions/active?taskId=t1", headers });
    expect(calls[1]).toMatchObject({
      url: "http://schedule/sessions/active?taskId=t1",
      headers: { "x-user-id": "u1" },
    });
  });

  it("forwards the sample schedule to schedule and the sample cycle to budget", async () => {
    const { app, calls } = setup();
    const headers = { cookie: `${SESSION_COOKIE}=good` };
    const sched = await (await app).inject({ method: "GET", url: "/api/sample-schedule", headers });
    expect(sched.statusCode).toBe(200);
    expect(calls[1]).toMatchObject({
      url: "http://schedule/sample-schedule",
      headers: { "x-user-id": "u1" },
    });
    await (await app).inject({ method: "GET", url: "/api/budget/sample-cycle", headers });
    expect(calls.at(-1)).toMatchObject({
      url: "http://budget/budget/sample-cycle",
      headers: { "x-user-id": "u1" },
    });
  });

  it("keeps invitation accept public", async () => {
    const { app, calls } = setup();
    const payload = AcceptInvitationRequestSchema.parse({ token: "t" });
    const res = await (
      await app
    ).inject({
      method: "POST",
      url: "/api/invitations/accept",
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(calls.map((c) => c.url)).toEqual(["http://identity/invitations/accept"]);
  });
});
