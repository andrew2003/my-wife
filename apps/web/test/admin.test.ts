import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi as mock } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { AdminView, type AdminViewProps } from "../components/admin-view";
import { adminAction, declareIncident, loadAdminData, type AdminData } from "../lib/admin";
import { NAV_ITEMS } from "../lib/nav";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ID = "11111111-1111-4111-8111-111111111111";
const incident = {
  id: ID,
  state: "active",
  startsAt: "2026-11-27T07:00:00.000Z",
  endsAt: null,
  scope: "all",
  reason: "Database outage",
};
const invitation = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "friend@example.com",
  expiresAt: "2026-12-10T00:00:00.000Z",
  usedAt: null,
  revokedAt: null,
};
const entry = {
  senderKey: "vcb",
  senderAddress: "no-reply@vcb.example",
  dkimDomain: "vcb.example",
};
const audit = {
  id: "33333333-3333-4333-8333-333333333333",
  actorId: ID,
  action: "incident.declared",
  before: null,
  after: { reason: "[redacted]" },
  at: "2026-11-27T07:00:00.000Z",
};

function routes(overrides: Record<string, () => Response> = {}) {
  const table: Record<string, () => Response> = {
    "/api/admin/incidents": () => json(200, { ok: true, data: { incidents: [incident] } }),
    "/api/admin/invitations": () => json(200, { ok: true, data: { invitations: [invitation] } }),
    "/api/sender-map": () => json(200, { ok: true, data: { entries: [entry] } }),
    "/api/admin/audit": () => json(200, { ok: true, data: { entries: [audit] } }),
    ...overrides,
  };
  return mock.fn(async (url: string) => {
    const path = url.split("?")[0] as string;
    return (table[path] ?? (() => json(404, { ok: false })))();
  });
}

describe("admin loading", () => {
  it("loads incidents, invitations, sender map and audit", async () => {
    const res = await loadAdminData(routes());
    expect(res.status).toBe("ready");
    if (res.status !== "ready") return;
    expect(res.data.incidents).toHaveLength(1);
    expect(res.data.invitations).toHaveLength(1);
    expect(res.data.senderMap).toHaveLength(1);
    expect(res.data.audit).toHaveLength(1);
  });
  it("reports forbidden for a non-admin", async () => {
    const f = routes({ "/api/admin/incidents": () => json(403, { ok: false }) });
    expect((await loadAdminData(f)).status).toBe("forbidden");
  });
  it("reports an error when a section fails or is malformed", async () => {
    const f = routes({ "/api/admin/audit": () => json(500, { ok: false }) });
    expect((await loadAdminData(f)).status).toBe("error");
    const g = routes({ "/api/sender-map": () => json(200, { nope: 1 }) });
    expect((await loadAdminData(g)).status).toBe("error");
  });
});

describe("admin actions", () => {
  it("declares an incident with a trimmed reason", async () => {
    const f = mock.fn(async (_u: string, _i?: RequestInit) =>
      json(201, { ok: true, data: { incident } }),
    );
    const res = await declareIncident(
      { startsAt: incident.startsAt, endsAt: null, scope: "all", reason: "  Outage  " },
      f,
    );
    expect(res.status).toBe("done");
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/admin/incidents");
    expect(JSON.parse(init.body as string).reason).toBe("Outage");
  });
  it("refuses an empty reason without calling the server", async () => {
    const f = mock.fn(async () => json(201, {}));
    const res = await declareIncident(
      { startsAt: incident.startsAt, endsAt: null, scope: "all", reason: "   " },
      f,
    );
    expect(res.status).toBe("invalid");
    expect(f).not.toHaveBeenCalled();
  });
  it("calls the end, cancel, revoke, invite, flag and sender map routes", async () => {
    const f = mock.fn(async (_u: string, _i?: RequestInit) => json(200, { ok: true, data: {} }));
    await adminAction({ kind: "end_incident", id: ID }, f);
    await adminAction({ kind: "cancel_incident", id: ID }, f);
    await adminAction({ kind: "revoke_invitation", id: ID }, f);
    await adminAction({ kind: "create_invitation", email: "a@b.co" }, f);
    await adminAction({ kind: "set_flag", userId: ID, flag: "sync", enabled: false }, f);
    await adminAction({ kind: "save_sender", entry }, f);
    await adminAction({ kind: "remove_sender", senderKey: "vcb" }, f);
    const calls = f.mock.calls.map(([u, i]) => `${i?.method} ${u}`);
    expect(calls).toEqual([
      `POST /api/admin/incidents/${ID}/end`,
      `POST /api/admin/incidents/${ID}/cancel`,
      `POST /api/admin/invitations/${ID}/revoke`,
      "POST /api/invitations",
      "PUT /api/admin/feature-flags",
      "PUT /api/admin/sender-map",
      "DELETE /api/admin/sender-map/vcb",
    ]);
  });
  it("returns an error when the server refuses", async () => {
    const f = mock.fn(async () => json(409, { ok: false }));
    expect((await adminAction({ kind: "end_incident", id: ID }, f)).status).toBe("error");
  });
});

const data: AdminData = {
  incidents: [incident] as AdminData["incidents"],
  invitations: [invitation],
  senderMap: [entry],
  audit: [audit] as AdminData["audit"],
};
const render = (over: Partial<AdminViewProps> = {}) =>
  renderToStaticMarkup(
    createElement(AdminView, {
      locale: "en",
      status: "ready",
      data,
      timeZone: "UTC",
      busy: false,
      actionError: false,
      onRefresh: () => {},
      onAction: () => {},
      onDeclare: () => {},
      ...over,
    }),
  );

describe("AdminView", () => {
  it("shows incidents, invitations, flags, sender map and audit", () => {
    const html = render();
    for (const key of [
      "admin.incidents.title",
      "admin.invitations.title",
      "admin.flags.title",
      "admin.sender_map.title",
      "admin.audit.title",
    ] as const) {
      expect(html).toContain(en[key]);
    }
    expect(html).toContain("Database outage");
    expect(html).toContain("friend@example.com");
    expect(html).toContain("vcb.example");
    expect(html).toContain("incident.declared");
    expect(html).toContain(en["admin.flag.camera_supervision"]);
  });
  it("renders in Vietnamese", () => {
    expect(render({ locale: "vi" })).toContain(vi["admin.audit.title"]);
  });
  it("has loading, forbidden, empty and error states", () => {
    expect(render({ status: "loading", data: null })).toContain(en["admin.loading"]);
    expect(render({ status: "forbidden", data: null })).toContain(en["admin.forbidden"]);
    const err = render({ status: "error", data: null });
    expect(err).toContain(en["admin.error"]);
    expect(err).toContain(en["admin.retry"]);
    const empty = render({
      data: { incidents: [], invitations: [], senderMap: [], audit: [] },
    });
    expect(empty).toContain(en["admin.incidents.empty"]);
    expect(empty).toContain(en["admin.invitations.empty"]);
    expect(empty).toContain(en["admin.sender_map.empty"]);
    expect(empty).toContain(en["admin.audit.empty"]);
  });
  it("shows an action error", () => {
    expect(render({ actionError: true })).toContain(en["admin.error.action"]);
  });
});

describe("admin navigation and locales", () => {
  it("is in the navigation and every admin key exists in both locales", () => {
    expect(NAV_ITEMS.some((i) => i.href === "/admin")).toBe(true);
    const keys = Object.keys(en).filter((k) => k.startsWith("admin.") || k === "nav.admin");
    expect(keys.length).toBeGreaterThan(20);
    for (const k of keys) expect(vi).toHaveProperty([k]);
  });
});
