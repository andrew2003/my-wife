import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";
import { createReceiptHandler, getAccountStates } from "../src/accounts";

async function seeded() {
  const store = new MemorySampleBudgetStore();
  let n = 0;
  const onboarding = createOnboardingHandler({
    store,
    locale: "en",
    now: () => new Date("2026-03-02T10:00:00Z"),
    newId: () => `id-${++n}`,
    publish: () => undefined,
  });
  await onboarding({
    id: "e0",
    type: "onboarding.step_completed",
    occurredAt: "2026-03-02T09:00:00Z",
    userId: "u1",
    schemaVersion: 1,
    payload: { step: "qa_templates", skipped: true },
  } as EventEnvelope);
  const receipts = createReceiptHandler({
    store,
    now: () => new Date("2026-03-03T08:00:00Z"),
  });
  return { store, receipts };
}

const receipt = (hint: string, userId = "u1", id = "r1"): EventEnvelope =>
  ({
    id: `ev-${id}`,
    type: "receipt.parsed",
    occurredAt: "2026-03-03T07:00:00Z",
    userId,
    schemaVersion: 1,
    payload: {
      receiptId: id,
      bankTransactionRef: `ref-${id}`,
      bankAccountHint: hint,
      direction: "in",
      amountVnd: 1000,
      currency: "VND",
      counterparty: null,
      memo: "",
      occurredAt: "2026-03-03T07:00:00Z",
      source: "email",
      fxProvisional: false,
    },
  }) as unknown as EventEnvelope;

describe("account seeding", () => {
  it("seeds a spending and a penalty_savings account, unconfirmed, with a code", async () => {
    const { store } = await seeded();
    const accounts = store.get("u1")!.accounts;
    for (const kind of ["spending", "penalty_savings"] as const) {
      const a = accounts.find((x) => x.kind === kind)!;
      expect(a.code.length).toBeGreaterThan(0);
      expect(a.emailNotificationsConfirmed).toBe(false);
    }
  });

  it("lets the user edit a code, rejecting reserved, empty and duplicate codes", async () => {
    const { store } = await seeded();
    const id = store.get("u1")!.accounts.find((a) => a.kind === "spending")!.id;
    expect(await store.setAccountCode("u1", id, "vcb", new Date())).toBe("ok");
    expect(store.get("u1")!.accounts.find((a) => a.id === id)!.code).toBe("VCB");
    expect(await store.setAccountCode("u1", id, "DC", new Date())).toBe("invalid");
    expect(await store.setAccountCode("u1", id, "", new Date())).toBe("invalid");
    expect(await store.setAccountCode("u1", id, "PEN", new Date())).toBe("duplicate");
    expect(store.get("u1")!.audit.at(-1)!.action).toBe("account_code_changed");
  });
});

describe("test-receipt confirmation", () => {
  it("confirms the resolved account once; a repeat changes nothing", async () => {
    const { store, receipts } = await seeded();
    await receipts(receipt("main"));
    const acc = () => store.get("u1")!.accounts.find((a) => a.code === "MAIN")!;
    expect(acc().emailNotificationsConfirmed).toBe(true);
    const auditLen = store.get("u1")!.audit.length;
    await receipts(receipt("MAIN"));
    await receipts(receipt("MAIN", "u1", "r2"));
    expect(acc().emailNotificationsConfirmed).toBe(true);
    expect(store.get("u1")!.audit).toHaveLength(auditLen);
    expect(store.get("u1")!.accounts.filter((a) => a.emailNotificationsConfirmed)).toHaveLength(1);
  });

  it("ignores a hint that resolves to no account, another user, or other events", async () => {
    const { store, receipts } = await seeded();
    await receipts(receipt("UNKNOWN"));
    await receipts(receipt("MAIN", "u2"));
    await receipts({ ...receipt("MAIN"), type: "receipt.failed" } as unknown as EventEnvelope);
    expect(store.get("u1")!.accounts.some((a) => a.emailNotificationsConfirmed)).toBe(false);
  });

  it("reports accounts without a test receipt as unconfirmed", async () => {
    const { store, receipts } = await seeded();
    await receipts(receipt("SAV"));
    const states = await getAccountStates(store, "u1");
    expect(states.find((s) => s.code === "SAV")!.state).toBe("confirmed");
    expect(states.find((s) => s.code === "MAIN")!.state).toBe("unconfirmed");
    expect(states.find((s) => s.code === "PEN")!.state).toBe("unconfirmed");
    expect(await getAccountStates(store, "nobody")).toEqual([]);
  });
});
