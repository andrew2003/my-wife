import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BankAccountSchema,
  BudgetCategorySchema,
  BudgetCycleSchema,
  InvitationSchema,
  PlannedItemSchema,
  ScheduleWeekSchema,
  TaskSchema,
  UserSchema,
} from "@my-wife/contracts";
import { applySeed, buildSeed, FileSeedStore, MemorySeedStore } from "../src/seed";

const NOW = new Date("2026-11-02T03:00:00.000Z"); // Monday

describe("buildSeed", () => {
  const seed = buildSeed(NOW);

  it("produces records that satisfy the contract schemas", () => {
    UserSchema.parse(seed.user);
    InvitationSchema.parse(seed.invitation);
    seed.bankAccounts.forEach((r) => BankAccountSchema.parse(r));
    seed.categories.forEach((r) => BudgetCategorySchema.parse(r));
    seed.plannedItems.forEach((r) => PlannedItemSchema.parse(r));
    BudgetCycleSchema.parse(seed.cycle);
    ScheduleWeekSchema.parse(seed.scheduleWeek);
    seed.tasks.forEach((r) => TaskSchema.parse(r));
  });

  it("is deterministic for the same time", () => {
    expect(buildSeed(NOW)).toEqual(seed);
  });

  it("covers every priority and keeps references consistent", () => {
    expect(new Set(seed.categories.map((c) => c.priority))).toEqual(
      new Set(["need", "should", "want", "fund"]),
    );
    const accountIds = new Set(seed.bankAccounts.map((a) => a.id));
    const categoryIds = new Set(seed.categories.map((c) => c.id));
    expect(seed.categories.every((c) => accountIds.has(c.bankAccountId))).toBe(true);
    expect(seed.plannedItems.every((p) => categoryIds.has(p.categoryId))).toBe(true);
  });

  it("aligns the cycle and the schedule week to the week of the given time", () => {
    expect(seed.cycle.firstDay).toBe("2026-11-02");
    expect(seed.scheduleWeek.firstDay).toBe("2026-11-02");
    expect(seed.tasks.every((t) => t.day >= "2026-11-02" && t.day <= "2026-11-08")).toBe(true);
  });

  it("uses an example email domain for the demo user", () => {
    expect(seed.user.email.endsWith("@example.test")).toBe(true);
  });
});

describe("applySeed", () => {
  it("creates everything once and is a no-op the second time", async () => {
    const store = new MemorySeedStore();
    const first = await applySeed(store, buildSeed(NOW));
    expect(first.created).toBeGreaterThan(0);
    expect(first.updated).toBe(0);
    const snapshot = JSON.stringify(store.snapshot());
    const second = await applySeed(store, buildSeed(NOW));
    expect(second).toEqual({ created: 0, updated: 0, unchanged: first.created });
    expect(JSON.stringify(store.snapshot())).toBe(snapshot);
  });

  it("is idempotent for a later instant in the same week", async () => {
    const store = new MemorySeedStore();
    await applySeed(store, buildSeed(NOW));
    const res = await applySeed(store, buildSeed(new Date("2026-11-04T09:30:00.000Z")));
    expect(res.created + res.updated).toBe(0);
  });

  it("updates a record whose content drifted back to the seed value", async () => {
    const store = new MemorySeedStore();
    await applySeed(store, buildSeed(NOW));
    await store.upsert("category", "seed-cat-rent", { tampered: true });
    const res = await applySeed(store, buildSeed(NOW));
    expect(res.updated).toBe(1);
  });
});

describe("FileSeedStore", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "seed-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("persists between runs and stays idempotent", async () => {
    const file = join(dir, "nested", "seed.json");
    const a = await applySeed(new FileSeedStore(file), buildSeed(NOW));
    const content = readFileSync(file, "utf8");
    const b = await applySeed(new FileSeedStore(file), buildSeed(NOW));
    expect(b.created).toBe(0);
    expect(b.unchanged).toBe(a.created);
    expect(readFileSync(file, "utf8")).toBe(content);
  });
});
