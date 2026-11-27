import { describe, expect, it } from "vitest";
import { AI_TOOL_NAMES } from "@my-wife/contracts";
import { InMemoryAuditLog, ToolExecutor, listToolNames } from "../src/tools";

const NOW = new Date("2026-11-27T03:00:00Z");

function setup(over: { recordCashExpense?: (u: string, a: unknown) => Promise<unknown> } = {}) {
  const calls: { userId: string; args: unknown }[] = [];
  const audit = new InMemoryAuditLog();
  const executor = new ToolExecutor({
    audit,
    backends: {
      recordCashExpense:
        over.recordCashExpense ??
        (async (userId, args) => {
          calls.push({ userId, args });
          return { transactionId: "t1" };
        }),
    },
    now: () => NOW,
  });
  return { executor, audit, calls };
}

describe("tool set", () => {
  it("bought milk 35k cash: budget creates the transaction and an audit entry exists", async () => {
    const { executor, audit, calls } = setup();
    const result = await executor.execute("u1", {
      tool: "record_cash_expense",
      args: { amountVnd: 35000, note: "milk" },
    });
    expect(result.status).toBe("ok");
    expect(calls).toEqual([{ userId: "u1", args: { amountVnd: 35000, note: "milk" } }]);
    const entries = await audit.list("u1");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tool: "record_cash_expense",
      outcome: "executed",
      at: NOW,
    });
  });

  it("exposes only the contract tools and none can create a penalty", async () => {
    const names = listToolNames();
    expect([...names].sort()).toEqual([...AI_TOOL_NAMES].sort());
    expect(names.some((n) => /penalt|fine|transfer|pay|trial|sign/i.test(n))).toBe(false);
    const { executor, audit, calls } = setup();
    const result = await executor.execute("u1", {
      tool: "create_penalty",
      args: { amountVnd: 1 },
    });
    expect(result.status).toBe("rejected");
    expect(calls).toHaveLength(0);
    expect((await audit.list("u1"))[0]).toMatchObject({ outcome: "rejected" });
  });

  it("rejects invalid arguments without calling the backend", async () => {
    const { executor, calls } = setup();
    const result = await executor.execute("u1", {
      tool: "record_cash_expense",
      args: { amountVnd: 35.5 },
    });
    expect(result.status).toBe("rejected");
    expect(calls).toHaveLength(0);
  });

  it("holds confirm tools for a button and does not execute them", async () => {
    const { executor, audit } = setup();
    const result = await executor.execute("u1", {
      tool: "update_setting",
      args: { key: "ai.persona_strictness", value: 3 },
    });
    expect(result.status).toBe("needs_confirmation");
    expect((await audit.list("u1"))[0]).toMatchObject({ outcome: "proposed" });
  });

  it("audits a backend failure", async () => {
    const { executor, audit } = setup({
      recordCashExpense: async () => {
        throw new Error("down");
      },
    });
    const result = await executor.execute("u1", {
      tool: "record_cash_expense",
      args: { amountVnd: 100 },
    });
    expect(result.status).toBe("error");
    expect((await audit.list("u1"))[0]).toMatchObject({ outcome: "failed" });
  });
});
