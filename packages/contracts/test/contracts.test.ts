import { describe, expect, it } from "vitest";
import {
  AI_TOOL_NAMES,
  AiToolCallSchema,
  CONSENT_KINDS,
  CalendarProviderSchema,
  CellEditRequestSchema,
  CellEditResponseSchema,
  ConsentKindSchema,
  CycleStateSchema,
  ReadbackConflictRecordSchema,
  EVENT_REGISTRY,
  EventEnvelopeSchemas,
  FaultTypeSchema,
  ListKeysResponseSchema,
  LlmKeyViewSchema,
  MonitorStartSessionResponseSchema,
  QuestionSchema,
  ReceiptParsedPayloadSchema,
  ReconciliationResultSchema,
  SETTINGS,
  SettingKeySchema,
  TransactionTypeSchema,
  VndAmountSchema,
  eventSubjects,
  parseEvent,
  validateSettingValue,
} from "../src/index";

describe("primitives", () => {
  it.each([
    [0, true],
    [100000, true],
    [-5000, true],
    [1.5, false],
    ["1000", false],
    [Number.NaN, false],
    [Number.MAX_SAFE_INTEGER + 1, false],
  ])("VND amount %s valid=%s", (value, ok) => {
    expect(VndAmountSchema.safeParse(value).success).toBe(ok);
  });
});

describe("enums", () => {
  it("has the reconciliation results from the spec", () => {
    expect(ReconciliationResultSchema.options).toEqual([
      "matched",
      "amount_mismatch",
      "unplanned",
      "unknown",
      "wrong_bank",
      "internal_transfer",
      "not_executed",
      "penalty_unpaid",
      "adjusted",
    ]);
  });
  it("has all 19 transaction types", () => {
    expect(TransactionTypeSchema.options).toHaveLength(19);
    expect(TransactionTypeSchema.safeParse("planned_transfer").success).toBe(true);
    expect(TransactionTypeSchema.safeParse("gift").success).toBe(false);
  });
  it("has the cycle states", () => {
    expect(CycleStateSchema.options).toEqual([
      "draft",
      "awaiting_funds",
      "running",
      "closing",
      "closed",
    ]);
  });
  it("only hard signals are fault types", () => {
    expect(FaultTypeSchema.safeParse("tab_away").success).toBe(true);
    expect(FaultTypeSchema.safeParse("yawn").success).toBe(false);
    expect(FaultTypeSchema.safeParse("late_night").success).toBe(false);
  });
  it("lists the seven consents", () => {
    expect([...CONSENT_KINDS].sort()).toEqual(
      [
        "apple_calendar_sync",
        "bank",
        "camera",
        "email",
        "google_sync",
        "vision_frame",
        "wake_photo",
      ].sort(),
    );
  });
});

describe("event registry", () => {
  const subjects = eventSubjects();
  it("uses lowercase dotted subjects", () => {
    for (const s of subjects) expect(s).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });
  it("covers the events named in the specs", () => {
    for (const s of [
      "cycle.opened",
      "receipt.parsed",
      "fault.detected",
      "penalty.issued",
      "week.closed",
      "notify.reply_received",
      "ai.photo_graded",
      "incident.declared",
      "sync.sheet_created",
      "user.updated",
      "ask.budget_category",
      "routine.late_detected",
    ])
      expect(subjects).toContain(s);
  });
  it("assigns exactly one publisher per subject", () => {
    for (const s of subjects) expect(EVENT_REGISTRY[s].publisher).toBeTruthy();
  });
  it("never lets monitor events publish penalties", () => {
    expect(EVENT_REGISTRY["fault.detected"].publisher).toBe("monitor");
    expect(EVENT_REGISTRY["penalty.issued"].publisher).toBe("rules");
  });
  it("parses a valid envelope and rejects a wrong payload", () => {
    const base = {
      id: "evt-1",
      occurredAt: "2026-11-26T10:00:00Z",
      userId: "u1",
      schemaVersion: 1,
    };
    const ok = parseEvent({
      ...base,
      type: "overspend.detected",
      payload: {
        cycleId: "c1",
        weekIndex: 2,
        categoryId: "cat1",
        priority: "want",
        weeklyLimitVnd: 500000,
        spentVnd: 550000,
        excessVnd: 50000,
      },
    });
    expect(ok.success).toBe(true);
    const bad = parseEvent({
      ...base,
      type: "overspend.detected",
      payload: { cycleId: "c1", excessVnd: 1.5 },
    });
    expect(bad.success).toBe(false);
    expect(parseEvent({ ...base, type: "nope.nothing", payload: {} }).success).toBe(false);
    expect(EventEnvelopeSchemas["overspend.detected"]).toBeDefined();
  });
});

describe("ingest receipt.parsed", () => {
  const valid = {
    receiptId: "r1",
    bankTransactionRef: "FT123",
    bankAccountHint: "6789",
    direction: "out",
    amountVnd: 100000,
    currency: "VND",
    counterparty: "SHOP",
    memo: "MW-C07W2-AN-02",
    occurredAt: "2026-11-26T03:00:00Z",
    source: "parser",
    fxProvisional: false,
  };
  it("accepts a valid receipt", () => {
    expect(ReceiptParsedPayloadSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects a fractional amount and a bad direction", () => {
    expect(ReceiptParsedPayloadSchema.safeParse({ ...valid, amountVnd: 10.5 }).success).toBe(false);
    expect(ReceiptParsedPayloadSchema.safeParse({ ...valid, direction: "sideways" }).success).toBe(
      false,
    );
  });
  it("does not carry a category (budget decides)", () => {
    expect(ReceiptParsedPayloadSchema.safeParse({ ...valid, categoryId: "x" }).success).toBe(false);
  });
});

describe("settings registry", () => {
  it("has defaults that satisfy their own schema", () => {
    for (const [key, def] of Object.entries(SETTINGS)) {
      expect(def.schema.safeParse(def.default).success, key).toBe(true);
    }
  });
  it("matches key defaults from 02-defaults.md", () => {
    expect(SETTINGS["budget.cycle_weeks"].default).toBe(4);
    expect(SETTINGS["penalty.weekly_cap_vnd"].default).toBe(500000);
    expect(SETTINGS["fault.weight.heartbeat_lost"].default).toBe(3);
    expect(SETTINGS["fault.thresholds"].default).toEqual([
      { points: 6, amountVnd: 20000 },
      { points: 12, amountVnd: 50000 },
      { points: 20, amountVnd: 100000 },
    ]);
    expect(SETTINGS["notify.quiet_hours"].default).toEqual({ from: "23:00", to: "06:30" });
    expect(SETTINGS["sync.retry_backoff_seconds"].default).toEqual([30, 120, 600, 3600]);
  });
  it("makes the need-group overspend penalty a setting that defaults to penalize (Q-0001)", () => {
    expect(SettingKeySchema.safeParse("penalty.need_overspend_mode").success).toBe(true);
    expect(SETTINGS["penalty.need_overspend_mode"].default).toBe("penalize");
  });
  it("validates values per key", () => {
    expect(validateSettingValue("budget.cycle_weeks", 6).success).toBe(true);
    expect(validateSettingValue("budget.cycle_weeks", 0).success).toBe(false);
    expect(validateSettingValue("calendar.week_start_day", "funday").success).toBe(false);
    expect(validateSettingValue("unknown.key", 1).success).toBe(false);
  });
});

describe("monitor", () => {
  it("returns session.already_active as an error code", () => {
    expect(
      MonitorStartSessionResponseSchema.safeParse({
        ok: false,
        error: { code: "session.already_active" },
      }).success,
    ).toBe(true);
    expect(
      MonitorStartSessionResponseSchema.safeParse({ ok: false, error: { code: "other" } }).success,
    ).toBe(false);
  });
});

describe("notify question", () => {
  it("requires stable option values and an expiry", () => {
    const q = {
      id: "q1",
      sourceService: "budget",
      kind: "budget_category",
      options: [{ value: "cat:food", labelKey: "ask.budget_category.food" }],
      expiresAt: "2026-11-27T10:00:00Z",
      state: "created",
    };
    expect(QuestionSchema.safeParse(q).success).toBe(true);
    expect(QuestionSchema.safeParse({ ...q, options: [] }).success).toBe(false);
  });
});

describe("ai tools", () => {
  it("exposes exactly the tools of the spec", () => {
    expect([...AI_TOOL_NAMES].sort()).toEqual(
      [
        "answer_question",
        "ask_reason",
        "create_appeal",
        "create_task",
        "read_status",
        "record_cash_expense",
        "update_setting",
      ].sort(),
    );
  });
  it("accepts a cash expense call and rejects forbidden tools", () => {
    expect(
      AiToolCallSchema.safeParse({
        tool: "record_cash_expense",
        args: { amountVnd: 35000, note: "milk" },
      }).success,
    ).toBe(true);
    expect(
      AiToolCallSchema.safeParse({ tool: "create_penalty", args: { amountVnd: 1 } }).success,
    ).toBe(false);
    expect(
      AiToolCallSchema.safeParse({ tool: "move_money", args: { amountVnd: 1 } }).success,
    ).toBe(false);
  });
});

describe("identity key view", () => {
  it("never carries a secret", () => {
    const ok = { provider: "anthropic", model: "m", keyId: "k1", valid: true, role: "primary" };
    expect(LlmKeyViewSchema.safeParse(ok).success).toBe(true);
    expect(LlmKeyViewSchema.safeParse({ ...ok, apiKey: "sk-secret" }).success).toBe(false);
  });
});

describe("ListKeysResponseSchema", () => {
  const key = { provider: "anthropic", model: "m", keyId: "k1", valid: true, role: "primary" };
  it.each([
    ["last page with null cursor", { ok: true, data: { keys: [key], nextCursor: null } }, true, null],
    ["page with a cursor", { ok: true, data: { keys: [key], nextCursor: "abc" } }, true, "abc"],
    ["cursor omitted defaults to null", { ok: true, data: { keys: [] } }, true, null],
    ["non-string cursor", { ok: true, data: { keys: [], nextCursor: 5 } }, false, undefined],
    ["key material is rejected", { ok: true, data: { keys: [{ ...key, apiKey: "sk" }], nextCursor: null } }, false, undefined],
  ])("%s", (_name, input, success, cursor) => {
    const r = ListKeysResponseSchema.safeParse(input);
    expect(r.success).toBe(success);
    if (r.success && r.data.ok) expect(r.data.data.nextCursor).toBe(cursor);
  });
});

describe("sync read-back and calendar contracts (ADR 0015)", () => {
  const edit = {
    sheet: "budget",
    tab: "limits",
    cellRef: "C4",
    entityId: "cat-1",
    field: "limit_vnd",
    value: 1500000,
  };
  it.each([
    ["valid number edit", edit, true],
    ["valid note edit", { ...edit, field: "note", value: "rent" }, true],
    ["clearing a cell", { ...edit, value: null }, true],
    ["unknown sheet", { ...edit, sheet: "other" }, false],
    ["empty cell ref", { ...edit, cellRef: "" }, false],
    ["object value", { ...edit, value: { a: 1 } }, false],
    ["missing field", { sheet: "budget", tab: "limits", cellRef: "C4", value: 1 }, false],
  ])("cell edit request: %s", (_n, input, ok) => {
    expect(CellEditRequestSchema.safeParse(input).success).toBe(ok);
  });
  it.each([
    ["applied", { ok: true, data: { status: "applied" } }, true],
    ["rejected with reason", { ok: true, data: { status: "rejected", reason: "locked_cell" } }, true],
    ["error", { ok: false, error: { code: "validation_failed", message: "bad" } }, true],
    ["unknown status", { ok: true, data: { status: "maybe" } }, false],
    ["unknown reason", { ok: true, data: { status: "rejected", reason: "nope" } }, false],
  ])("cell edit response: %s", (_n, input, ok) => {
    expect(CellEditResponseSchema.safeParse(input).success).toBe(ok);
  });
  const conflict = {
    id: "c1",
    sheet: "timetable",
    tab: "week",
    cellRef: "B2",
    field: "title",
    appValue: "Study",
    sheetValue: "Gym",
    appChangedAt: "2026-11-28T01:00:00.000Z",
    sheetChangedAt: "2026-11-28T02:00:00.000Z",
    winner: "sheet",
    resolvedAt: "2026-11-28T02:01:00.000Z",
  };
  it.each([
    ["valid", conflict, true],
    ["null values", { ...conflict, appValue: null }, true],
    ["bad winner", { ...conflict, winner: "both" }, false],
    ["bad timestamp", { ...conflict, sheetChangedAt: "yesterday" }, false],
    ["missing sheet value", { ...conflict, sheetValue: undefined }, false],
  ])("conflict record: %s", (_n, input, ok) => {
    expect(ReadbackConflictRecordSchema.safeParse(input).success).toBe(ok);
  });
  it.each([
    ["google", true],
    ["apple", true],
    ["outlook", false],
  ])("calendar provider %s valid=%s", (v, ok) => {
    expect(CalendarProviderSchema.safeParse(v).success).toBe(ok);
  });
  it("accepts apple_calendar_sync consent", () => {
    expect(ConsentKindSchema.safeParse("apple_calendar_sync").success).toBe(true);
  });
  it.each([
    ["sync.readback_applied", { sheet: "budget", cellCount: 3 }, true],
    ["sync.readback_applied", { sheet: "budget", cellCount: -1 }, false],
    ["sync.readback_reverted", { sheet: "timetable", cellCount: 2, reason: "locked_cell" }, true],
    ["sync.readback_reverted", { sheet: "timetable", cellCount: 2, reason: "x" }, false],
    ["sync.conflict_resolved", { conflictId: "c1", winner: "app" }, true],
    ["sync.conflict_resolved", { conflictId: "c1", winner: "x" }, false],
    ["sync.readback_paused", { sheet: "budget", reason: "malformed_sheet" }, true],
    ["sync.readback_paused", { sheet: "budget" }, false],
  ])("event %s %j valid=%s", (type, payload, ok) => {
    expect(EVENT_REGISTRY[type as keyof typeof EVENT_REGISTRY].publisher).toBe("sync");
    const schema = EVENT_REGISTRY[type as keyof typeof EVENT_REGISTRY].payload;
    expect(schema.safeParse(payload).success).toBe(ok);
  });
  it("registers the sheet read-back setting default on", () => {
    expect(SETTINGS["sync.sheet_readback_enabled"].default).toBe(true);
  });
});
