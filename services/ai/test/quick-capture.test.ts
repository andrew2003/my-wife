import { describe, expect, it } from "vitest";
import { ChatService } from "../src/chat/chat-service";
import { FakeLlmProvider } from "../src/llm";
import { InMemoryAuditLog, ToolExecutor, type ToolBackends } from "../src/tools";

const NOW = new Date("2026-11-28T10:00:00Z");

function setup(
  reply: ConstructorParameters<typeof FakeLlmProvider>[0],
  backends: ToolBackends,
  settings: Record<string, unknown> = {},
  maxCapturesPerMessage?: number,
) {
  const audit = new InMemoryAuditLog();
  const tools = new ToolExecutor({ audit, backends, now: () => NOW });
  const chat = new ChatService({
    provider: new FakeLlmProvider(reply),
    publish: async () => {},
    tools,
    now: () => NOW,
    readSettings: async () => settings,
    maxCapturesPerMessage,
  });
  return { chat, audit };
}

const text = (r: { reply: unknown }) => (r.reply as { text: string }).text;

describe("quick capture in chat", () => {
  it("creates a task for 'buy rice tomorrow' and confirms in chat", async () => {
    const created: unknown[] = [];
    const { chat, audit } = setup(
      {
        reply: () => ({
          text: "ok",
          toolCalls: [{ tool: "create_task", args: { title: "Buy rice", day: "tomorrow" } }],
        }),
      },
      {
        createTask: async (_u, args) => {
          created.push(args);
          return {};
        },
      },
    );
    const result = await chat.handleMessage("buy rice tomorrow", "en", "u1");
    expect(created).toEqual([{ title: "Buy rice", day: "2026-11-29" }]);
    expect(text(result)).toContain("Task added: Buy rice (2026-11-29)");
    expect((await audit.list("u1")).map((e) => e.outcome)).toEqual(["executed"]);
  });

  it("uses the user's time zone to resolve 'tomorrow'", async () => {
    const created: { day?: string }[] = [];
    const { chat } = setup(
      {
        reply: () => ({
          text: "ok",
          toolCalls: [{ tool: "create_task", args: { title: "Buy rice", day: "tomorrow" } }],
        }),
      },
      {
        createTask: async (_u, args) => {
          created.push(args);
          return {};
        },
      },
      { "calendar.time_zone": "Pacific/Auckland" },
    );
    await chat.handleMessage("buy rice tomorrow", "en", "u1");
    // 10:00Z on the 28th is 23:00 on the 28th in Auckland (UTC+13), so tomorrow is the 29th.
    expect(created[0]?.day).toBe("2026-11-29");
  });

  it("keeps an ISO day as given", async () => {
    const created: { day?: string }[] = [];
    const { chat } = setup(
      {
        reply: () => ({
          text: "ok",
          toolCalls: [{ tool: "create_task", args: { title: "Rice", day: "2026-12-01" } }],
        }),
      },
      {
        createTask: async (_u, args) => {
          created.push(args);
          return {};
        },
      },
    );
    await chat.handleMessage("rice on 1 Dec", "en", "u1");
    expect(created[0]?.day).toBe("2026-12-01");
  });

  it("records a cash expense and shows it afterward in Vietnamese", async () => {
    const recorded: unknown[] = [];
    const { chat } = setup(
      {
        reply: () => ({
          text: "ok",
          toolCalls: [{ tool: "record_cash_expense", args: { amountVnd: 45000, note: "pho" } }],
        }),
      },
      {
        recordCashExpense: async (_u, args) => {
          recorded.push(args);
          return {};
        },
      },
    );
    const result = await chat.handleMessage("pho 45k", "vi", "u1");
    expect(recorded).toEqual([{ amountVnd: 45000, note: "pho" }]);
    expect(text(result)).toContain("45000");
    expect(text(result)).toContain("Đã ghi");
  });

  it("drops an unparseable day instead of guessing", async () => {
    const created: { day?: string }[] = [];
    const { chat } = setup(
      {
        reply: () => ({
          text: "ok",
          toolCalls: [{ tool: "create_task", args: { title: "Buy rice", day: "someday" } }],
        }),
      },
      {
        createTask: async (_u, args) => {
          created.push(args);
          return {};
        },
      },
    );
    await chat.handleMessage("buy rice", "en", "u1");
    expect(created).toEqual([{ title: "Buy rice" }]);
  });

  it("says so when the backend fails, and never claims success", async () => {
    const { chat, audit } = setup(
      {
        reply: () => ({
          text: "ok",
          toolCalls: [{ tool: "create_task", args: { title: "Buy rice" } }],
        }),
      },
      {
        createTask: async () => {
          throw new Error("down");
        },
      },
    );
    const result = await chat.handleMessage("buy rice", "en", "u1");
    expect(text(result)).toContain("could not save");
    expect(text(result)).not.toContain("Task added");
    expect((await audit.list("u1")).map((e) => e.outcome)).toEqual(["failed"]);
  });

  it("does not run tools that need a confirm or are not quick capture", async () => {
    const { chat, audit } = setup(
      {
        reply: () => ({
          text: "ok",
          toolCalls: [
            { tool: "update_setting", args: { key: "ai.persona_strictness", value: 1 } },
            { tool: "read_status", args: { scope: "budget" } },
          ],
        }),
      },
      { readStatus: async () => ({}) },
    );
    await chat.handleMessage("hi", "en", "u1");
    expect(await audit.list("u1")).toEqual([]);
  });

  it("never runs tools for untrusted content", async () => {
    let called = 0;
    const { chat, audit } = setup(
      {
        reply: () => ({
          text: "summary",
          toolCalls: [{ tool: "create_task", args: { title: "Pay now" } }],
        }),
      },
      {
        createTask: async () => {
          called += 1;
        },
      },
    );
    await chat.handleUntrusted("email body", "email", "en", "u1");
    expect(called).toBe(0);
    expect(await audit.list("u1")).toEqual([]);
  });

  it("runs at most the configured number of captures per message", async () => {
    let called = 0;
    const { chat } = setup(
      {
        reply: () => ({
          text: "ok",
          toolCalls: Array.from({ length: 10 }, (_, i) => ({
            tool: "create_task" as const,
            args: { title: `t${i}` },
          })),
        }),
      },
      {
        createTask: async () => {
          called += 1;
        },
      },
      {},
      3,
    );
    await chat.handleMessage("many", "en", "u1");
    expect(called).toBe(3);
  });
});
