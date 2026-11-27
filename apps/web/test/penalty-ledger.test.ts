import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { PenaltyLedgerView } from "../components/penalty-ledger-view";
import { NAV_ITEMS } from "../lib/nav";
import { canAppeal, loadLedger, submitAppeal } from "../lib/penalty-ledger";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const entry = (over: Record<string, unknown>) => ({
  id: "11111111-1111-4111-8111-111111111111",
  source: "overspend",
  amountVnd: 150_000,
  status: "due",
  dueDate: "2026-11-30T17:30:00.000Z",
  transferCode: "MW-P-1",
  paymentTransactionId: null,
  auditRefs: [],
  contractId: null,
  ...over,
});
const P1 = "11111111-1111-4111-8111-111111111111";
const penalties = [
  entry({}),
  entry({
    id: "22222222-2222-4222-8222-222222222222",
    status: "suspended",
    amountVnd: 70_000,
    dueDate: null,
  }),
  entry({ id: "33333333-3333-4333-8333-333333333333", status: "paid", amountVnd: 20_000 }),
];

const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(PenaltyLedgerView, {
      locale: "en",
      status: "ready",
      penalties,
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

describe("penalty ledger", () => {
  it("lists statuses and amounts with an appeal action (acceptance)", () => {
    const html = render({});
    expect(html).toContain("150,000");
    expect(html).toContain("70,000");
    expect(html).toContain(en["penalty.status.due"]);
    expect(html).toContain(en["penalty.status.suspended"]);
    expect(html).toContain(en["penalty.status.paid"]);
    // Appeal action on the due and suspended entries, not on the paid one.
    expect(html.split(`>${en["penalty.appeal.action"]}<`).length - 1).toBe(2);
  });

  it("shows the due date in the user's time zone", () => {
    // 17:30 UTC on 30 Nov is already 1 Dec in Ho Chi Minh City.
    expect(render({})).toContain("Dec 1, 2026");
  });

  it("has empty, loading and error states", () => {
    expect(render({ status: "empty", penalties: [] })).toContain(en["penalty.empty"]);
    expect(render({ status: "loading" })).toContain(en["penalty.loading"]);
    expect(render({ status: "error" })).toContain(en["penalty.error"]);
  });

  it("renders Vietnamese from the locale file", () => {
    const html = render({ locale: "vi" });
    expect(html).toContain(vi["penalty.status.due"]);
    expect(html).not.toContain(en["penalty.status.due"]);
  });

  it("shows the appeal form for the chosen entry", () => {
    expect(render({ appealingId: P1 })).toContain(en["penalty.appeal.submit"]);
    expect(render({})).not.toContain(en["penalty.appeal.submit"]);
  });

  it("has locale keys in both languages and a nav entry", () => {
    for (const k of Object.keys(en).filter((key) => key.startsWith("penalty."))) {
      expect(vi).toHaveProperty([k]);
    }
    expect(NAV_ITEMS.some((i) => i.href === "/penalties")).toBe(true);
  });
});

describe("canAppeal", () => {
  it("allows due and suspended only", () => {
    expect(canAppeal("due")).toBe(true);
    expect(canAppeal("suspended")).toBe(true);
    expect(canAppeal("paid")).toBe(false);
  });
});

describe("loadLedger", () => {
  it("reads penalties, empty and error", async () => {
    const ok = async () => json(200, { ok: true, data: { penalties, suspendedTotalVnd: 70_000 } });
    const res = await loadLedger(ok as never);
    expect(res.status === "ready" && res.penalties).toHaveLength(3);
    const none = async () =>
      json(200, { ok: true, data: { penalties: [], suspendedTotalVnd: 0 } });
    expect((await loadLedger(none as never)).status).toBe("empty");
    expect((await loadLedger((async () => json(500, {})) as never)).status).toBe("error");
  });
});

describe("submitAppeal", () => {
  it("posts the reason and reports success or failure", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const appeal = {
      id: "44444444-4444-4444-8444-444444444444",
      subjectKind: "fault",
      subjectId: P1,
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
    expect(await submitAppeal(P1, "I was present", f as never)).toBe(true);
    expect(calls[0]).toEqual({
      url: "/api/appeals",
      body: { subjectKind: "fault", subjectId: P1, reasonText: "I was present" },
    });
    expect(await submitAppeal(P1, "  ", f as never)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(await submitAppeal(P1, "x", (async () => json(500, {})) as never)).toBe(false);
  });
});
