import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { BudgetOverviewResponseSchema, type EventEnvelope } from "@my-wife/contracts";
import { buildFundRequests, createApp, MemorySampleBudgetStore } from "../src/index";
import { seedDemoBudget } from "../src/demo-seed";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const NOW = new Date("2026-03-05T10:00:00Z");
const USER = "demo-user";
const headers = { "x-user-id": USER };

async function seeded() {
  const store = new MemorySampleBudgetStore();
  const published: EventEnvelope[] = [];
  const result = await seedDemoBudget({
    store,
    userId: USER,
    now: () => NOW,
    locale: "en",
    publish: (e) => void published.push(e),
  });
  return { store, published, result };
}

describe("seedDemoBudget", () => {
  it("leaves a running cycle with every account funded and an audit trail", async () => {
    const { store, result } = await seeded();
    const record = store.get(USER)!;
    expect(result).toBe("seeded");
    expect(record.cycle.state).toBe("running");
    expect(record.cycle.openedAt).not.toBeNull();
    const required = buildFundRequests({
      sequence: record.cycle.sequence,
      accounts: record.accounts,
      categories: record.categories,
    });
    for (const t of required.filter((r) => r.requiredVnd > 0)) {
      const funding = record.fundings.find((f) => f.bankAccountId === t.bankAccountId)!;
      expect(funding.amountVnd).toBe(t.requiredVnd);
    }
    expect(record.audit.length).toBeGreaterThan(0);
    expect(record.announced && record.fundsAnnounced && record.openedAnnounced).toBe(true);
  });

  it("is idempotent: a second call changes nothing", async () => {
    const { store } = await seeded();
    const before = JSON.stringify(store.get(USER));
    const again = await seedDemoBudget({
      store,
      userId: USER,
      now: () => new Date(NOW.getTime() + 86_400_000),
      locale: "en",
      publish: () => undefined,
    });
    expect(again).toBe("exists");
    expect(JSON.stringify(store.get(USER))).toBe(before);
  });
});

describe("demo user budget routes", () => {
  it("serves the overview with a running cycle", async () => {
    const { store } = await seeded();
    const app = await createApp(config, { store, now: () => NOW });
    const res = await app.inject({ method: "GET", url: "/budget/overview", headers });
    expect(res.statusCode).toBe(200);
    const body = BudgetOverviewResponseSchema.parse(res.json());
    expect(body.ok && body.data.cycle.state).toBe("running");
  });

  it("serves the funding transfer list for the running cycle", async () => {
    const { store } = await seeded();
    const record = store.get(USER)!;
    const app = await createApp(config, { store, now: () => NOW });
    const res = await app.inject({ method: "GET", url: "/budget/funding", headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { cycle: { state: string }; accounts: { requiredVnd: number; funded: boolean }[] };
    };
    expect(body.data.cycle.state).toBe("running");
    expect(body.data.accounts.length).toBeGreaterThan(0);
    expect(body.data.accounts.every((a) => a.funded)).toBe(true);
    const total = body.data.accounts.reduce((s, a) => s + a.requiredVnd, 0);
    expect(total).toBe(record.categories.reduce((s, c) => s + c.cycleLimitVnd, 0));
  });
});
