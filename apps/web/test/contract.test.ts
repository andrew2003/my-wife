import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { ContractSigningView } from "../components/contract-signing-view";
import { signContract } from "../lib/contract";
import type { BudgetPreview } from "../lib/onboarding";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function gateway(overrides: Record<string, () => Response> = {}) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (overrides[url]) return overrides[url]!();
    return json(200, { ok: true, data: {} });
  };
  return { f: f as never, calls };
}

describe("signContract", () => {
  it("signs the contract for the cycle, then marks onboarding complete", async () => {
    const g = gateway();
    const result = await signContract("cycle-1", { fetch: g.f });
    expect(result).toEqual({ ok: true });
    expect(g.calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["POST", "/api/contracts/sign", { cycleId: "cycle-1" }],
      ["POST", "/api/onboarding/steps", { step: "sign_contract", skipped: false }],
    ]);
  });

  it("does not complete onboarding when signing fails", async () => {
    const g = gateway({ "/api/contracts/sign": () => json(500, { ok: false }) });
    const result = await signContract("cycle-1", { fetch: g.f });
    expect(result).toEqual({ ok: false, errorKey: "contract.error.sign" });
    expect(g.calls).toHaveLength(1);
  });

  it("reports a step failure so the user can retry (a repeat sign is idempotent)", async () => {
    const g = gateway({ "/api/onboarding/steps": () => json(500, { ok: false }) });
    expect(await signContract("cycle-1", { fetch: g.f })).toEqual({
      ok: false,
      errorKey: "contract.error.complete",
    });
  });

  it("fails without a cycle id and calls nothing", async () => {
    const g = gateway();
    expect(await signContract(undefined, { fetch: g.f })).toEqual({
      ok: false,
      errorKey: "contract.error.no_cycle",
    });
    expect(g.calls).toHaveLength(0);
  });
});

describe("ContractSigningView", () => {
  const budget: BudgetPreview = {
    cycle: { id: "cycle-1", weeks: 4, firstDay: "2026-11-26" },
    categories: [{ id: "c1", name: "Food", shortCode: "AN", cycleLimitVnd: 2_700_000 }],
  };
  const view = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(ContractSigningView, {
        locale: "vi",
        budget,
        agreed: false,
        busy: false,
        errorKey: null,
        onAgreeChange: () => {},
        onSign: () => {},
        ...props,
      } as never),
    );

  it("summarizes the contract and keeps Sign disabled until the user agrees", () => {
    const html = view({});
    expect(html).toContain(vi["contract.title"]);
    expect(html).toContain("Food");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Ký/);
    expect(view({ agreed: true })).not.toMatch(/<button[^>]*disabled=""/);
  });

  it("shows signing and error states, in both locales", () => {
    expect(view({ busy: true })).toContain(vi["contract.signing"]);
    expect(view({ errorKey: "contract.error.sign", locale: "en" })).toContain(
      en["contract.error.sign"],
    );
  });

  it("has every contract key in both locales", () => {
    const keys = Object.keys(en).filter((k) => k.startsWith("contract."));
    expect(keys.length).toBeGreaterThan(8);
    for (const k of keys) expect(vi).toHaveProperty([k]);
  });
});
