import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { MemorySampleBudgetStore, MemoryWeeklyMenuStore } from "@my-wife/budget";
import { createMemoryStore } from "@my-wife/identity";
import { MemoryIngestStore } from "@my-wife/ingest";
import { createMemoryPlanStore } from "@my-wife/schedule";
import { seedDemoData, DEMO_RECEIPT_ID } from "../src/demo-data";
import { DEMO_USER_ID, createDemoWorld, resetDemoState } from "../src/demo-state";
import { startAll, type Runner } from "../src/runner";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const NOW = new Date("2026-11-27T01:00:00.000Z");
let runner: Runner | undefined;

afterEach(async () => {
  await runner?.stop();
  runner = undefined;
});

describe("demo user", () => {
  it("is an admin so the admin screens answer 200 after /demo-login", async () => {
    const store = createMemoryStore();
    await resetDemoState({ store, world: createDemoWorld(), now: NOW });
    expect((await store.findUserById(DEMO_USER_ID))?.role).toBe("admin");
  });
});

describe("demo data", () => {
  it("answers the read routes the all-screens test opens with 200", async () => {
    const budget = new MemorySampleBudgetStore();
    const menus = new MemoryWeeklyMenuStore();
    const plan = createMemoryPlanStore();
    const receipts = new MemoryIngestStore();
    await seedDemoData({
      userId: DEMO_USER_ID,
      now: () => NOW,
      locale: "vi",
      budget: { store: budget, menus },
      planStore: plan,
      receipts,
    });
    runner = await startAll(config, {
      ephemeralPorts: true,
      budget: { store: budget, weeklyMenuStore: menus },
      schedule: { planStore: plan },
      ingest: { store: receipts },
    });
    const headers = { "x-user-id": DEMO_USER_ID };
    for (const url of [
      `${runner.urls.schedule}/weeks/current`,
      `${runner.urls.budget}/budget/weekly-menu?weekIndex=1`,
      `${runner.urls.ingest}/receipts/${DEMO_RECEIPT_ID}`,
    ]) {
      const res = await fetch(url, { headers });
      expect([url, res.status]).toEqual([url, 200]);
    }
  });
});
