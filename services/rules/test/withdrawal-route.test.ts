import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp } from "../src/app";
import { InMemoryPenaltyStore } from "../src/penalty";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const USER = "11111111-1111-4111-8111-111111111111";

const event = (type: string, payload: unknown) => ({
  id: "evt-1",
  type,
  userId: USER,
  occurredAt: "2026-11-27T03:00:00.000Z",
  schemaVersion: 1,
  payload,
});

describe("POST /events/penalty-savings-withdrawal", () => {
  it("issues a withdrawal penalty with the default extra percent", async () => {
    const store = new InMemoryPenaltyStore();
    const app = createApp(config, {
      penaltyStore: store,
      now: () => new Date("2026-11-27T03:00:00.000Z"),
    });
    const res = await app.inject({
      method: "POST",
      url: "/events/penalty-savings-withdrawal",
      payload: event("penalty_savings.withdrawal_detected", {
        bankAccountId: "66666666-6666-4666-8666-666666666666",
        amountVnd: 500_000,
        transactionId: null,
        detectedBy: "balance_reconciliation",
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: "due", amountVnd: 600_000 });
    expect(store.list(USER)[0]).toMatchObject({ source: "withdrawal", flagged: true });
  });

  it("rejects another event type", async () => {
    const app = createApp(config, {});
    const res = await app.inject({
      method: "POST",
      url: "/events/penalty-savings-withdrawal",
      payload: event("debt.overdue", { debtId: "x", daysOverdue: 1 }),
    });
    expect(res.statusCode).toBe(400);
  });
});
