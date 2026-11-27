import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { PrivacyView } from "../components/privacy-view";
import { NAV_ITEMS } from "../lib/nav";
import {
  CONSENT_TEXT_VERSION,
  grantConsent,
  loadConsents,
  requestDeletion,
  requestExport,
  revokeConsent,
} from "../lib/privacy";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("consents", () => {
  it("loads records and reports the error state", async () => {
    const rec = {
      kind: "camera",
      textVersion: 1,
      grantedAt: "2026-11-01T00:00:00.000Z",
      revokedAt: null,
    };
    const ok = await loadConsents((async () =>
      json(200, { ok: true, data: { consents: [rec] } })) as never);
    expect(ok).toEqual({ status: "ready", consents: [rec] });
    expect((await loadConsents((async () => json(500, {})) as never)).status).toBe("error");
  });

  it("grants with the text version and revokes by kind", async () => {
    const calls: unknown[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push([url, init?.method, init?.body ? JSON.parse(String(init.body)) : null]);
      return json(200, { ok: true, data: {} });
    }) as never;
    expect(await grantConsent("email", f)).toBe(true);
    expect(await revokeConsent("email", f)).toBe(true);
    expect(calls).toEqual([
      ["/api/consents", "POST", { kind: "email", textVersion: CONSENT_TEXT_VERSION }],
      ["/api/consents/email", "DELETE", null],
    ]);
    expect(await revokeConsent("email", (async () => json(500, {})) as never)).toBe(false);
  });
});

describe("export", () => {
  it("returns the link and expiry, or an error", async () => {
    const data = { downloadUrl: "https://x.test/exports/t", expiresAt: "2026-12-01T00:00:00.000Z" };
    const f = (async (url: string, init?: RequestInit) => {
      expect([url, init?.method]).toEqual(["/api/export", "POST"]);
      return json(200, { ok: true, data });
    }) as never;
    expect(await requestExport(f)).toEqual({ status: "ready", ...data });
    expect((await requestExport((async () => json(500, {})) as never)).status).toBe("error");
  });
});

describe("deletion", () => {
  it("sends the typed confirmation and maps outcomes", async () => {
    const calls: unknown[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push([url, init?.method, JSON.parse(String(init?.body))]);
      return json(200, { ok: true, data: { state: "closing", exportOffered: true } });
    }) as never;
    expect(await requestDeletion("me@x.test", f)).toEqual({ status: "done", state: "closing" });
    expect(calls).toEqual([["/api/account/deletion", "POST", { confirmation: "me@x.test" }]]);
    const bad = await requestDeletion("no", (async () =>
      json(400, { ok: false, error: "identity.deletion_not_confirmed" })) as never);
    expect(bad).toEqual({ status: "not_confirmed" });
    expect((await requestDeletion("a", (async () => json(503, {})) as never)).status).toBe(
      "error",
    );
  });
});

const base = {
  locale: "en",
  status: "ready",
  consents: [
    { kind: "camera", textVersion: 1, grantedAt: "2026-11-01T00:00:00.000Z", revokedAt: null },
  ],
  exportState: { status: "idle" },
  deletionState: "idle",
  confirmOpen: false,
  onGrant: () => {},
  onRevoke: () => {},
  onExport: () => {},
  onOpenConfirm: () => {},
  onCancelConfirm: () => {},
  onDelete: () => {},
  onRefresh: () => {},
} as const;
const render = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(PrivacyView, { ...base, ...over } as never));

describe("PrivacyView", () => {
  it("shows every consent with grant or revoke, export and deletion", () => {
    const html = render();
    expect(html).toContain(en["privacy.consent.camera"]);
    expect(html).toContain(en["privacy.consent.google_sync"]);
    expect(html).toContain(en["privacy.consent.revoke"]);
    expect(html).toContain(en["privacy.consent.grant"]);
    expect(html).toContain(en["privacy.export.button"]);
    expect(html).toContain(en["privacy.delete.open"]);
    expect(html).not.toContain(en["privacy.delete.confirm"]);
  });

  it("asks for explicit confirmation before deletion", () => {
    const html = render({ confirmOpen: true });
    expect(html).toContain(en["privacy.delete.warning"]);
    expect(html).toContain(en["privacy.delete.confirm"]);
    expect(html).toContain('name="confirmation"');
  });

  it("shows the export link and the closing outcome", () => {
    const html = render({
      exportState: { status: "ready", downloadUrl: "https://x.test/e", expiresAt: "2026-12-01" },
      deletionState: "closing",
    });
    expect(html).toContain("https://x.test/e");
    expect(html).toContain(en["privacy.delete.closing"]);
  });

  it("has loading and error states", () => {
    expect(render({ status: "loading" })).toContain(en["privacy.loading"]);
    const err = render({ status: "error" });
    expect(err).toContain(en["privacy.error"]);
    expect(err).toContain(en["privacy.retry"]);
  });

  it("keeps locales in sync and adds a navigation entry", () => {
    const names = (o: Record<string, string>) => Object.keys(o).sort();
    expect(names(vi)).toEqual(names(en));
    expect(NAV_ITEMS.map((i) => i.href)).toContain("/settings/privacy");
  });
});
