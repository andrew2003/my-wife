import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";

const NOW = new Date("2026-03-05T10:00:00Z");
const DAY_MS = 86_400_000;
const dayAfter = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

function weekPlanned(firstDay: string, plannedItems?: unknown, userId = "u1"): EventEnvelope {
  return {
    id: `wp-${firstDay}`,
    type: "week.planned",
    occurredAt: NOW.toISOString(),
    userId,
    schemaVersion: 1,
    payload: {
      weekId: "11111111-1111-4111-8111-111111111111",
      firstDay,
      ...(plannedItems === undefined ? {} : { plannedItems }),
    },
  } as unknown as EventEnvelope;
}

async function wired() {
  const store = new MemorySampleBudgetStore();
  let n = 0;
  await createOnboardingHandler({
    store,
    locale: "en",
    now: () => NOW,
    newId: () => `id-${++n}`,
    publish: () => undefined,
  })({
    id: "e0",
    type: "onboarding.step_completed",
    occurredAt: NOW.toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: { step: "qa_templates", skipped: true },
  } as EventEnvelope);
  const record = store.get("u1")!;
  record.cycle.state = "running";
  const category = record.categories.find((c) => c.shortCode === "AN")!;
  const published: EventEnvelope[] = [];
  const app = await createApp(loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" }), {
    store,
    now: () => NOW,
    publish: (e) => void published.push(e),
  });
  return { store, app, category, published, firstDay: record.cycle.firstDay };
}

describe("week.planned consumer (#310)", () => {
  it("publishes the carried items for the week index derived from firstDay", async () => {
    const s = await wired();
    await s.app.onWeekPlanned(
      weekPlanned(dayAfter(s.firstDay, 7), [{ categoryId: s.category.id, amountVnd: 70_000 }]),
    );
    const items = s.store.get("u1")!.plannedItems;
    expect(items.map((i) => i.transferCode)).toEqual(["MW-C01W2-AN-01"]);
    expect(items[0]!.amountVnd).toBe(70_000);
    expect(s.published.map((e) => e.type)).toEqual(["plan.week_published"]);
  });

  it("is idempotent under redelivery", async () => {
    const s = await wired();
    const ev = weekPlanned(s.firstDay, [{ categoryId: s.category.id, amountVnd: 1000 }]);
    await s.app.onWeekPlanned(ev);
    await s.app.onWeekPlanned(ev);
    expect(s.store.get("u1")!.plannedItems).toHaveLength(1);
    expect(s.published).toHaveLength(1);
  });

  it("ignores events without items, outside the cycle or off a week boundary", async () => {
    const s = await wired();
    const item = [{ categoryId: s.category.id, amountVnd: 1000 }];
    await s.app.onWeekPlanned(weekPlanned(s.firstDay));
    await s.app.onWeekPlanned(weekPlanned(s.firstDay, []));
    await s.app.onWeekPlanned(weekPlanned(dayAfter(s.firstDay, -7), item));
    await s.app.onWeekPlanned(weekPlanned(dayAfter(s.firstDay, 3), item));
    await s.app.onWeekPlanned(weekPlanned(dayAfter(s.firstDay, 7 * 99), item));
    expect(s.store.get("u1")!.plannedItems).toHaveLength(0);
    expect(s.published).toHaveLength(0);
  });

  it("drops invalid items and unknown categories without throwing", async () => {
    const s = await wired();
    await s.app.onWeekPlanned(
      weekPlanned(s.firstDay, [{ categoryId: s.category.id, amountVnd: 1.5 }]),
    );
    await s.app.onWeekPlanned(weekPlanned(s.firstDay, [{ categoryId: "nope", amountVnd: 1000 }]));
    expect(s.store.get("u1")!.plannedItems).toHaveLength(0);
  });

  it("ignores other event types and users without a cycle", async () => {
    const s = await wired();
    const item = [{ categoryId: s.category.id, amountVnd: 1000 }];
    await s.app.onWeekPlanned({ ...weekPlanned(s.firstDay, item), type: "week.closed" });
    await s.app.onWeekPlanned(weekPlanned(s.firstDay, item, "ghost"));
    expect(s.store.get("u1")!.plannedItems).toHaveLength(0);
  });
});
