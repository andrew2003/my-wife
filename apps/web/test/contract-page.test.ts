import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { ContractPageView } from "../components/contract-page-view";
import { NAV_ITEMS } from "../lib/nav";
import { loadContractPage, signCycleContract, type ContractPageData } from "../lib/contract-page";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const routes = (map: Record<string, () => Response>) =>
  (async (url: string) => (map[url] ? map[url]!() : json(404, { ok: false }))) as never;

const settings = () =>
  json(200, {
    ok: true,
    data: { values: { "reward.clean_streak_days": 14, "reward.unlock_amount_vnd": 70000 } },
  });

const status =
  (contractRequired: boolean, lock: string | null = null) =>
  () =>
    json(200, { ok: true, data: { cycleId: "c1", contractRequired, looseningLockedUntil: lock } });

describe("loadContractPage", () => {
  it("reports a new cycle that needs signing, with rewards listed", async () => {
    const f = routes({
      "/api/contracts/status": status(true, "2026-12-24T17:00:00.000Z"),
      "/api/rewards": () =>
        json(200, {
          ok: true,
          data: {
            rewards: [
              { id: "r1", amountVnd: 50000, categoryId: null, unlockedAt: "2026-11-20T00:00:00Z" },
            ],
          },
        }),
      "/api/settings": settings,
    });
    const res = await loadContractPage(f);
    expect(res.status).toBe("ready");
    if (res.status !== "ready") return;
    expect(res.data.cycleId).toBe("c1");
    expect(res.data.contractRequired).toBe(true);
    expect(res.data.rewards).toHaveLength(1);
    expect(res.data.rule).toEqual({ streakDays: 14, amountVnd: 70000 });
  });

  it("uses registry defaults for the reward rule when settings are unreadable", async () => {
    const f = routes({
      "/api/contracts/status": status(false),
      "/api/rewards": () => json(200, { ok: true, data: { rewards: [] } }),
    });
    const res = await loadContractPage(f);
    expect(res.status === "ready" && res.data.rule).toEqual({ streakDays: 7, amountVnd: 50000 });
  });

  it("still loads when the rewards route is missing (empty list)", async () => {
    const res = await loadContractPage(routes({ "/api/contracts/status": status(true) }));
    expect(res.status === "ready" && res.data.rewards).toEqual([]);
  });

  it("is empty without an open cycle and errors when status fails", async () => {
    const none = routes({ "/api/contracts/status": () => json(200, { ok: true, data: null }) });
    expect((await loadContractPage(none)).status).toBe("empty");
    const bad = routes({ "/api/contracts/status": () => json(500, { ok: false }) });
    expect((await loadContractPage(bad)).status).toBe("error");
  });
});

describe("signCycleContract", () => {
  it("posts only the contract signature", async () => {
    const calls: [string, unknown][] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push([url, JSON.parse(String(init?.body))]);
      return json(200, { ok: true, data: {} });
    }) as never;
    expect(await signCycleContract("c1", f)).toBe(true);
    expect(calls).toEqual([["/api/contracts/sign", { cycleId: "c1" }]]);
    expect(await signCycleContract("c1", (async () => json(500, {})) as never)).toBe(false);
  });
});

describe("ContractPageView", () => {
  const data: ContractPageData = {
    cycleId: "c1",
    contractRequired: true,
    looseningLockedUntil: "2026-12-24T17:00:00.000Z",
    rewards: [{ id: "r1", amountVnd: 50000, categoryId: null, unlockedAt: "2026-11-20T00:00:00Z" }],
    rule: { streakDays: 7, amountVnd: 50000 },
  };
  const view = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(ContractPageView, {
        locale: "en",
        status: "ready",
        data,
        timeZone: "Asia/Ho_Chi_Minh",
        agreed: false,
        signState: "idle",
        onAgreeChange: () => {},
        onSign: () => {},
        onRefresh: () => {},
        ...props,
      } as never),
    );

  it("shows the contract for signing and lists rewards for a new cycle", () => {
    const html = view({});
    expect(html).toContain(en["contract.title"]);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Sign the contract/);
    expect(html).toContain(en["contract.page.rewards"]);
    expect(html).toContain("50,000");
    expect(view({ agreed: true })).not.toMatch(/<button[^>]*disabled=""/);
  });

  it("shows a signed notice and an empty reward list", () => {
    const html = view({ data: { ...data, contractRequired: false, rewards: [] } });
    expect(html).toContain(en["contract.page.signed"]);
    expect(html).toContain(en["contract.page.rewards_empty"]);
    expect(html).not.toContain(en["contract.sign"]);
  });

  it("has loading, empty, error and failed-sign states", () => {
    expect(view({ status: "loading" })).toContain(en["contract.page.loading"]);
    expect(view({ status: "empty" })).toContain(en["contract.page.empty"]);
    expect(view({ status: "error", locale: "vi" })).toContain(vi["contract.page.error"]);
    expect(view({ signState: "failed" })).toContain(en["contract.error.sign"]);
  });

  it("has every page key in both locales and a nav entry", () => {
    const keys = Object.keys(en).filter(
      (k) => k.startsWith("contract.page.") || k.startsWith("nav.contract"),
    );
    expect(keys.length).toBeGreaterThan(6);
    for (const k of keys) expect(vi).toHaveProperty([k]);
    expect(NAV_ITEMS.some((n) => n.href === "/contract")).toBe(true);
  });
});
