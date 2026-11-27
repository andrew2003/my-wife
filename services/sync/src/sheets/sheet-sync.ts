export const SHEET_TABS = [
  "categories",
  "accounts",
  "weeklyPlan",
  "ledger",
  "surplusGoals",
] as const;
export type SheetTab = (typeof SHEET_TABS)[number];

/** The database state of a cycle as rows of cells, one list per tab (without banner). */
export type CycleSnapshot = {
  title: string;
  firstDay: string;
  closed: boolean;
  tabs: Record<SheetTab, string[][]>;
};

/** Port to Google Sheets; the real HTTP client implements it, tests use a fake. */
export interface SheetsClient {
  createSpreadsheet(
    accessToken: string,
    p: { title: string; tabs: string[]; folderId?: string },
  ): Promise<string>;
  /** Replaces the whole tab content (idempotent full upsert). */
  writeTab(accessToken: string, ref: string, tab: string, rows: string[][]): Promise<void>;
}

export type SheetEntry = { ref: string; frozen: boolean };

/** Mapping `cycle id -> spreadsheet ref` (spec: mapping table). */
export interface SheetMap {
  get(userId: string, cycleId: string): Promise<SheetEntry | undefined>;
  put(userId: string, cycleId: string, v: SheetEntry): Promise<void>;
}

export class InMemorySheetMap implements SheetMap {
  private rows = new Map<string, SheetEntry>();
  async get(userId: string, cycleId: string) {
    return this.rows.get(`${userId}:${cycleId}`);
  }
  async put(userId: string, cycleId: string, v: SheetEntry) {
    this.rows.set(`${userId}:${cycleId}`, { ...v });
  }
}

export type SheetSyncDeps = {
  client: SheetsClient;
  map: SheetMap;
  snapshots: { get(userId: string, cycleId: string): Promise<CycleSnapshot> };
  /** Null when the link is unusable (revoked consent, not linked): no Google call is made. */
  accessToken(userId: string): Promise<string | null>;
  folderId(userId: string): Promise<string | undefined>;
  publish(
    type: "sync.sheet_created",
    payload: { cycleId: string; spreadsheetRef: string },
  ): Promise<void>;
  /** Locale lookup for tab names and the banner. */
  labels(key: string): string;
};

export class SheetSyncService {
  constructor(private readonly deps: SheetSyncDeps) {}

  private tabName(tab: SheetTab) {
    return this.deps.labels(`sync.tab.${tab}`);
  }

  async onCycleOpened(
    userId: string,
    ev: { cycleId: string; sequence: number; firstDay: string },
    _now: Date,
  ): Promise<void> {
    if (await this.deps.map.get(userId, ev.cycleId)) return;
    const token = await this.deps.accessToken(userId);
    if (!token) return;
    const snap = await this.deps.snapshots.get(userId, ev.cycleId);
    const ref = await this.deps.client.createSpreadsheet(token, {
      title: snap.title,
      tabs: SHEET_TABS.map((t) => this.tabName(t)),
      folderId: await this.deps.folderId(userId),
    });
    await this.deps.map.put(userId, ev.cycleId, { ref, frozen: false });
    await this.write(token, ref, snap);
    await this.deps.publish("sync.sheet_created", { cycleId: ev.cycleId, spreadsheetRef: ref });
  }

  /** Rewrites the sheet from the database; edits made in the sheet are overwritten. */
  async refresh(userId: string, cycleId: string, _now: Date): Promise<void> {
    const entry = await this.deps.map.get(userId, cycleId);
    if (!entry || entry.frozen) return;
    const token = await this.deps.accessToken(userId);
    if (!token) return;
    await this.write(token, entry.ref, await this.deps.snapshots.get(userId, cycleId));
  }

  /** One last update, then the sheet is left alone. */
  async onCycleClosed(userId: string, ev: { cycleId: string }, now: Date): Promise<void> {
    await this.refresh(userId, ev.cycleId, now);
    const entry = await this.deps.map.get(userId, ev.cycleId);
    if (entry) await this.deps.map.put(userId, ev.cycleId, { ...entry, frozen: true });
  }

  private async write(token: string, ref: string, snap: CycleSnapshot) {
    const banner = [this.deps.labels("sync.sheet.banner")];
    for (const tab of SHEET_TABS) {
      await this.deps.client.writeTab(token, ref, this.tabName(tab), [banner, ...snap.tabs[tab]]);
    }
  }
}
