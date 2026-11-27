import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp, createMemoryStore, type IdentityDeps } from "../src/index";

const ADMIN = { "x-user-id": "admin1", "x-user-role": "admin" };
const USER = { "x-user-id": "u1", "x-user-role": "user" };
const NOW = new Date("2026-11-27T10:00:00Z");

function setup(extra: Partial<IdentityDeps> = {}) {
  const events: EventEnvelope[] = [];
  const tokens: string[] = [];
  const app = createApp(loadConfig({ SESSION_SECRET: "s".repeat(32), LOG_LEVEL: "silent" }), {
    store: createMemoryStore(),
    now: () => NOW,
    publish: (e) => void events.push(e),
    onInvitation: (_e, t) => void tokens.push(t),
    ...extra,
  });
  const invite = async (email: string) =>
    app.inject({ method: "POST", url: "/invitations", headers: ADMIN, payload: { email } });
  return { app, events, tokens, invite };
}

describe("invitation revocation", () => {
  it("refuses a revoked invitation on accept", async () => {
    const { app, tokens, invite } = setup();
    const id = (await invite("a@x.com")).json().data.invitation.id;
    const res = await app.inject({
      method: "POST",
      url: `/admin/invitations/${id}/revoke`,
      headers: ADMIN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.invitation.revokedAt).toBe(NOW.toISOString());
    const accept = await app.inject({
      method: "POST",
      url: "/invitations/accept",
      payload: { token: tokens[0] },
    });
    expect(accept.statusCode).toBe(400);
    expect(accept.json().error.code).toBe("identity.invitation_invalid");
  });

  it("emits invitation.revoked and audits it", async () => {
    const { app, events, invite } = setup();
    const id = (await invite("a@x.com")).json().data.invitation.id;
    await app.inject({ method: "POST", url: `/admin/invitations/${id}/revoke`, headers: ADMIN });
    expect(events.find((e) => e.type === "invitation.revoked")?.payload).toEqual({
      invitationId: id,
    });
    const audit = (await app.inject({ method: "GET", url: "/admin/audit", headers: ADMIN })).json();
    expect(audit.data.entries.map((e: { action: string }) => e.action)).toEqual([
      "invitation.created",
      "invitation.revoked",
    ]);
  });

  it.each([
    ["non-admin", USER, 403],
    ["unknown id", ADMIN, 404],
  ])("revoke by %s answers %i", async (_n, headers, code) => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/admin/invitations/nope/revoke",
      headers,
    });
    expect(res.statusCode).toBe(code);
  });

  it("refuses to revoke a used invitation", async () => {
    const { app, tokens, invite } = setup();
    const id = (await invite("a@x.com")).json().data.invitation.id;
    await app.inject({ method: "POST", url: "/invitations/accept", payload: { token: tokens[0] } });
    const res = await app.inject({
      method: "POST",
      url: `/admin/invitations/${id}/revoke`,
      headers: ADMIN,
    });
    expect(res.statusCode).toBe(409);
  });

  it("lists invitations with expiry and use, for admins only", async () => {
    const { app, invite } = setup();
    await invite("a@x.com");
    const ok = await app.inject({ method: "GET", url: "/admin/invitations", headers: ADMIN });
    expect(ok.json().data.invitations).toHaveLength(1);
    expect(ok.json().data.invitations[0]).toMatchObject({ email: "a@x.com", usedAt: null });
    const no = await app.inject({ method: "GET", url: "/admin/invitations", headers: USER });
    expect(no.statusCode).toBe(403);
  });

  it("refuses to create an invitation once identity.max_users is reached", async () => {
    const { app, tokens, invite } = setup({ settings: { "identity.max_users": 1 } });
    await invite("a@x.com");
    await app.inject({ method: "POST", url: "/invitations/accept", payload: { token: tokens[0] } });
    const res = await invite("b@x.com");
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("identity.user_limit_reached");
  });
});

describe("sender map curation", () => {
  const entry = { senderKey: "vcb", senderAddress: "NoReply@VCB.com.vn", dkimDomain: "vcb.com.vn" };
  const put = (
    app: ReturnType<typeof setup>["app"],
    payload: Record<string, unknown>,
    headers = ADMIN,
  ) => app.inject({ method: "PUT", url: "/admin/sender-map", headers, payload });

  it("emits sender_map.changed when an entry is saved", async () => {
    const { app, events } = setup();
    const res = await put(app, entry);
    expect(res.statusCode).toBe(201);
    expect(res.json().data.entry.senderAddress).toBe("noreply@vcb.com.vn");
    expect(events.filter((e) => e.type === "sender_map.changed").map((e) => e.payload)).toEqual([
      { senderKey: "vcb", removed: false, on: "2026-11-27" },
    ]);
  });

  it("updates an existing entry and records before and after in the audit", async () => {
    const { app } = setup();
    await put(app, entry);
    const res = await put(app, { ...entry, dkimDomain: "new.vcb.com.vn" });
    expect(res.statusCode).toBe(200);
    const audit = (await app.inject({ method: "GET", url: "/admin/audit", headers: ADMIN })).json();
    const last = audit.data.entries.at(-1);
    expect(last.before.dkimDomain).toBe("vcb.com.vn");
    expect(last.after.dkimDomain).toBe("new.vcb.com.vn");
  });

  it("removes an entry and emits removed: true", async () => {
    const { app, events } = setup();
    await put(app, entry);
    const res = await app.inject({
      method: "DELETE",
      url: "/admin/sender-map/vcb",
      headers: ADMIN,
    });
    expect(res.statusCode).toBe(200);
    expect(events.at(-1)?.payload).toEqual({ senderKey: "vcb", removed: true, on: "2026-11-27" });
    const list = await app.inject({ method: "GET", url: "/sender-map", headers: USER });
    expect(list.json().data.entries).toEqual([]);
  });

  it("lets any identified user read the map", async () => {
    const { app } = setup();
    await put(app, entry);
    const list = await app.inject({ method: "GET", url: "/sender-map", headers: USER });
    expect(list.json().data.entries).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/sender-map" })).statusCode).toBe(401);
  });

  it.each([
    ["missing domain", { senderKey: "x", senderAddress: "a@b.c" }],
    ["blank key", { ...entry, senderKey: "  " }],
  ])("rejects %s", async (_n, payload) => {
    const { app, events } = setup();
    expect((await put(app, payload)).statusCode).toBe(400);
    expect(events).toHaveLength(0);
  });

  it("forbids non-admins and unknown deletes", async () => {
    const { app } = setup();
    expect((await put(app, entry, USER)).statusCode).toBe(403);
    const del = await app.inject({
      method: "DELETE",
      url: "/admin/sender-map/zzz",
      headers: ADMIN,
    });
    expect(del.statusCode).toBe(404);
  });
});
