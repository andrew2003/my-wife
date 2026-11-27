import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { FaultLedgerView } from "../components/fault-ledger-view";
import { NAV_ITEMS } from "../lib/nav";
import { canAppealFault, loadFaults, reasonKey, submitFaultAppeal } from "../lib/fault-ledger";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const F1 = "11111111-1111-4111-8111-111111111111";
const F2 = "22222222-2222-4222-8222-222222222222";
const F3 = "33333333-3333-4333-8333-333333333333";
const fault = (over: Record<string, unknown>) => ({
  id: F1,
  type: "camera_off",
  occurredAt: "2026-11-26T17:30:00.000Z",
  signalRef: "hb-1",
  reasonRef: null,
  weightSnapshot: 2,
  points: 2,
  status: "recorded",
  waiver: null,
  systemCause: null,
  ...over,
});
const faults = [
  fault({}),
  fault({ id: F2, type: "tab_away", points: 1, reasonRef: F3, status: "appealed" }),
  fault({ id: F3, type: "wake_late", points: 0, status: "waived_system", waiver: "admin_incident" }),
];

const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(FaultLedgerView, {
      locale: "en",
      status: "ready",
      faults,
      timeZone: "Asia/Ho_Chi_Minh",
      appealingId: null,
      appealState: "idle",
      onAppeal: () => {},
      onCancelAppeal: () => {},
      onSubmitAppeal: () => {},
      onRefresh: () => {},
      ...props,
    } as never),
  );

describe("fault ledger", () => {
  it("shows type, points, reason and an appeal action for each fault (acceptance)", () => {
    const html = render({});
    expect(html).toContain(en["fault.type.camera_off"]);
    expect(html).toContain(en["fault.type.tab_away"]);
    expect(html).toContain(en["fault.type.wake_late"]);
    expect(html).toContain(en["fault.reason.none"]);
    expect(html).toContain(en["fault.reason.given"]);
    expect(html).toContain(en["fault.status.recorded"]);
    expect(html).toContain("2 " + en["fault.points"]);
    // Only the recorded fault can be appealed.
    expect(html.split(`>${en["fault.appeal.action"]}<`).length - 1).toBe(1);
  });

  it("shows the time in the user's time zone", () => {
    // 17:30 UTC on 26 Nov is already 27 Nov in Ho Chi Minh City.
    expect(render({})).toContain("Nov 27, 2026");
  });

  it("has empty, loading and error states", () => {
    expect(render({ status: "empty", faults: [] })).toContain(en["fault.empty"]);
    expect(render({ status: "loading" })).toContain(en["fault.loading"]);
    expect(render({ status: "error" })).toContain(en["fault.error"]);
  });

  it("renders Vietnamese from the locale file", () => {
    const html = render({ locale: "vi" });
    expect(html).toContain(vi["fault.type.camera_off"]);
    expect(html).not.toContain(en["fault.type.camera_off"]);
  });

  it("shows the appeal form only for the chosen fault", () => {
    expect(render({ appealingId: F1 })).toContain(en["fault.appeal.submit"]);
    expect(render({})).not.toContain(en["fault.appeal.submit"]);
  });

  it("has locale keys in both languages and a nav entry", () => {
    for (const k of Object.keys(en).filter((key) => key.startsWith("fault."))) {
      expect(vi).toHaveProperty([k]);
    }
    expect(NAV_ITEMS.some((i) => i.href === "/faults")).toBe(true);
  });
});

describe("fault helpers", () => {
  it("allows an appeal only on recorded faults", () => {
    expect(canAppealFault("recorded")).toBe(true);
    for (const s of ["pending_reason", "appealed", "upheld", "overturned", "waived_system"]) {
      expect(canAppealFault(s as never)).toBe(false);
    }
  });

  it("maps the reason state", () => {
    expect(reasonKey({ status: "pending_reason", reasonRef: null })).toBe("fault.reason.pending");
    expect(reasonKey({ status: "recorded", reasonRef: F3 })).toBe("fault.reason.given");
    expect(reasonKey({ status: "recorded", reasonRef: null })).toBe("fault.reason.none");
  });
});

describe("loadFaults", () => {
  it("reads faults, empty and error", async () => {
    const ok = async () => json(200, { ok: true, data: { faults } });
    const res = await loadFaults(ok as never);
    expect(res.status === "ready" && res.faults).toHaveLength(3);
    const none = async () => json(200, { ok: true, data: { faults: [] } });
    expect((await loadFaults(none as never)).status).toBe("empty");
    expect((await loadFaults((async () => json(500, {})) as never)).status).toBe("error");
  });
});

describe("submitFaultAppeal", () => {
  it("posts a fault appeal and reports success or failure", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const appeal = {
      id: "44444444-4444-4444-8444-444444444444",
      subjectKind: "fault",
      subjectId: F1,
      status: "open",
      reasonText: "I was present",
      openedAt: "2026-11-27T00:00:00.000Z",
      windowEndsAt: "2026-11-29T00:00:00.000Z",
      hasEvidenceFrame: false,
    };
    const f = async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return json(200, { ok: true, data: { appeal } });
    };
    expect(await submitFaultAppeal(F1, " I was present ", f as never)).toBe(true);
    expect(calls[0]).toEqual({
      url: "/api/appeals",
      body: { subjectKind: "fault", subjectId: F1, reasonText: "I was present" },
    });
    expect(await submitFaultAppeal(F1, "  ", f as never)).toBe(false);
    expect(calls).toHaveLength(1);
    const bad = async () => json(409, { ok: false, error: { code: "rules.window_closed" } });
    expect(await submitFaultAppeal(F1, "x", bad as never)).toBe(false);
  });
});
