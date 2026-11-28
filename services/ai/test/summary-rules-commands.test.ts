import { describe, expect, it } from "vitest";
import type { Locale, MessageRef } from "@my-wife/contracts";
import {
  CommandService,
  type ControlPorts,
  type PromptRequest,
  type RulesPorts,
  type SummaryPorts,
} from "../src/commands";
import { createRulesClient, createSummaryClient } from "../src/clients";
import { renderMessage } from "../src/i18n";

const NOW = new Date("2026-11-28T12:00:00Z");
const FAULT_ID = "11111111-1111-4111-8111-111111111111";

function summaryPorts(over: Partial<SummaryPorts> = {}): SummaryPorts {
  return {
    timeZone: async () => "Asia/Ho_Chi_Minh",
    schedule: async () => ({
      firstDay: "2026-11-23",
      tasks: [
        { day: "2026-11-28", state: "done" },
        { day: "2026-11-28", state: "planned" },
        { day: "2026-11-28", state: "cancelled" },
        { day: "2026-11-25", state: "done" },
        { day: "2026-11-26", state: "planned" },
      ],
    }),
    budget: async () => ({
      weekIndex: 2,
      categories: [
        { weeklyLimitVnd: 500000, spentVnd: 200000, remainingVnd: 300000 },
        { weeklyLimitVnd: 100000, spentVnd: 120000, remainingVnd: -20000 },
      ],
      anomalies: 1,
    }),
    faults: async () => [
      { occurredAt: "2026-11-25T03:00:00Z", points: 3, status: "recorded" },
      { occurredAt: "2026-11-10T03:00:00Z", points: 9, status: "recorded" },
      { occurredAt: "2026-11-26T03:00:00Z", points: 5, status: "overturned" },
    ],
    penalties: async () => ({ suspendedTotalVnd: 70000 }),
    ...over,
  };
}

function rulesPorts(over: Partial<RulesPorts> = {}) {
  const calls: { subjectId: string; reasonText: string }[] = [];
  const ports: RulesPorts = {
    latestFaults: async () => [
      {
        id: FAULT_ID,
        type: "wake_late",
        status: "pending_reason",
        points: 4,
        occurredAt: "2026-11-27T01:00:00Z",
        systemCause: null,
      },
    ],
    openAppeal: async (_u, input) => {
      calls.push(input);
      return { ok: true };
    },
    ...over,
  };
  return { ports, calls };
}

function setup(opts: {
  summary?: SummaryPorts;
  rules?: RulesPorts;
  runPrompt?: (u: string, r: PromptRequest) => Promise<MessageRef | { text: string }>;
}) {
  const prompts: PromptRequest[] = [];
  const service = new CommandService({
    ports: {} as ControlPorts,
    ...(opts.summary ? { summary: opts.summary } : {}),
    ...(opts.rules ? { rules: opts.rules } : {}),
    ...(opts.runPrompt
      ? {
          runPrompt: async (u, r) => {
            prompts.push(r);
            return opts.runPrompt!(u, r);
          },
        }
      : {}),
    now: () => NOW,
    loadCommandSettings: async () => ({ overrides: [], custom: [] }),
    readSettings: async () => ({}),
    publish: async () => {},
  });
  const send = (text: string, locale: Locale = "en") =>
    service.handle({ channel: "telegram", userId: "u1", text, locale });
  return { send, prompts };
}

const text = (r: { reply: MessageRef } | null, locale: Locale = "en") =>
  renderMessage(r!.reply, locale);

describe("summary commands", () => {
  it.each([
    "/summary",
    "/today",
    "/week",
    "/budget",
    "/tom_tat",
    "/hom_nay",
    "/tuan",
    "/ngan_sach",
  ])("%s answers from read routes", async (cmd) => {
    const { send } = setup({ summary: summaryPorts() });
    const r = await send(cmd);
    expect(r?.status).toBe("ok");
  });

  it("today counts tasks of the user's local day, ignoring cancelled", async () => {
    const { send } = setup({ summary: summaryPorts() });
    expect(text(await send("/today"))).toContain("1/2");
  });

  it("week counts the week's tasks and fault points that still stand", async () => {
    const { send } = setup({ summary: summaryPorts() });
    const out = text(await send("/week"));
    expect(out).toContain("2/4"); // done / total, cancelled excluded
    expect(out).toContain("3"); // the 9-point fault is before the week, the overturned one is out
    expect(out).not.toContain("17");
  });

  it("budget sums the money in integer VND and counts overspent categories", async () => {
    const { send } = setup({ summary: summaryPorts() });
    const out = text(await send("/budget"));
    expect(out).toContain("600,000");
    expect(out).toContain("320,000");
    expect(out).toContain("280,000");
    expect(out).toContain("70,000");
  });

  it("passes code-built facts to the model and uses its reply when numbers match", async () => {
    const { send, prompts } = setup({
      summary: summaryPorts(),
      runPrompt: async () => ({ text: "You did 1 of 2 tasks today." }),
    });
    const r = await send("/today");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.command.name).toBe("today");
    expect(prompts[0]?.text).toContain("1/2");
    expect(text(r)).toBe("You did 1 of 2 tasks today.");
  });

  it("drops a model reply that invents a number and shows the facts instead", async () => {
    const { send } = setup({
      summary: summaryPorts(),
      runPrompt: async () => ({ text: "You did 7 of 9 tasks today." }),
    });
    const out = text(await send("/today"));
    expect(out).toContain("1/2");
    expect(out).not.toContain("7 of 9");
  });

  it("falls back to the facts when the model fails or is missing", async () => {
    const failing = setup({
      summary: summaryPorts(),
      runPrompt: async () => {
        throw new Error("boom");
      },
    });
    expect(text(await failing.send("/today"))).toContain("1/2");
    const none = setup({ summary: summaryPorts() });
    expect(text(await none.send("/today"))).toContain("1/2");
  });

  it("keeps the other parts when one read route fails", async () => {
    const { send } = setup({
      summary: summaryPorts({
        budget: async () => {
          throw new Error("down");
        },
      }),
    });
    const r = await send("/summary");
    expect(r?.status).toBe("ok");
    expect(text(r)).toContain("1/2");
  });

  it("refuses with a clear reply when every read route fails or there are no ports", async () => {
    const dead = async () => {
      throw new Error("down");
    };
    const failing = setup({
      summary: summaryPorts({ schedule: dead, budget: dead, faults: dead, penalties: dead }),
    });
    expect((await failing.send("/summary"))?.status).toBe("refused");
    const none = setup({});
    expect((await none.send("/summary"))?.reply.key).toBe("commands.not_available");
  });

  it("has a Vietnamese reply", async () => {
    const { send } = setup({ summary: summaryPorts() });
    const r = await send("/today", "vi");
    expect(text(r, "vi")).toContain("Việc hôm nay");
    expect(text(r, "vi")).toContain("1/2");
  });
});

describe("rules commands", () => {
  it("/appeal opens an appeal for the latest fault with the typed reason", async () => {
    const { ports, calls } = rulesPorts();
    const { send } = setup({ rules: ports });
    const r = await send("/appeal I was at the doctor");
    expect(r?.status).toBe("ok");
    expect(calls).toEqual([{ subjectId: FAULT_ID, reasonText: "I was at the doctor" }]);
  });

  it("/appeal accepts a fault id and the Vietnamese alias", async () => {
    const { ports, calls } = rulesPorts();
    const { send } = setup({ rules: ports });
    await send(`/khang_cao ${FAULT_ID} power cut`);
    expect(calls).toEqual([{ subjectId: FAULT_ID, reasonText: "power cut" }]);
  });

  it.each([
    ["no reason", "/appeal"],
    ["only a fault id", `/appeal ${FAULT_ID}`],
  ])("/appeal with %s asks for a reason and writes nothing", async (_n, cmd) => {
    const { ports, calls } = rulesPorts();
    const { send } = setup({ rules: ports });
    const r = await send(cmd);
    expect(r?.status).toBe("refused");
    expect(calls).toHaveLength(0);
  });

  it("/appeal with no fault to appeal refuses", async () => {
    const { ports, calls } = rulesPorts({ latestFaults: async () => [] });
    const { send } = setup({ rules: ports });
    expect((await send("/appeal because"))?.reply.key).toBe("commands.appeal.none");
    expect(calls).toHaveLength(0);
  });

  it("/appeal answers refused when rules refuses, and never throws", async () => {
    const refused = setup({
      rules: rulesPorts({
        openAppeal: async () => ({ ok: false, error: "rules.appeal_window_closed" }),
      }).ports,
    });
    expect((await refused.send("/appeal because"))?.reply.key).toBe("commands.appeal.refused");
    const down = setup({
      rules: rulesPorts({
        openAppeal: async () => {
          throw new Error("down");
        },
      }).ports,
    });
    expect((await down.send("/appeal because"))?.reply.key).toBe("commands.capture.failed");
  });

  it("/reason shows the reason state of the latest fault and changes nothing", async () => {
    const { ports, calls } = rulesPorts();
    const { send } = setup({ rules: ports });
    const out = text(await send("/reason"));
    expect(out).toContain("wake_late");
    expect(out).toContain("4");
    expect(calls).toHaveLength(0);
  });

  it("/reason with text points to the app instead of writing", async () => {
    const { ports, calls } = rulesPorts();
    const { send } = setup({ rules: ports });
    const r = await send("/reason I overslept");
    expect(r?.reply.key).toBe("commands.reason.use_app");
    expect(calls).toHaveLength(0);
  });

  it("without rules ports both commands are not available", async () => {
    const { send } = setup({});
    expect((await send("/appeal x"))?.reply.key).toBe("commands.not_available");
    expect((await send("/reason"))?.reply.key).toBe("commands.not_available");
  });

  it("has Vietnamese replies", async () => {
    const { ports } = rulesPorts();
    const { send } = setup({ rules: ports });
    const r = await send("/appeal because", "vi");
    expect(text(r, "vi")).not.toBe(text(r, "en"));
  });
});

describe("rules and summary clients", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("openAppeal posts to /appeals with the user id and maps a 409 to a refusal", async () => {
    const seen: { url: string; user: string | null; body: unknown }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({
        url,
        user: new Headers(init.headers).get("x-user-id"),
        body: JSON.parse(String(init.body)),
      });
      return json({ ok: false, error: { code: "rules.appeal_window_closed" } }, 409);
    }) as unknown as typeof fetch;
    const client = createRulesClient("http://rules", fetchFn);
    const res = await client.openAppeal("u1", { subjectId: FAULT_ID, reasonText: "why" });
    expect(res).toEqual({ ok: false, error: "rules.appeal_window_closed" });
    expect(seen[0]).toEqual({
      url: "http://rules/appeals",
      user: "u1",
      body: { subjectKind: "fault", subjectId: FAULT_ID, reasonText: "why" },
    });
  });

  it("reads faults and penalties through GET routes", async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return url.includes("/faults")
        ? json({ ok: true, data: { faults: [], nextCursor: null } })
        : json({ ok: true, data: { penalties: [], suspendedTotalVnd: 5 } });
    }) as unknown as typeof fetch;
    const rules = createRulesClient("http://rules", fetchFn);
    const summary = createSummaryClient(
      { budget: "http://budget", schedule: "http://schedule", rules: "http://rules" },
      fetchFn,
    );
    expect(await rules.latestFaults("u1", 5)).toEqual([]);
    expect(await summary.penalties("u1")).toEqual({ suspendedTotalVnd: 5 });
    expect(urls).toEqual(["http://rules/faults?limit=5", "http://rules/penalties"]);
  });
});
