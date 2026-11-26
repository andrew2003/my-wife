import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import {
  createOnboardingHandler,
  DEFAULT_SAMPLE_TOTAL_VND,
  MemorySampleBudgetStore,
} from "../src/onboarding";

function setup(
  opts: {
    totalVnd?: number;
    failPublish?: boolean;
    now?: Date;
    settings?: Record<string, unknown>;
  } = {},
) {
  const store = new MemorySampleBudgetStore();
  const published: EventEnvelope[] = [];
  let n = 0;
  let failPublish = opts.failPublish ?? false;
  const handler = createOnboardingHandler({
    store,
    locale: "en",
    now: () => opts.now ?? new Date("2026-03-02T10:00:00Z"),
    newId: () => `id-${++n}`,
    readSettings: async () => opts.settings ?? {},

    totalVnd: opts.totalVnd === undefined ? undefined : () => opts.totalVnd!,
    publish: async (e) => {
      if (failPublish) throw new Error("nats down");
      published.push(e);
    },
  });
  return { store, published, handler, heal: () => (failPublish = false) };
}

const event = (step: string, skipped: boolean, userId = "u1"): EventEnvelope =>
  ({
    id: "e1",
    type: "onboarding.step_completed",
    occurredAt: "2026-03-02T09:00:00Z",
    userId,
    schemaVersion: 1,
    payload: { step, skipped },
  }) as EventEnvelope;

const total = (d: { categories: { cycleLimitVnd: number }[] }) =>
  d.categories.reduce((a, c) => a + c.cycleLimitVnd, 0);

describe("sample budget on onboarding.step_completed", () => {
  it("with no answers, creates a draft cycle with the standard category set", async () => {
    const { handler, store, published } = setup();
    await handler(event("qa_templates", true));
    const draft = store.get("u1")!;
    expect(draft.cycle).toMatchObject({ state: "draft", sequence: 1, weeks: 4 });
    expect(draft.categories).toHaveLength(11);
    expect(total(draft)).toBe(DEFAULT_SAMPLE_TOTAL_VND);
    expect(draft.categories.find((c) => c.shortCode === "AN")?.name).toBe("Food");
    expect(draft.accounts.map((a) => a.kind).sort()).toEqual([
      "penalty_savings",
      "savings",
      "spending",
    ]);
    expect(draft.audit).toHaveLength(1);
    expect(published.map((e) => e.type)).toEqual(["cycle.draft_created"]);
    expect(published[0]!.payload).toMatchObject({ cycleId: draft.cycle.id, sequence: 1 });
  });

  it("with a total of 10,000,000 VND, limits sum exactly", async () => {
    const { handler, store } = setup({ totalVnd: 10_000_000 });
    await handler(event("qa_templates", false));
    expect(total(store.get("u1")!)).toBe(10_000_000);
  });

  it("uses an odd total exactly too", async () => {
    const { handler, store } = setup({ totalVnd: 12_345_678 });
    await handler(event("qa_templates", false));
    expect(total(store.get("u1")!)).toBe(12_345_678);
  });

  it.each([true, false])(
    "generates once when consumed repeatedly (skipped=%s)",
    async (skipped) => {
      const { handler, store, published } = setup();
      await handler(event("qa_templates", skipped));
      await handler(event("qa_templates", !skipped));
      expect(store.count()).toBe(1);
      expect(published).toHaveLength(1);
    },
  );

  it("ignores other steps", async () => {
    const { handler, store, published } = setup();
    await handler(event("tour", false));
    expect(store.get("u1")).toBeUndefined();
    expect(published).toHaveLength(0);
  });

  it("keeps drafts of different users apart", async () => {
    const { handler, store } = setup();
    await handler(event("qa_templates", true, "u1"));
    await handler(event("qa_templates", true, "u2"));
    expect(store.count()).toBe(2);
  });

  it("announces again after a failed publish without duplicating the draft", async () => {
    const { handler, store, published, heal } = setup({ failPublish: true });
    await expect(handler(event("qa_templates", true))).rejects.toThrow("nats down");
    heal();
    await handler(event("qa_templates", true));
    expect(store.count()).toBe(1);
    expect(published).toHaveLength(1);
    await handler(event("qa_templates", true));
    expect(published).toHaveLength(1);
  });

  it("publishes once when two deliveries arrive in parallel", async () => {
    const { handler, store, published } = setup();
    await Promise.all([
      handler(event("qa_templates", true)),
      handler(event("qa_templates", false)),
    ]);
    expect(store.count()).toBe(1);
    expect(published).toHaveLength(1);
  });

  it("a parallel delivery during a failing publish does not publish twice", async () => {
    const { handler, published, heal } = setup({ failPublish: true });
    const results = await Promise.allSettled([
      handler(event("qa_templates", true)),
      handler(event("qa_templates", true)),
    ]);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    heal();
    await handler(event("qa_templates", true));
    expect(published).toHaveLength(1);
  });

  it("honors the user's cycle weeks and rounding settings", async () => {
    const { handler, store } = setup({
      totalVnd: 10_500,
      settings: { "budget.cycle_weeks": 2, "budget.weekly_limit_rounding_vnd": 500 },
    });
    await handler(event("qa_templates", false));
    const draft = store.get("u1")!;
    expect(draft.cycle.weeks).toBe(2);
    expect(draft.categories.every((c) => c.cycleLimitVnd % 500 === 0)).toBe(true);
    expect(total(draft)).toBe(10_500);
  });

  it("falls back to defaults for invalid settings", async () => {
    const { handler, store } = setup({
      settings: { "budget.cycle_weeks": -3, "calendar.time_zone": "Not/AZone" },
    });
    await handler(event("qa_templates", false));
    expect(store.get("u1")!.cycle.weeks).toBe(4);
  });

  describe("first day in the user's time zone", () => {
    const cases = [
      {
        name: "18:00 UTC is already the next day in Ho Chi Minh",
        at: "2026-03-02T18:00:00Z",
        zone: undefined,
        expected: "2026-03-03",
      },
      {
        name: "16:59 UTC is still the same day in Ho Chi Minh",
        at: "2026-03-02T16:59:00Z",
        zone: undefined,
        expected: "2026-03-02",
      },
      {
        name: "17:00 UTC is the next day in Ho Chi Minh",
        at: "2026-03-02T17:00:00Z",
        zone: undefined,
        expected: "2026-03-03",
      },
      {
        name: "a user zone behind UTC",
        at: "2026-03-02T03:00:00Z",
        zone: "America/New_York",
        expected: "2026-03-01",
      },
    ];
    it.each(cases)("$name", async ({ at, zone, expected }) => {
      const { handler, store } = setup({
        now: new Date(at),
        settings: zone ? { "calendar.time_zone": zone } : {},
      });
      await handler(event("qa_templates", true));
      expect(store.get("u1")!.cycle.firstDay).toBe(expected);
    });
  });
});
