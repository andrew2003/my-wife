import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp, createMemoryStore } from "../src/index";
import { parseAuditQuery, queryAudit, redactAuditEntry } from "../src/audit-view";
import type { AuditEntry } from "../src/incidents";

const ADMIN = { "x-user-id": "admin1", "x-user-role": "admin" };
const USER = { "x-user-id": "u1", "x-user-role": "user" };

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  id: "e1",
  actorId: "admin1",
  action: "x.y",
  targetId: "t1",
  before: null,
  after: null,
  at: "2026-11-27T10:00:00.000Z",
  ...over,
});

describe("redactAuditEntry", () => {
  it.each([
    ["email key", { email: "a@x.com", n: 1 }, { email: "[redacted]", n: 1 }],
    [
      "chat content keys",
      { text: "hi", message: "yo", content: "c" },
      { text: "[redacted]", message: "[redacted]", content: "[redacted]" },
    ],
    ["email inside free text", { reason: "call bob@x.com now" }, { reason: "call [redacted] now" }],
    [
      "nested and arrays",
      { a: { list: [{ displayName: "An" }, "z@y.vn"] } },
      { a: { list: [{ displayName: "[redacted]" }, "[redacted]"] } },
    ],
    [
      "global sender address is kept",
      { senderAddress: "no-reply@vcb.com.vn" },
      { senderAddress: "no-reply@vcb.com.vn" },
    ],
    ["plain facts stay", { flag: "sync", enabled: false }, { flag: "sync", enabled: false }],
  ])("%s", (_n, input, expected) => {
    expect(redactAuditEntry(entry({ before: input, after: input })).after).toEqual(expected);
  });

  it("redacts an email used as target id", () => {
    expect(redactAuditEntry(entry({ targetId: "a@x.com" })).targetId).toBe("[redacted]");
  });

  it("does not mutate the stored entry", () => {
    const e = entry({ after: { email: "a@x.com" } });
    redactAuditEntry(e);
    expect(e.after).toEqual({ email: "a@x.com" });
  });
});

describe("queryAudit", () => {
  const all = [
    entry({ id: "1", action: "invitation.created", at: "2026-11-27T09:00:00.000Z" }),
    entry({
      id: "2",
      action: "incident.declared",
      actorId: "admin2",
      at: "2026-11-27T10:00:00.000Z",
    }),
    entry({ id: "3", action: "incident.ended", at: "2026-11-27T11:00:00.000Z" }),
  ];
  it.each([
    ["no filter", {}, ["1", "2", "3"]],
    ["action prefix", { action: "incident" }, ["2", "3"]],
    ["exact action", { action: "incident.ended" }, ["3"]],
    ["actor", { actorId: "admin2" }, ["2"]],
    ["from", { from: "2026-11-27T10:00:00.000Z" }, ["2", "3"]],
    ["to", { to: "2026-11-27T10:00:00.000Z" }, ["1", "2"]],
    ["limit and offset", { limit: 1, offset: 1 }, ["2"]],
  ])("%s", (_n, q, ids) => {
    expect(queryAudit(all, q).map((e) => e.id)).toEqual(ids);
  });
});

describe("parseAuditQuery", () => {
  it.each([
    ["empty", {}, true],
    ["valid", { limit: "10", offset: "0", from: "2026-11-27T10:00:00Z", action: "a" }, true],
    ["limit zero", { limit: "0" }, false],
    ["limit too big", { limit: "501" }, false],
    ["limit text", { limit: "x" }, false],
    ["bad date", { from: "yesterday" }, false],
    ["empty action", { action: "" }, false],
  ])("%s", (_n, raw, ok) => {
    expect(parseAuditQuery(raw) !== undefined).toBe(ok);
  });
});

describe("GET /admin/audit", () => {
  function setup() {
    return createApp(loadConfig({ SESSION_SECRET: "s".repeat(32), LOG_LEVEL: "silent" }), {
      store: createMemoryStore(),
      now: () => new Date("2026-11-27T10:00:00Z"),
      publish: () => undefined,
      onInvitation: () => undefined,
    });
  }
  const flag = {
    method: "PUT" as const,
    url: "/admin/feature-flags",
    headers: ADMIN,
    payload: { userId: "u1", flag: "sync", enabled: false },
  };

  it("is admin only", async () => {
    const app = setup();
    const get = (headers?: Record<string, string>) =>
      app.inject({ method: "GET", url: "/admin/audit", headers });
    expect((await get(USER)).statusCode).toBe(403);
    expect((await get()).statusCode).toBe(403);
  });

  it("records each admin action and shows no personal content", async () => {
    const app = setup();
    await app.inject({
      method: "POST",
      url: "/invitations",
      headers: ADMIN,
      payload: { email: "secret@x.com" },
    });
    await app.inject({
      method: "POST",
      url: "/admin/incidents",
      headers: ADMIN,
      payload: {
        startsAt: "2026-11-27T09:00:00.000Z",
        endsAt: null,
        scope: "all",
        reason: "outage reported by secret@x.com",
      },
    });
    await app.inject(flag);
    const res = await app.inject({ method: "GET", url: "/admin/audit", headers: ADMIN });
    expect(res.json().data.entries.map((e: AuditEntry) => e.action)).toEqual([
      "invitation.created",
      "incident.declared",
      "feature_flag.changed",
    ]);
    expect(res.body).not.toContain("secret@x.com");
  });

  it("filters by query and rejects a bad limit", async () => {
    const app = setup();
    await app.inject(flag);
    const get = (q: string) =>
      app.inject({ method: "GET", url: `/admin/audit?${q}`, headers: ADMIN });
    expect((await get("action=feature_flag")).json().data.entries).toHaveLength(1);
    expect((await get("action=incident")).json().data.entries).toHaveLength(0);
    expect((await get("limit=0")).statusCode).toBe(400);
  });
});

describe("parseAuditQuery default page size", () => {
  it("bounds a query that asks for no limit", () => {
    expect(parseAuditQuery({})?.limit).toBe(100);
  });

  it("keeps an explicit limit", () => {
    expect(parseAuditQuery({ limit: "5" })?.limit).toBe(5);
  });
});
