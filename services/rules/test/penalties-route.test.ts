import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { ListPenaltiesResponseSchema, type PenaltyLedgerEntry } from "@my-wife/contracts";
import { createApp } from "../src/app";
import { InMemoryPenaltyStore } from "../src/penalty";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const NOBODY = "77777777-7777-4777-8777-777777777777";

function entry(n: number, status: PenaltyLedgerEntry["status"], amountVnd: number) {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const e: PenaltyLedgerEntry = {
    id,
    source: "overspend",
    amountVnd,
    status,
    dueDate: status === "suspended" ? null : "2026-12-01T00:00:00.000Z",
    transferCode: `MW-PH-C${n}`,
    paymentTransactionId: null,
    auditRefs: [`audit-${n}`],
    contractId: null,
  };
  return { e, audit: { id: `audit-${n}` } as never };
}

function setup(contractId: string | null = null) {
  const store = new InMemoryPenaltyStore();
  for (const [u, n, s, a] of [
    [USER, 1, "suspended", 30_000],
    [USER, 2, "due", 50_000],
    [USER, 3, "suspended", 20_000],
    [OTHER, 4, "suspended", 999_000],
  ] as const) {
    const { e, audit } = entry(n, s, a);
    store.insertOnce(u, { ...e, contractId, sourceKey: `k${n}` } as never, audit);
  }
  return createApp(config, { penaltyStore: store });
}

describe("GET /penalties", () => {
  it("returns the signed-in user's penalties and the suspended total", async () => {
    const app = setup();
    const res = await app.inject({
      method: "GET",
      url: "/penalties",
      headers: { "x-user-id": USER },
    });
    expect(res.statusCode).toBe(200);
    const body = ListPenaltiesResponseSchema.parse(res.json());
    expect(body.ok).toBe(true);
    if (!body.ok) return;
    expect(body.data.penalties.map((p) => p.amountVnd)).toEqual([30_000, 50_000, 20_000]);
    expect(body.data.suspendedTotalVnd).toBe(50_000);
  });

  it("returns the contract id of the entry, null when none exists", async () => {
    const CONTRACT = "44444444-4444-4444-8444-444444444444";
    for (const contractId of [CONTRACT, null]) {
      const res = await setup(contractId).inject({
        method: "GET",
        url: "/penalties",
        headers: { "x-user-id": USER },
      });
      const body = ListPenaltiesResponseSchema.parse(res.json());
      if (!body.ok) throw new Error("expected ok");
      expect(new Set(body.data.penalties.map((p) => p.contractId))).toEqual(new Set([contractId]));
    }
  });

  it("does not return another user's penalties", async () => {
    const app = setup();
    const res = await app.inject({
      method: "GET",
      url: "/penalties",
      headers: { "x-user-id": NOBODY },
    });
    expect(res.json()).toEqual({ ok: true, data: { penalties: [], suspendedTotalVnd: 0 } });
  });

  it("rejects a request without a user id", async () => {
    const app = setup();
    const res = await app.inject({ method: "GET", url: "/penalties" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false, error: { code: "unauthorized" } });
  });
});
