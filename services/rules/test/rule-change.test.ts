import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import {
  classifyRuleChange,
  computeEffectiveFrom,
  createRuleChangeService,
  InMemoryRuleChangeStore,
  isLooseningChange,
} from "../src/rule-change";

const USER = "11111111-1111-4111-8111-111111111111";

describe("isLooseningChange", () => {
  const rows: [string, string, unknown, unknown, boolean][] = [
    ["lower weekly cap", "penalty.weekly_cap_vnd", 500000, 300000, true],
    ["higher weekly cap", "penalty.weekly_cap_vnd", 500000, 700000, false],
    ["same weekly cap", "penalty.weekly_cap_vnd", 500000, 500000, false],
    ["lower fault weight", "fault.weight.no_face", 2, 1, true],
    ["higher fault weight", "fault.weight.no_face", 2, 3, false],
    ["lower overspend percent", "penalty.overspend_percent", 100, 50, true],
    ["more waivers", "fault.waivers_per_week", 2, 3, true],
    ["fewer waivers", "fault.waivers_per_week", 2, 1, false],
    ["need to warn only", "penalty.need_overspend_mode", "penalize", "warn_only", true],
    ["need to penalize", "penalty.need_overspend_mode", "warn_only", "penalize", false],
    ["commit switched off", "routine.wake.level", "commit", "off", true],
    ["commit to remind", "routine.wake.level", "commit", "remind", true],
    ["track to commit", "routine.sleep.level", "track", "commit", false],
    ["full to no camera", "monitor.supervision_level", "full", "no_camera", true],
    ["checklist to full", "monitor.supervision_level", "checklist_only", "full", false],
    [
      "threshold raised",
      "fault.thresholds",
      [{ points: 6, amountVnd: 20000 }],
      [{ points: 8, amountVnd: 20000 }],
      true,
    ],
    [
      "threshold amount lowered",
      "fault.thresholds",
      [{ points: 6, amountVnd: 20000 }],
      [{ points: 6, amountVnd: 10000 }],
      true,
    ],
    [
      "threshold tier removed",
      "fault.thresholds",
      [
        { points: 6, amountVnd: 20000 },
        { points: 12, amountVnd: 50000 },
      ],
      [{ points: 6, amountVnd: 20000 }],
      true,
    ],
    [
      "threshold tier added",
      "fault.thresholds",
      [{ points: 6, amountVnd: 20000 }],
      [
        { points: 6, amountVnd: 20000 },
        { points: 12, amountVnd: 50000 },
      ],
      false,
    ],
    [
      "threshold amount raised",
      "fault.thresholds",
      [{ points: 6, amountVnd: 20000 }],
      [{ points: 6, amountVnd: 30000 }],
      false,
    ],
    ["unrelated setting", "calendar.time_zone", "Asia/Ho_Chi_Minh", "UTC", false],
  ];
  it.each(rows)("%s", (_n, key, from, to, expected) => {
    expect(isLooseningChange(key, from, to)).toBe(expected);
    expect(classifyRuleChange(key, from, to)).toBe(expected ? "loosening" : "tightening");
  });
});

describe("computeEffectiveFrom", () => {
  // 2026-11-25 is a Wednesday. Ho Chi Minh is UTC+7.
  const base = { timeZone: "Asia/Ho_Chi_Minh", weekStartDay: "monday" as const };
  const rows: [string, string, Parameters<typeof computeEffectiveFrom>[0], string][] = [
    [
      "tightening is immediate",
      "2026-11-25T05:00:00.000Z",
      { ...base, direction: "tightening", scope: "next_week" },
      "2026-11-25T05:00:00.000Z",
    ],
    [
      "loosening on Wednesday waits for next Monday",
      "2026-11-25T05:00:00.000Z",
      { ...base, direction: "loosening", scope: "next_week" },
      "2026-11-29T17:00:00.000Z",
    ],
    [
      "loosening on the week start day waits a full week",
      "2026-11-23T05:00:00.000Z",
      { ...base, direction: "loosening", scope: "next_week" },
      "2026-11-29T17:00:00.000Z",
    ],
    [
      "local date differs from UTC date",
      "2026-11-29T18:00:00.000Z",
      { ...base, direction: "loosening", scope: "next_week" },
      "2026-12-06T17:00:00.000Z",
    ],
    [
      "sunday week start",
      "2026-11-25T05:00:00.000Z",
      { ...base, weekStartDay: "sunday", direction: "loosening", scope: "next_week" },
      "2026-11-28T17:00:00.000Z",
    ],
    [
      "next cycle scope",
      "2026-11-25T05:00:00.000Z",
      {
        ...base,
        direction: "loosening",
        scope: "next_cycle",
        nextCycleStartsAt: "2026-12-01T00:00:00.000Z",
      },
      "2026-12-01T00:00:00.000Z",
    ],
  ];
  it.each(rows)("%s", (_n, nowIso, input, expected) => {
    expect(computeEffectiveFrom(input, new Date(nowIso)).toISOString()).toBe(expected);
  });
});

describe("rule change service", () => {
  function setup(settings: Record<string, unknown> = {}) {
    const events: EventEnvelope[] = [];
    const store = new InMemoryRuleChangeStore();
    const service = createRuleChangeService({
      store,
      publish: (e) => void events.push(e),
      readSettings: () => settings,
      newId: () => "00000000-0000-4000-8000-000000000001",
    });
    return { events, store, service };
  }
  const now = new Date("2026-11-25T05:00:00.000Z");

  it("loosening on Wednesday is effective from the next week start", async () => {
    const { service, events, store } = setup();
    const r = await service.save(
      USER,
      { key: "penalty.weekly_cap_vnd", from: 500000, to: 300000 },
      now,
    );
    expect(r.direction).toBe("loosening");
    expect(r.effectiveFrom).toBe("2026-11-29T17:00:00.000Z");
    expect(store.list(USER)).toHaveLength(1);
    expect(events[0]?.type).toBe("rule.changed");
    expect(events[0]?.payload).toMatchObject({ effectiveFrom: "2026-11-29T17:00:00.000Z" });
  });

  it("tightening is effective immediately", async () => {
    const { service } = setup();
    const r = await service.save(
      USER,
      { key: "penalty.weekly_cap_vnd", from: 500000, to: 800000 },
      now,
    );
    expect(r.direction).toBe("tightening");
    expect(r.effectiveFrom).toBe(now.toISOString());
  });

  it("uses the user's week start setting", async () => {
    const { service } = setup({ "calendar.week_start_day": "sunday" });
    const r = await service.save(USER, { key: "fault.weight.no_face", from: 2, to: 1 }, now);
    expect(r.effectiveFrom).toBe("2026-11-28T17:00:00.000Z");
  });

  it("falls back to the registry default for an invalid setting", async () => {
    const { service } = setup({ "calendar.week_start_day": "someday" });
    const r = await service.save(USER, { key: "fault.weight.no_face", from: 2, to: 1 }, now);
    expect(r.effectiveFrom).toBe("2026-11-29T17:00:00.000Z");
  });
});
