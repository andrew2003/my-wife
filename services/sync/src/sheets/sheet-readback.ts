import type { CellRejectReason, ReadbackPauseReason, SheetKind } from "@my-wife/contracts";
import { SHEET_TABS, type CycleSnapshot, type SheetEntry, type SheetTab } from "./sheet-sync";

/** Port to read a tab back from Google Sheets; tests use a fake. */
export interface SheetsReader {
  readTab(accessToken: string, ref: string, tab: string): Promise<string[][]>;
}

export interface SheetsWriter {
  writeTab(accessToken: string, ref: string, tab: string, rows: string[][]): Promise<void>;
}

export type CellValidation = { ok: true } | { ok: false; reason: CellRejectReason };

export type ReadbackDeps = {
  reader: SheetsReader;
  writer: SheetsWriter;
  map: { get(userId: string, cycleId: string): Promise<SheetEntry | undefined> };
  snapshots: { get(userId: string, cycleId: string): Promise<CycleSnapshot> };
  accessToken(userId: string): Promise<string | null>;
  /** Setting `sync.sheet_readback_enabled` (default on). */
  settings: { readbackEnabled(userId: string): Promise<boolean> };
  /** Protected ranges: false for computed and locked cells. Row index is without the banner. */
  isEditable(tab: SheetTab, row: number, col: number): boolean;
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
  pause: {
    isPaused(userId: string): Promise<boolean>;
    set(userId: string, paused: boolean): Promise<void>;
  };
  /** Tells the user that read-back is paused and why. */
  askUser(userId: string, reason: ReadbackPauseReason): Promise<void>;
  publish(type: string, payload: unknown): Promise<void>;
  labels(key: string): string;
};

export type ReadbackResult =
  | { status: "disabled" | "paused" | "skipped" }
  | { status: "done"; applied: number; reverted: number };

type Edit = { tab: SheetTab; row: number; col: number; value: string };

export class SheetReadbackService {
  constructor(private readonly deps: ReadbackDeps) {}

  /** Reads edits back, applies the valid ones and reverts everything else. */
  async readBack(userId: string, cycleId: string, _now: Date): Promise<ReadbackResult> {
    const d = this.deps;
    // The off switch comes first: nothing below touches Google.
    if (!(await d.settings.readbackEnabled(userId))) return { status: "disabled" };
    if (await d.pause.isPaused(userId)) return { status: "paused" };
    const entry = await d.map.get(userId, cycleId);
    if (!entry || entry.frozen) return { status: "skipped" };
    const token = await d.accessToken(userId);
    if (!token) return { status: "skipped" };

    const snap = await d.snapshots.get(userId, cycleId);
    const edits: Edit[] = [];
    for (const tab of SHEET_TABS) {
      const rows = await d.reader.readTab(token, entry.ref, d.labels(`sync.tab.${tab}`));
      const expected = snap.tabs[tab];
      if (!this.wellFormed(rows, expected)) return this.pauseReadback(userId, "malformed_sheet");
      expected.forEach((expRow, r) =>
        expRow.forEach((cell, c) => {
          const value = rows[r + 1]![c]!;
          if (value !== cell) edits.push({ tab, row: r, col: c, value });
        }),
      );
    }

    let applied = 0;
    const reverted = new Map<CellRejectReason, number>();
    const revert = (reason: CellRejectReason) =>
      reverted.set(reason, (reverted.get(reason) ?? 0) + 1);
    for (const e of edits) {
      if (!d.isEditable(e.tab, e.row, e.col)) {
        revert("locked_cell");
        continue;
      }
      const res = await d.validate(e.tab, e.row, e.col, e.value, userId);
      if (!res.ok) {
        revert(res.reason);
        continue;
      }
      await d.apply(userId, cycleId, e.tab, e.row, e.col, e.value);
      applied++;
    }

    if (applied > 0) {
      await d.publish("sync.readback_applied", { sheet: "budget", cellCount: applied });
    }
    for (const [reason, cellCount] of reverted) {
      await d.publish("sync.readback_reverted", { sheet: "budget", cellCount, reason });
    }

    if (edits.length > 0) {
      // Rewrite from the database so reverted cells return to their stored value.
      const fresh = await d.snapshots.get(userId, cycleId);
      const banner = [d.labels("sync.sheet.banner")];
      for (const tab of SHEET_TABS) {
        await d.writer.writeTab(token, entry.ref, d.labels(`sync.tab.${tab}`), [
          banner,
          ...fresh.tabs[tab],
        ]);
      }
    }
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
    if (rows[0]?.[0] !== this.deps.labels("sync.sheet.banner")) return false;
    return expected.every((exp, r) => {
      const row = rows[r + 1];
      return (
        Array.isArray(row) && row.length === exp.length && row.every((v) => typeof v === "string")
      );
    });
  }

  private async pauseReadback(userId: string, reason: ReadbackPauseReason): Promise<ReadbackResult> {
    await this.deps.pause.set(userId, true);
    await this.deps.askUser(userId, reason);
    await this.deps.publish("sync.readback_paused", { sheet: "budget", reason });
    return { status: "paused" };
  }
}

export type { SheetKind };
