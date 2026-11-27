import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp, createMemoryStore, type PenaltySummary } from "../src/index";

const SECRET = "sk-ant-SUPERSECRET-0123456789";
const A = { "x-user-id": "ua" };
const B = { "x-user-id": "ub" };
const KEY = Buffer.alloc(32, 7).toString("base64");
const SUSPENDED: PenaltySummary = { amountVnd: 200_000, date: "2026-01-01", status: "suspended" };

async function setup(open: PenaltySummary[] = []) {
  const events: EventEnvelope[] = [];
  const store = createMemoryStore();
  let penalties = open;
  let portDown = false;
  for (const id of ["ua", "ub"])
    await store.insertUser({
      id,
      email: `${id}@example.com`,
      state: "active",
      role: "user",
      locale: "vi",
      lastSeenAt: null,
      activatedEventAt: null,
    });
  const config = loadConfig({ SESSION_SECRET: "s".repeat(32), SECRETS_MASTER_KEY: KEY });
  const app = createApp(config, {
    store,
    now: () => new Date("2026-01-05T00:00:00Z"),
    publish: (e) => void events.push(e),
    penalties: {
      async listOpen(userId) {
        if (portDown) throw new Error("rules unreachable");
        return userId === "ua" ? penalties : [];
      },
    },
  });
  for (const h of [A, B]) {
    await app.inject({
      method: "PUT",
      url: "/secrets/llm_key",
      headers: h,
      payload: { value: SECRET },
    });
    await app.inject({
      method: "PUT",
      url: "/settings",
      headers: h,
      payload: { key: "budget.cycle_weeks", value: 3 },
    });
    await app.inject({
      method: "POST",
      url: "/consents",
      headers: h,
      payload: { kind: "email", textVersion: 1 },
    });
  }
  events.length = 0;
  return {
    app,
    events,
    store,
    setPenalties: (p: PenaltySummary[]) => (penalties = p),
    setDown: (d: boolean) => (portDown = d),
  };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
const del = (c: Ctx, body: unknown = { confirmation: "ua@example.com" }, h = A) =>
  c.app.inject({ method: "POST", url: "/account/deletion", headers: h, payload: body as object });

describe("account deletion", () => {
  it("keeps the account closing and ends the trial when penalties are suspended", async () => {
    const c = await setup([SUSPENDED]);
    const res = await del(c);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ state: "closing", exportOffered: true });
    expect((await c.store.findUserById("ua"))?.state).toBe("closing");
    // user.closing is the signal rules uses to end the trial (trial.ended account_closing).
    expect(c.events.map((e) => e.type)).toEqual(["user.closing"]);
    expect(c.events[0]?.payload).toEqual({ reason: "deletion_requested" });
  });

  it("anonymises everything but keeps the user id while penalties remain", async () => {
    const c = await setup([SUSPENDED]);
    await del(c);
    const user = await c.store.findUserById("ua");
    expect(user?.email).not.toContain("example.com");
    expect(await c.store.listSecrets("ua")).toEqual([]);
    expect(await c.store.getSettingOverrides("ua")).toEqual({});
    expect(await c.store.listSettingAudit("ua")).toEqual([]);
    const consents = await c.app.inject({ method: "GET", url: "/consents", headers: A });
    expect(JSON.stringify(consents.json())).not.toContain('"email"');
  });

  it("closes and emits user.closed when there are no penalties", async () => {
    const c = await setup([]);
    const res = await del(c);
    expect(res.json().data).toEqual({ state: "closed", exportOffered: true });
    expect((await c.store.findUserById("ua"))?.state).toBe("closed");
    expect((await c.store.findUserById("ua"))?.email).not.toContain("example.com");
    expect(c.events.map((e) => e.type)).toEqual(["user.closing", "user.closed"]);
    expect(await c.store.listSecrets("ua")).toEqual([]);
  });

  it("never touches another user's data", async () => {
    const c = await setup([]);
    await del(c);
    expect((await c.store.findUserById("ub"))?.email).toBe("ub@example.com");
    expect(await c.store.listSecrets("ub")).toHaveLength(1);
  });

  it("requires typed confirmation, a caller, and an active account", async () => {
    const c = await setup([]);
    expect((await c.app.inject({ method: "POST", url: "/account/deletion" })).statusCode).toBe(401);
    expect((await del(c, { confirmation: "nope" })).statusCode).toBe(400);
    expect((await del(c, {})).statusCode).toBe(400);
    expect((await c.store.findUserById("ua"))?.state).toBe("active");
    await del(c);
    expect((await del(c)).statusCode).toBe(409);
  });

  it("erases nothing when the penalty state cannot be read", async () => {
    const c = await setup([]);
    c.setDown(true);
    expect((await del(c)).statusCode).toBe(503);
    expect((await c.store.findUserById("ua"))?.state).toBe("active");
    expect(await c.store.listSecrets("ua")).toHaveLength(1);
    expect(c.events).toEqual([]);
  });

  it("closes a closing account once the penalties are settled", async () => {
    const c = await setup([SUSPENDED]);
    await del(c);
    c.events.length = 0;
    const run = async () =>
      (await c.app.inject({ method: "POST", url: "/jobs/closing" })).json().data;
    expect(await run()).toEqual({ closed: 0 });
    expect(c.events).toEqual([]);
    c.setPenalties([]);
    expect(await run()).toEqual({ closed: 1 });
    expect((await c.store.findUserById("ua"))?.state).toBe("closed");
    expect(c.events.map((e) => e.type)).toEqual(["user.closed"]);
    c.events.length = 0;
    expect(await run()).toEqual({ closed: 0 });
    expect(c.events).toEqual([]);
  });

  it("does not return secrets", async () => {
    const c = await setup([]);
    expect((await del(c)).body).not.toContain(SECRET);
  });
});
