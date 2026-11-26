import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { FundingView } from "../components/funding-view";
import {
  buildTransferQrPayload,
  loadFunding,
  qrDataUrl,
  type FundingAccount,
} from "../lib/funding";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const cycle = {
  id: "cycle-1",
  sequence: 3,
  weeks: 4,
  firstDay: "2026-11-26",
  state: "awaiting_funds",
  openedAt: null,
  closedAt: null,
  commitmentId: "k1",
};
const waiting: FundingAccount = {
  bankAccountId: "a1",
  name: "Daily bank",
  code: "VCB",
  requiredVnd: 5_000_000,
  memo: "MW-F-C3-VCB",
  funded: false,
};
const funded: FundingAccount = {
  ...waiting,
  bankAccountId: "a2",
  name: "Saving bank",
  code: "TCB",
  memo: "MW-F-C3-TCB",
  funded: true,
};

describe("loadFunding", () => {
  it("reads the funding status of the awaiting cycle", async () => {
    const calls: string[] = [];
    const f = async (url: string) => {
      calls.push(url);
      return json(200, { ok: true, data: { cycle, accounts: [waiting, funded] } });
    };
    const res = await loadFunding(f as never);
    expect(calls).toEqual(["/api/budget/funding"]);
    expect(res.status).toBe("ready");
    expect(res.status === "ready" && res.accounts).toHaveLength(2);
  });

  it("is empty when no cycle awaits funds, and an error on failure or bad data", async () => {
    const run = async (f: () => Promise<Response>) => (await loadFunding(f as never)).status;
    expect(await run(async () => json(404, { ok: false }))).toBe("empty");
    expect(await run(async () => json(500, { ok: false }))).toBe("error");
    expect(await run(async () => json(200, { ok: true, data: { x: 1 } }))).toBe("error");
    expect(
      await run(async () => {
        throw new Error("net");
      }),
    ).toBe("error");
  });

  it("is empty when the cycle is not awaiting funds", async () => {
    const f = async () =>
      json(200, { ok: true, data: { cycle: { ...cycle, state: "running" }, accounts: [] } });
    expect((await loadFunding(f as never)).status).toBe("empty");
  });
});

describe("transfer QR", () => {
  it("carries the amount and the memo", () => {
    const payload = buildTransferQrPayload(waiting);
    expect(payload).toContain("5000000");
    expect(payload).toContain("MW-F-C3-VCB");
  });
  it("renders as an image data URL", () => {
    expect(qrDataUrl("MW-F-C3-VCB")).toMatch(/^data:image\//);
  });
});

describe("FundingView", () => {
  const view = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(FundingView, {
        locale: "en",
        status: "ready",
        accounts: [waiting, funded],
        onRefresh: () => {},
        ...props,
      } as never),
    );

  it("shows amount, code and a QR image for each unfunded account", () => {
    const html = view({});
    expect(html).toContain("Daily bank");
    expect(html).toContain("5,000,000");
    expect(html).toContain("MW-F-C3-VCB");
    expect(html).toMatch(/<img[^>]*src="data:image\/[^"]+"/);
    expect(html).toContain(en["funding.status.waiting"]);
  });

  it("shows a funded account as funded, without a QR", () => {
    const html = view({ accounts: [funded] });
    expect(html).toContain(en["funding.status.funded"]);
    expect(html).not.toContain("<img");
  });

  it("has loading, empty and error states with a retry", () => {
    expect(view({ status: "loading", accounts: [] })).toContain(en["funding.loading"]);
    expect(view({ status: "empty", accounts: [] })).toContain(en["funding.empty"]);
    const err = view({ status: "error", accounts: [], locale: "vi" });
    expect(err).toContain(vi["funding.error"]);
    expect(err).toContain(vi["funding.retry"]);
  });

  it("has every funding key in both locales", () => {
    const keys = Object.keys(en).filter((k) => k.startsWith("funding."));
    expect(keys.length).toBeGreaterThan(8);
    for (const k of keys) expect(vi).toHaveProperty([k]);
  });
});
