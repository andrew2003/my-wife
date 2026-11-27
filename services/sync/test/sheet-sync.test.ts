import { describe, expect, it } from "vitest";
import {
  InMemorySheetMap,
  SheetSyncService,
  SHEET_TABS,
  type CycleSnapshot,
  type SheetsClient,
} from "../src/sheets/sheet-sync";

const NOW = new Date("2026-11-27T00:00:00Z");
const OPENED = { cycleId: "c1", sequence: 3, firstDay: "2026-12-01" };

function setup(opts: { token?: string | null } = {}) {
  const cells = new Map<string, string[][]>();
  const created: { title: string; tabs: string[]; folderId?: string }[] = [];
  const client: SheetsClient = {
    createSpreadsheet: async (_t, p) => {
      created.push(p);
      return `sheet-${created.length}`;
    },
    writeTab: async (_t, ref, tab, rows) => {
      // Copy like a remote store would, so a cell edit never touches the database snapshot.
      cells.set(
        `${ref}:${tab}`,
        rows.map((r) => [...r]),
      );
    },
  };
  const snapshot: CycleSnapshot = {
    title: "Cycle 3",
    firstDay: "2026-12-01",
    closed: false,
    tabs: {
      categories: [["Food", "3000000"]],
      accounts: [["Main", "1000000"]],
      weeklyPlan: [["1", "Plan"]],
      ledger: [["t1", "50000"]],
      surplusGoals: [["Goal", "0"]],
    },
  };
  const published: { type: string; payload: unknown }[] = [];
  const svc = new SheetSyncService({
    client,
    map: new InMemorySheetMap(),
    snapshots: { get: async () => snapshot },
    accessToken: async () => (opts.token === undefined ? "tok" : opts.token),
    folderId: async () => "folder-1",
    publish: async (type, payload) => {
      published.push({ type, payload });
    },
    labels: (key) => `L:${key}`,
  });
  return { svc, cells, created, published, snapshot };
}

describe("sheet per cycle", () => {
  it("creates a Sheet with all tabs and emits sync.sheet_created on cycle.opened (criterion 1)", async () => {
    const { svc, created, published, cells } = setup();
    await svc.onCycleOpened("u1", OPENED, NOW);
    expect(created).toHaveLength(1);
    expect(created[0]?.tabs).toHaveLength(SHEET_TABS.length);
    expect(SHEET_TABS).toHaveLength(5);
    expect(created[0]?.folderId).toBe("folder-1");
    expect(published).toEqual([
      { type: "sync.sheet_created", payload: { cycleId: "c1", spreadsheetRef: "sheet-1" } },
    ]);
    for (const tab of SHEET_TABS) expect(cells.has(`sheet-1:L:sync.tab.${tab}`)).toBe(true);
  });

  it("puts the overwrite banner on top of every tab", async () => {
    const { svc, cells } = setup();
    await svc.onCycleOpened("u1", OPENED, NOW);
    for (const rows of cells.values()) expect(rows[0]).toEqual(["L:sync.sheet.banner"]);
  });

  it("is idempotent: a repeated cycle.opened creates no second sheet", async () => {
    const { svc, created, published } = setup();
    await svc.onCycleOpened("u1", OPENED, NOW);
    await svc.onCycleOpened("u1", OPENED, NOW);
    expect(created).toHaveLength(1);
    expect(published).toHaveLength(1);
  });

  it("overwrites an edited cell from the database on the next sync (criterion 2)", async () => {
    const { svc, cells } = setup();
    await svc.onCycleOpened("u1", OPENED, NOW);
    const key = "sheet-1:L:sync.tab.categories";
    cells.get(key)![1]![1] = "999"; // user edit
    await svc.refresh("u1", "c1", NOW);
    expect(cells.get(key)![1]![1]).toBe("3000000");
  });

  it("makes no Google call when no token is available", async () => {
    const { svc, created, published } = setup({ token: null });
    await svc.onCycleOpened("u1", OPENED, NOW);
    expect(created).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it("does nothing for a refresh of a cycle without a sheet", async () => {
    const { svc, cells } = setup();
    await svc.refresh("u1", "c9", NOW);
    expect(cells.size).toBe(0);
  });

  it("gives a closed cycle one last update and then leaves it alone", async () => {
    const { svc, cells } = setup();
    await svc.onCycleOpened("u1", OPENED, NOW);
    await svc.onCycleClosed("u1", { cycleId: "c1" }, NOW);
    const key = "sheet-1:L:sync.tab.ledger";
    cells.get(key)![1]![1] = "edited";
    await svc.refresh("u1", "c1", NOW);
    expect(cells.get(key)![1]![1]).toBe("edited");
  });
});
