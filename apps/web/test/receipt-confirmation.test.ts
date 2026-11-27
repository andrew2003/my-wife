import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { AnomalyListView } from "../components/anomaly-list-view";
import { ReceiptConfirmationView } from "../components/receipt-confirmation-view";
import { NAV_ITEMS } from "../lib/nav";
import { anomalyHref, confirmReceipt, loadReceipt } from "../lib/receipt-confirmation";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ID = "11111111-1111-4111-8111-111111111111";
const receipt = {
  receiptId: ID,
  bankTransactionRef: "FT26331ABC",
  bankAccountHint: "1234",
  direction: "out",
  amountVnd: 1_250_000,
  currency: "VND",
  counterparty: "Cafe Moc",
  memo: "coffee",
  occurredAt: "2026-11-26T05:30:00.000Z",
  source: "llm",
  fxProvisional: false,
};
const ok = { ok: true, data: { state: "needs_confirmation", receipt } };

const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(ReceiptConfirmationView, {
      locale: "en",
      status: "ready",
      state: "needs_confirmation",
      receipt,
      timeZone: "Asia/Ho_Chi_Minh",
      busy: false,
      outcome: null,
      onConfirm: () => {},
      onReject: () => {},
      onRetry: () => {},
      ...props,
    } as never),
  );

describe("receipt confirmation screen", () => {
  it("shows the parsed fields with confirm and reject for a needs_confirmation receipt", () => {
    const html = render({});
    expect(html).toContain("FT26331ABC");
    expect(html).toContain("1,250,000 VND");
    expect(html).toContain("Cafe Moc");
    expect(html).toContain("coffee");
    expect(html).toContain("1234");
    expect(html).toContain(en["receipt.confirm"]);
    expect(html).toContain(en["receipt.reject"]);
  });

  it("hides the actions once the receipt is no longer waiting", () => {
    const html = render({ state: "parsed" });
    expect(html).not.toContain(en["receipt.confirm"]);
    expect(html).toContain(en["receipt.not_waiting"]);
  });

  it("renders loading, empty (not found), error and outcome states", () => {
    expect(render({ status: "loading", receipt: null })).toContain(en["receipt.loading"]);
    expect(render({ status: "empty", receipt: null })).toContain(en["receipt.not_found"]);
    const err = render({ status: "error", receipt: null });
    expect(err).toContain(en["receipt.error"]);
    expect(err).toContain(en["receipt.retry"]);
    expect(render({ outcome: "confirmed", state: "parsed" })).toContain(en["receipt.confirmed"]);
    expect(render({ outcome: "failed" })).toContain(en["receipt.action_failed"]);
  });

  it("renders Vietnamese", () => {
    expect(render({ locale: "vi" })).toContain(vi["receipt.confirm"]);
  });
});

describe("receipt loaders", () => {
  it("loads a receipt, reports not found and errors", async () => {
    expect(await loadReceipt(ID, async () => json(200, ok))).toMatchObject({
      status: "ready",
      state: "needs_confirmation",
    });
    expect(await loadReceipt(ID, async () => json(404, { ok: false }))).toEqual({
      status: "empty",
    });
    expect(await loadReceipt(ID, async () => json(500, {}))).toEqual({ status: "error" });
    expect(await loadReceipt(ID, async () => json(200, { ok: true, data: {} }))).toEqual({
      status: "error",
    });
  });

  it("posts accept true or false for the receipt", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const f = async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return json(200, { ok: true, data: { state: "parsed" } });
    };
    expect(await confirmReceipt(ID, true, f)).toBe(true);
    expect(await confirmReceipt(ID, false, f)).toBe(true);
    expect(calls[0]).toEqual({
      url: `/api/ingest/receipts/${ID}/confirm-template`,
      body: { receiptId: ID, accept: true },
    });
    expect(calls[1]?.body).toEqual({ receiptId: ID, accept: false });
    expect(await confirmReceipt(ID, true, async () => json(409, {}))).toBe(false);
  });
});

describe("anomaly list", () => {
  const anomalies = [
    { id: ID, kind: "needs_confirmation", subjectRef: ID },
    { id: "22222222-2222-4222-8222-222222222222", kind: "missing_receipt", subjectRef: "acc" },
  ];
  const view = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(AnomalyListView, {
        locale: "en",
        status: "ready",
        anomalies,
        onRetry: () => {},
        ...props,
      } as never),
    );

  it("links receipt anomalies to the confirmation screen only", () => {
    expect(anomalyHref(anomalies[0] as never)).toBe(`/receipts/${ID}`);
    expect(anomalyHref(anomalies[1] as never)).toBeNull();
    expect(view({})).toContain(`href="/receipts/${ID}"`);
  });

  it("renders empty, loading and error states", () => {
    expect(view({ status: "empty" })).toContain(en["anomalies.empty"]);
    expect(view({ status: "loading" })).toContain(en["anomalies.loading"]);
    expect(view({ status: "error" })).toContain(en["anomalies.error"]);
  });
});

describe("locale and nav", () => {
  it("has the same keys in both languages and a nav entry", () => {
    const keys = Object.keys(en).filter((k) => /^(receipt|anomalies)\./.test(k));
    expect(keys.length).toBeGreaterThan(10);
    for (const k of keys) expect(vi).toHaveProperty([k]);
    expect(NAV_ITEMS.some((i) => i.href === "/anomalies")).toBe(true);
  });
});
