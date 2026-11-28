import { ReadbackConflictRecordSchema } from "@my-wife/contracts";
import { describe, expect, it } from "vitest";
import {
  createConflictInbox,
  createConflictLog,
  createLastWriteResolver,
  type NoticeSender,
} from "../src/sheets/sheet-conflicts";
import { SheetReadbackService, type ConflictRecord } from "../src/sheets/sheet-readback";
import { SHEET_TABS, type SheetTab } from "../src/sheets/sheet-sync";

const T1 = new Date("2026-11-28T08:00:00Z");
const T2 = new Date("2026-11-28T09:00:00Z");
const NOW = new Date("2026-11-28T10:00:00Z");
const rec: Omit<ConflictRecord, "winner"> = {
  cycleId: "c1",
  tab: "categories",
  row: 0,
  col: 2,
  sheetValue: "sheet edit",
  appValue: "app edit",
};
const labels = (k: string) =>
  k === "sync.conflict.notice"
    ? "Cell {cell} on {tab} changed in the app ({appValue}) and in the sheet ({sheetValue}). Kept: {winner}."
    : k === "sync.conflict.winner.sheet"
      ? "the sheet value"
      : k === "sync.conflict.winner.app"
        ? "the app value"
        : `L:${k}`;

const newLog = (id = "conflict-1") =>
  createConflictLog({
    appChangedAt: async () => T1,
    sheetChangedAt: async () => T2,
    now: () => NOW,
    newId: () => id,
  });

describe("last-write resolver", () => {
  const make = (app: Date, sheet: Date) =>
    createLastWriteResolver({
      appChangedAt: async () => app,
      sheetChangedAt: async () => sheet,
    });
  it.each([
    ["sheet later", T1, T2, "sheet"],
    ["app later", T2, T1, "app"],
    ["tie keeps the stored app value", T1, T1, "app"],
  ] as const)("%s", async (_n, app, sheet, winner) => {
    expect(await make(app, sheet)("u1", rec)).toBe(winner);
  });
});

describe("conflict log", () => {
  it("keeps both values with both times and matches the contract", async () => {
    const l = newLog();
    const id = await l.record("u1", { ...rec, winner: "sheet" });
    expect(id).toBe("conflict-1");
    const stored = await l.get("u1", id);
    expect(ReadbackConflictRecordSchema.parse(stored)).toMatchObject({
      appValue: "app edit",
      sheetValue: "sheet edit",
      winner: "sheet",
      appChangedAt: T1.toISOString(),
      sheetChangedAt: T2.toISOString(),
      resolvedAt: NOW.toISOString(),
    });
  });
  it("is scoped to the user", async () => {
    const l = newLog();
    const id = await l.record("u1", { ...rec, winner: "app" });
    expect(await l.get("u2", id)).toBeUndefined();
    expect(await l.list("u1")).toHaveLength(1);
  });
});

describe("conflict inbox notice", () => {
  it("sends a localized notice with both values to the inbox", async () => {
    const l = newLog();
    const id = await l.record("u1", { ...rec, winner: "sheet" });
    const sent: unknown[] = [];
    const sender: NoticeSender = { send: async (u, n) => void sent.push({ u, n }) };
    await createConflictInbox({ sender, log: l, labels }).notify("u1", {
      kind: "sync_conflict",
      conflictId: id,
    });
    expect(sent).toEqual([
      {
        u: "u1",
        n: {
          kind: "sync_conflict",
          refId: "conflict-1",
          title: "L:sync.conflict.title",
          body: "Cell categories!R1C3 on L:sync.tab.categories changed in the app (app edit) and in the sheet (sheet edit). Kept: the sheet value.",
        },
      },
    ]);
  });
  it("does nothing for an unknown conflict", async () => {
    const sent: unknown[] = [];
    const sender: NoticeSender = { send: async (_u, n) => void sent.push(n) };
    await createConflictInbox({ sender, log: newLog(), labels }).notify("u1", {
      kind: "sync_conflict",
      conflictId: "nope",
    });
    expect(sent).toEqual([]);
  });
  it("truncates long values in the notice", async () => {
    const l = newLog();
    const id = await l.record("u1", { ...rec, sheetValue: "x".repeat(500), winner: "sheet" });
    const sent: { body: string }[] = [];
    const sender: NoticeSender = { send: async (_u, n) => void sent.push(n) };
    await createConflictInbox({ sender, log: l, labels }).notify("u1", {
      kind: "sync_conflict",
      conflictId: id,
    });
    expect(sent[0]!.body.length).toBeLessThan(300);
  });
});

describe("two edits to one cell, synced (acceptance)", () => {
  it("last write wins, both values are audited and a notice is sent", async () => {
    const banner = ["L:sync.sheet.banner"];
    const tabs: Record<SheetTab, string[][]> = {
      categories: [["Food", "3000000", "app edit"]],
      accounts: [["Main", "1", ""]],
      weeklyPlan: [["1", "Plan", ""]],
      ledger: [["t1", "5", ""]],
      surplusGoals: [["Goal", "0", ""]],
    };
    const remote = new Map<string, string[][]>();
    for (const t of SHEET_TABS) {
      remote.set(`L:sync.tab.${t}`, [banner, ...tabs[t].map((r) => [...r])]);
    }
    remote.get("L:sync.tab.categories")![1]![2] = "sheet edit";
    const log = newLog();
    const sent: { body: string }[] = [];
    const applied: string[] = [];
    const svc = new SheetReadbackService({
      reader: { readTab: async (_t, _r, tab) => remote.get(tab)!.map((r) => [...r]) },
      writer: { writeTab: async () => {} },
      map: { get: async () => ({ ref: "s", frozen: false }) },
      snapshots: {
        get: async () => ({ title: "t", firstDay: "2026-12-01", closed: false, tabs }),
      },
      accessToken: async () => "tok",
      settings: { readbackEnabled: async () => true },
      baseline: { load: async () => ({ "categories:0:2": "note" }), save: async () => {} },
      isEditable: () => true,
      isPastWeek: () => false,
      validate: async () => ({ ok: true }),
      apply: async (_u, _c, _t, _r, _co, v) => void applied.push(v),
      resolveConflict: createLastWriteResolver({
        appChangedAt: async () => T1,
        sheetChangedAt: async () => T2,
      }),
      conflicts: log,
      inbox: createConflictInbox({
        sender: { send: async (_u, n) => void sent.push(n) },
        log,
        labels,
      }),
      audit: { record: async () => {} },
      pause: { isPaused: async () => false, set: async () => {} },
      askUser: async () => {},
      publish: async () => {},
      labels: (k) => `L:${k}`,
    });
    await svc.readBack("u1", "c1", NOW);
    expect(applied).toEqual(["sheet edit"]);
    const [stored] = await log.list("u1");
    expect(stored).toMatchObject({
      appValue: "app edit",
      sheetValue: "sheet edit",
      winner: "sheet",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("app edit");
    expect(sent[0]!.body).toContain("sheet edit");
  });
});
