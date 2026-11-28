import { randomUUID } from "node:crypto";
import type { ConflictWinner, ReadbackConflictRecordSchema, SheetKind } from "@my-wife/contracts";
import type { ConflictRecord, ReadbackDeps } from "./sheet-readback";

/** Longest cell value copied into an inbox notice; the audit record keeps the full value. */
const NOTICE_VALUE_LIMIT = 80;

export type ConflictCell = Omit<ConflictRecord, "winner">;

export type ConflictClock = {
  /** When the app side of the cell last changed. */
  appChangedAt(userId: string, cell: ConflictCell): Promise<Date>;
  /** When the sheet side last changed (Drive revision time, or the read time as a fallback). */
  sheetChangedAt(userId: string, cell: ConflictCell): Promise<Date>;
};

/** Last write wins per cell. On a tie the stored app value stays, so nothing is applied. */
export function createLastWriteResolver(clock: ConflictClock): ReadbackDeps["resolveConflict"] {
  return async (userId, cell) => {
    const [app, sheet] = await Promise.all([
      clock.appChangedAt(userId, cell),
      clock.sheetChangedAt(userId, cell),
    ]);
    const winner: ConflictWinner = sheet.getTime() > app.getTime() ? "sheet" : "app";
    return winner;
  };
}

export type ConflictLogOptions = ConflictClock & {
  now(): Date;
  newId?(): string;
  sheet?: SheetKind;
};

type ReadbackConflictRecord = ReturnType<typeof ReadbackConflictRecordSchema.parse>;

const cellRef = (c: Pick<ConflictRecord, "tab" | "row" | "col">) =>
  `${c.tab}!R${c.row + 1}C${c.col + 1}`;

/** Audit store for resolved conflicts; both values and both change times are kept. */
export function createConflictLog(opts: ConflictLogOptions) {
  const byUser = new Map<string, Map<string, ReadbackConflictRecord>>();
  const bucket = (userId: string) => {
    let b = byUser.get(userId);
    if (!b) byUser.set(userId, (b = new Map()));
    return b;
  };
  return {
    async record(userId: string, rec: ConflictRecord): Promise<string> {
      const [appAt, sheetAt] = await Promise.all([
        opts.appChangedAt(userId, rec),
        opts.sheetChangedAt(userId, rec),
      ]);
      const id = (opts.newId ?? randomUUID)();
      bucket(userId).set(id, {
        id,
        sheet: opts.sheet ?? "budget",
        tab: rec.tab,
        cellRef: cellRef(rec),
        field: `${rec.tab}.col${rec.col + 1}`,
        appValue: rec.appValue,
        sheetValue: rec.sheetValue,
        appChangedAt: appAt.toISOString(),
        sheetChangedAt: sheetAt.toISOString(),
        winner: rec.winner,
        resolvedAt: opts.now().toISOString(),
      });
      return id;
    },
    async get(userId: string, id: string): Promise<ReadbackConflictRecord | undefined> {
      return byUser.get(userId)?.get(id);
    },
    async list(userId: string): Promise<ReadbackConflictRecord[]> {
      return [...(byUser.get(userId)?.values() ?? [])];
    },
  };
}

export type ConflictLog = ReturnType<typeof createConflictLog>;

/** Port to the notify inbox ("Messages"); notify owns delivery, sync only hands over the notice. */
export type Notice = { kind: "sync_conflict"; refId: string; title: string; body: string };
export type NoticeSender = { send(userId: string, notice: Notice): Promise<void> };

/** Builds the localized inbox notice for a resolved conflict. */
export function createConflictInbox(deps: {
  sender: NoticeSender;
  log: Pick<ConflictLog, "get">;
  labels(key: string): string;
}): ReadbackDeps["inbox"] {
  const clip = (v: string) =>
    v.length > NOTICE_VALUE_LIMIT ? `${v.slice(0, NOTICE_VALUE_LIMIT)}…` : v;
  return {
    async notify(userId, notice) {
      const rec = await deps.log.get(userId, notice.conflictId);
      if (!rec) return;
      const fill: Record<string, string> = {
        cell: rec.cellRef,
        tab: deps.labels(`sync.tab.${rec.tab}`),
        appValue: clip(String(rec.appValue)),
        sheetValue: clip(String(rec.sheetValue)),
        winner: deps.labels(`sync.conflict.winner.${rec.winner}`),
      };
      const body = deps
        .labels("sync.conflict.notice")
        .replace(/\{(\w+)\}/g, (m, k: string) => fill[k] ?? m);
      await deps.sender.send(userId, {
        kind: "sync_conflict",
        refId: rec.id,
        title: deps.labels("sync.conflict.title"),
        body,
      });
    },
  };
}
