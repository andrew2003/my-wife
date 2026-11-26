import {
  SETTINGS,
  type BankAccount,
  type BudgetCategory,
  type BudgetCycle,
  type EventEnvelope,
  type Locale,
  type SettingKey,
} from "@my-wife/contracts";
import { t } from "./i18n";
import { buildSampleBudget, type SampleCategoryTemplate } from "./sample-budget";

/**
 * Default total of the sample budget when the user gave no answer (decisions.md, MW-013).
 * A default only: the real total comes from the user's setup answer when it exists.
 */
export const DEFAULT_SAMPLE_TOTAL_VND = 10_000_000;

export interface AuditRecord {
  at: string;
  userId: string;
  action: "sample_budget_generated";
  detail: { totalVnd: number; sequence: number };
}

export interface SampleBudgetRecord {
  userId: string;
  cycle: BudgetCycle;
  accounts: BankAccount[];
  categories: BudgetCategory[];
  audit: AuditRecord[];
  /** False until `cycle.draft_created` was published, so a failed publish is retried. */
  announced: boolean;
}

/** Persistence port. A Postgres store must enforce one sample draft per user by unique key. */
export interface SampleBudgetStore {
  find(userId: string): Promise<SampleBudgetRecord | undefined>;
  /** Returns false when a draft for the user already exists (nothing is written then). */
  insertIfAbsent(record: SampleBudgetRecord): Promise<boolean>;
  markAnnounced(userId: string): Promise<void>;
}

export class MemorySampleBudgetStore implements SampleBudgetStore {
  private readonly records = new Map<string, SampleBudgetRecord>();

  async find(userId: string) {
    return this.records.get(userId);
  }

  async insertIfAbsent(record: SampleBudgetRecord) {
    if (this.records.has(record.userId)) return false;
    this.records.set(record.userId, record);
    return true;
  }

  async markAnnounced(userId: string) {
    const r = this.records.get(userId);
    if (r) r.announced = true;
  }

  /** Sync helpers for tests. */
  get(userId: string) {
    return this.records.get(userId);
  }

  count() {
    return this.records.size;
  }
}

export interface OnboardingDeps {
  store: SampleBudgetStore;
  locale: Locale;
  now: () => Date;
  newId: () => string;
  publish: (event: EventEnvelope) => void | Promise<void>;
  /** The user's settings; missing keys fall back to the registry defaults. */
  settings?: Partial<Record<SettingKey, number>>;
  /** The user's total budget answer per cycle, when one exists. */
  totalVnd?: (userId: string) => number | undefined;
  /** Override of the sample ratios. */
  template?: readonly SampleCategoryTemplate[];
}

const ACCOUNT_CODES = { spending: "MAIN", savings: "SAV", penalty_savings: "PEN" } as const;

/**
 * Handles `onboarding.step_completed`. On step `qa_templates` (skipped or not) it creates the
 * sample budget draft once per user. Redelivery is safe; a failed publish is retried.
 */
export function createOnboardingHandler(deps: OnboardingDeps) {
  const setting = (key: SettingKey): number =>
    deps.settings?.[key] ?? (SETTINGS[key].default as number);

  return async function onOnboardingStepCompleted(event: EventEnvelope): Promise<void> {
    if (event.type !== "onboarding.step_completed") return;
    const { step } = (event as EventEnvelope<"onboarding.step_completed">).payload;
    if (step !== "qa_templates") return;
    const userId = event.userId;

    let record = await deps.store.find(userId);
    if (!record) {
      record = buildRecord(userId);
      const inserted = await deps.store.insertIfAbsent(record);
      if (!inserted) record = await deps.store.find(userId);
    }
    if (!record || record.announced) return;

    await deps.publish({
      id: deps.newId(),
      type: "cycle.draft_created",
      occurredAt: deps.now().toISOString(),
      userId,
      schemaVersion: event.schemaVersion,
      payload: { cycleId: record.cycle.id, sequence: record.cycle.sequence },
    } as EventEnvelope);
    await deps.store.markAnnounced(userId);
  };

  function buildRecord(userId: string): SampleBudgetRecord {
    const total = deps.totalVnd?.(userId) ?? DEFAULT_SAMPLE_TOTAL_VND;
    const weeks = setting("budget.cycle_weeks");
    const draft = buildSampleBudget({
      totalVnd: total,
      roundingVnd: setting("budget.weekly_limit_rounding_vnd"),
      template: deps.template,
    });
    const now = deps.now();
    const accounts: BankAccount[] = (["spending", "savings", "penalty_savings"] as const).map(
      (kind) => ({
        id: deps.newId(),
        name: t(`budget.sample.account.${kind}`, deps.locale),
        code: ACCOUNT_CODES[kind],
        kind,
        emailNotificationsConfirmed: false,
      }),
    );
    const accountOf = (kind: BankAccount["kind"]) => accounts.find((a) => a.kind === kind)!.id;
    const cycle: BudgetCycle = {
      id: deps.newId(),
      sequence: 1,
      weeks,
      firstDay: now.toISOString().slice(0, 10),
      state: "draft",
      openedAt: null,
      closedAt: null,
      commitmentId: null,
    };
    return {
      userId,
      cycle,
      accounts,
      categories: draft.categories.map((c) => ({
        id: deps.newId(),
        name: t(`budget.sample.category.${c.key}`, deps.locale),
        shortCode: c.shortCode,
        priority: c.priority,
        kind: c.kind,
        countsTowardSurplus: c.countsTowardSurplus,
        bankAccountId: accountOf(c.accountKind),
        cycleLimitVnd: c.cycleLimitVnd,
        wantOrder: c.wantOrder,
      })),
      audit: [
        {
          at: now.toISOString(),
          userId,
          action: "sample_budget_generated",
          detail: { totalVnd: total, sequence: 1 },
        },
      ],
      announced: false,
    };
  }
}
