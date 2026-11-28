import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp, createMemoryPlanStore, seedDemoWeek } from "../src/index";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const USER = "demo-user";

describe("seedDemoWeek", () => {
  it("gives the user a current week so the read route answers 200", async () => {
    const planStore = createMemoryPlanStore();
    seedDemoWeek({ store: planStore, userId: USER, firstDay: "2026-11-23", newId: () => "week-1" });
    const app = await createApp(config, { planStore });
    const res = await app.inject({
      method: "GET",
      url: "/weeks/current",
      headers: { "x-user-id": USER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.week).toMatchObject({ id: "week-1", firstDay: "2026-11-23" });
  });

  it("is idempotent: a user with a week keeps it", () => {
    const store = createMemoryPlanStore();
    const args = { store, userId: USER, firstDay: "2026-11-23", newId: () => "a" };
    expect(seedDemoWeek(args)).toBe("seeded");
    expect(seedDemoWeek({ ...args, newId: () => "b" })).toBe("exists");
    expect(store.allWeeks()).toHaveLength(1);
  });

  it("seeds a week whose review is ready, so the review screen answers 200", async () => {
    const planStore = createMemoryPlanStore();
    seedDemoWeek({ store: planStore, userId: USER, firstDay: "2026-11-23", newId: () => "week-1" });
    const app = await createApp(config, { planStore });
    const res = await app.inject({
      method: "GET",
      url: "/weeks/week-1/review",
      headers: { "x-user-id": USER },
    });
    expect(res.statusCode).toBe(200);
  });
});
