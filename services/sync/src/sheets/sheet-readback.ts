import type {
  CellRejectReason,
  ConflictWinner,
  ReadbackPauseReason,
  SheetKind,
} from "@my-wife/contracts";
import { SHEET_TABS, type CycleSnapshot, type SheetEntry, type SheetTab } from "./sheet-sync";

/** Port to read a tab back from Google Sheets; tests use a fake. */
export interface SheetsReader {
  readTab(accessToken: string, ref: string, tab: string): Promise<string[][]>;
}

export interface SheetsWriter {
  writeTab(accessToken: string, ref: string, tab: string, rows: string[][]): Promise<void>;
}

export type CellValidation = { ok: true } | { ok: false; reason: CellRejectReason };

/** Where a cell sits in the cycle, so the owning service can decide if it is editable. */
export type CellContext = { cycleId: string; firstDay: string; now: Date };

export type ConflictRecord = {
  cycleId: string;
  tab: SheetTab;
  row: number;
  col: number;
  sheetValue: string;
  appValue: string;
  winner: ConflictWinner;
};

export type RevertAudit = {
  cycleId: string;
  tab: SheetTab;
  row: number;
  col: number;
  reason: CellRejectReason;
  sheetValue: string;
  storedValue: string;
  at: Date;
};

/** Tabs that rest on receipts or booked facts: read-back never changes them (ADR 0015). */
const FACT_TABS: ReadonlySet<SheetTab> = new Set(["ledger", "accounts", "surplusGoals"]);

export type ReadbackDeps = {
  reader: SheetsReader;
  writer: SheetsWriter;
  map: { get(userId: string, cycleId: string): Promise<SheetEntry | undefined> };
  snapshots: { get(userId: string, cycleId: string): Promise<CycleSnapshot> };
  accessToken(userId: string): Promise<string | null>;
  /** Setting `sync.sheet_readback_enabled` (default on). */
  settings: { readbackEnabled(userId: string): Promise<boolean> };
  /** Last-synced value per cell, keyed `tab:row:col`; missing means "same as the database". */
  baseline: {
    load(userId: string, cycleId: string): Promise<Record<string, string> | undefined>;
    save(userId: string, cycleId: string, cells: Record<string, string>): Promise<void>;
  };
  /** Protected ranges: false for computed and locked cells. Row index is without the banner. */
  isEditable(tab: SheetTab, row: number, col: number, ctx: CellContext): boolean;
  /** Past weeks are read-only. */
  isPastWeek(tab: SheetTab, row: number, ctx: CellContext): boolean;
  /** The same validation as a web edit, done by the owning service. Values are plain data. */
  validate(
    tab: SheetTab,
    row: number,
    col: number,
    value: string,
    userId: string,
  ): Promise<CellValidation>;
  /** Writes through the owning service (plan data only). */
  apply(
    userId: string,
    cycleId: string,
    tab: SheetTab,
    row: number,
    col: number,
    value: string,
  ): Promise<void>;
  /** Last write wins per cell; the wiring compares the write times of both sides. */
  resolveConflict(userId: string, rec: Omit<ConflictRecord, "winner">): Promise<ConflictWinner>;
  /** Stores both values; returns the conflict id. */
  conflicts: { record(userId: string, rec: ConflictRecord): Promise<string> };
  inbox: {
    notify(userId: string, notice: { kind: "sync_conflict"; conflictId: string }): Promise<void>;
  };
  /** Audit trail of every reverted cell. */
  audit: { record(userId: string, entry: RevertAudit): Promise<void> };
  pause: {
    isPaused(userId: string): Promise<boolean>;
    set(userId: string, paused: boolean): Promise<void>;
  };
  /** Tells the user that read-back is paused and why. */
  askUser(userId: string, reason: ReadbackPauseReason, message: string): Promise<void>;
  publish(type: string, payload: unknown): Promise<void>;
  labels(key: string): string;
};

export type ReadbackResult =
  | { status: "disabled" | "paused" | "skipped" }
  | { status: "done"; applied: number; reverted: number };

/** Trims and removes thousands separators so "3,000,000" equals "3000000". */
export function normalizeCell(v: string): string {
  const t = v.trim();
  return /^-?\d{1,3}([,. ]\d{3})+$/.test(t) ? t.replace(/[,. ]/g, "") : t;
}

const cellKey = (tab: SheetTab, row: number, col: number) => `${tab}:${row}:${col}`;

type Edit = { tab: SheetTab; row: number; col: number; value: string };

export class SheetReadbackService {
  constructor(private readonly deps: ReadbackDeps) {}

  /** Reads edits back, applies the valid ones and reverts everything else. */
  async readBack(
    userId: string,
    cycleId: string,
    now: Date,
    sheet: SheetKind = "budget",
  ): Promise<ReadbackResult> {
    const d = this.deps;
    // The off switch comes first: nothing below touches Google, the pause store or tokens.
    if (!(await d.settings.readbackEnabled(userId))) return { status: "disabled" };
    if (await d.pause.isPaused(userId)) return { status: "paused" };
    const entry = await d.map.get(userId, cycleId);
    if (!entry || entry.frozen) return { status: "skipped" };
    const token = await d.accessToken(userId);
    if (!token) return { status: "skipped" };

    const snap = await d.snapshots.get(userId, cycleId);
    const base = (await d.baseline.load(userId, cycleId)) ?? {};
    const ctx: CellContext = { cycleId, firstDay: snap.firstDay, now };
    const sheetRows = new Map<SheetTab, string[][]>();
    const edits: Edit[] = [];
    for (const tab of SHEET_TABS) {
      const rows = await d.reader.readTab(token, entry.ref, d.labels(`sync.tab.${tab}`));
      const expected = snap.tabs[tab];
      if (rows.length === 0) return this.pauseReadback(userId, sheet, "structure_changed");
      if (!this.wellFormed(rows, expected)) {
        return this.pauseReadback(userId, sheet, "malformed_sheet");
      }
      sheetRows.set(tab, rows);
      expected.forEach((expRow, r) =>
        expRow.forEach((cell, c) => {
          const value = rows[r + 1]![c]!;
          const baseline = base[cellKey(tab, r, c)] ?? cell;
          if (normalizeCell(value) !== normalizeCell(baseline)) {
            edits.push({ tab, row: r, col: c, value });
          }
        }),
      );
    }

    let applied = 0;
    const reverted = new Map<CellRejectReason, number>();
    const revert = async (e: Edit, reason: CellRejectReason) => {
      reverted.set(reason, (reverted.get(reason) ?? 0) + 1);
      await d.audit.record(userId, {
        cycleId,
        tab: e.tab,
        row: e.row,
        col: e.col,
        reason,
        sheetValue: e.value,
        storedValue: snap.tabs[e.tab][e.row]![e.col]!,
        at: now,
      });
    };
    for (const e of edits) {
      if (FACT_TABS.has(e.tab)) {
        await revert(e, "booked_fact");
        continue;
      }
      if (d.isPastWeek(e.tab, e.row, ctx)) {
        await revert(e, "past_week");
        continue;
      }
      if (!d.isEditable(e.tab, e.row, e.col, ctx)) {
        await revert(e, "locked_cell");
        continue;
      }
      const res = await d.validate(e.tab, e.row, e.col, e.value, userId);
      if (!res.ok) {
        await revert(e, res.reason);
        continue;
      }
      const appValue = snap.tabs[e.tab][e.row]![e.col]!;
      const baseline = base[cellKey(e.tab, e.row, e.col)] ?? appValue;
      if (normalizeCell(appValue) === normalizeCell(e.value)) continue;
      if (normalizeCell(appValue) !== normalizeCell(baseline)) {
        // Both sides changed since the last sync: last write wins, both values are kept.
        const rec = {
          cycleId,
          tab: e.tab,
          row: e.row,
          col: e.col,
          sheetValue: e.value,
          appValue,
        };
        const winner = await d.resolveConflict(userId, rec);
        const conflictId = await d.conflicts.record(userId, { ...rec, winner });
        await d.inbox.notify(userId, { kind: "sync_conflict", conflictId });
        await d.publish("sync.conflict_resolved", { conflictId, winner });
        if (winner === "app") continue;
      }
      await d.apply(userId, cycleId, e.tab, e.row, e.col, e.value);
      applied++;
    }

    if (applied > 0) await d.publish("sync.readback_applied", { sheet, cellCount: applied });
    for (const [reason, cellCount] of reverted) {
      await d.publish("sync.readback_reverted", { sheet, cellCount, reason });
    }

    // Rewrite from the database so reverted and stale cells return to the stored value.
    const fresh = await d.snapshots.get(userId, cycleId);
    const banner = [d.labels("sync.sheet.banner")];
    const cells: Record<string, string> = {};
    for (const tab of SHEET_TABS) {
      const rows = fresh.tabs[tab];
      rows.forEach((row, r) => row.forEach((v, c) => (cells[cellKey(tab, r, c)] = v)));
      const current = sheetRows.get(tab)!;
      const differs = rows.some((row, r) =>
        row.some((v, c) => normalizeCell(current[r + 1]![c]!) !== normalizeCell(v)),
      );
      if (differs) {
        await d.writer.writeTab(token, entry.ref, d.labels(`sync.tab.${tab}`), [banner, ...rows]);
      }
    }
    await d.baseline.save(userId, cycleId, cells);
    const total = [...reverted.values()].reduce((a, b) => a + b, 0);
    return { status: "done", applied, reverted: total };
  }

  /** The user fixed the sheet and asked to continue. */
  async resume(userId: string): Promise<void> {
    await this.deps.pause.set(userId, false);
  }

  /** Same shape as the stored tab: banner row plus equal row and column counts. */
  private wellFormed(rows: string[][], expected: string[][]): boolean {
    if (!Array.isArray(rows) || rows.length !== expected.length + 1) return false;
    // The banner doubles as the structure marker: write and check use the same label.
    if (rows[0]?.[0] !== this.deps.labels("sync.sheet.banner")) return false;
    return expected.every((exp, r) => {
      const row = rows[r + 1];
      return (
        Array.isArray(row) && row.length === exp.length && row.every((v) => typeof v === "string")
      );
    });
  }

  private async pauseReadback(
    userId: string,
    sheet: SheetKind,
    reason: ReadbackPauseReason,
  ): Promise<ReadbackResult> {
    await this.deps.pause.set(userId, true);
    await this.deps.askUser(userId, reason, this.deps.labels("sync.readback.paused"));
    await this.deps.publish("sync.readback_paused", { sheet, reason });
    return { status: "paused" };
  }
}
