import { randomBytes } from "node:crypto";
import { loadConfig } from "@my-wife/config";
import { SimClock } from "@my-wife/test-kit";
import { startAll } from "../../dev-runner/src/runner";

// The ai service exports no entry point for its fake provider; mount it from sources.
import { FakeLlmProvider, type LlmProvider } from "../../../services/ai/src/llm";
import { renderMessage } from "../../../services/ai/src/i18n";

export const AI_USER = "0190a0a0-0000-7000-8000-0000000000a1";

/** A fake model whose behaviour the scenario flips between steps (down, or answering). */
export class SwitchableModel extends FakeLlmProvider {
  down = false;
  constructor(
    readonly name: string,
    private readonly tokensPerCall = 100,
  ) {
    super({
      reply: () => ({
        text: `${name} answers`,
        toolCalls: [],
        usage: { totalTokens: tokensPerCall },
      }),
    });
  }
  override async complete(request: Parameters<LlmProvider["complete"]>[0]) {
    if (this.down) {
      this.requests.push(request);
      throw Object.assign(new Error("provider down"), { reason: "provider_down" });
    }
    return super.complete(request);
  }
}

/** Facts the handover questions are graded against (computed by code in the product). */
export const HANDOVER_FACTS = [
  { id: "budget_left", expected: "1250000" },
  { id: "late_task", expected: "Coding" },
];
const question = (id: string) => renderMessage({ key: `ai.handover.q.${id}`, params: {} }, "en");

/** A candidate model that answers every handover question, or all but the named ones, correctly. */
export function candidateModel(wrong: string[] = []): LlmProvider {
  return new FakeLlmProvider({
    reply: (r) => {
      const bad = wrong.some((id) => r.userText === question(id));
      return {
        text: bad ? "No idea" : "1250000 left, and you are late for Coding.",
        toolCalls: [],
      };
    },
  });
}

/**
 * The ai service next to the other services on one `SimClock`: a primary and a fallback model
 * the scenario can take down, a key store with the handover test in front of model switches,
 * and settings both the chat and the token cap read on every call.
 */
export async function startAiWorld(opts: { start: string; settings?: Record<string, unknown> }) {
  const settings = opts.settings ?? {};
  const config = loadConfig({
    SESSION_SECRET: "x".repeat(32),
    LOG_LEVEL: "silent",
    UI_LANGUAGE: "en",
    SECRETS_MASTER_KEY: randomBytes(32).toString("base64"),
  });
  const clock = new SimClock(opts.start);
  const primary = new SwitchableModel("primary");
  const fallback = new SwitchableModel("fallback");
  const candidates = new Map<string, LlmProvider>();
  const events: { name: string; payload: unknown }[] = [];
  const runner = await startAll(config, {
    ephemeralPorts: true,
    ai: {
      now: () => clock.now(),
      provider: primary,
      fallbackProvider: fallback,
      readSettings: async () => settings,
      publish: async (e) => {
        events.push(e);
      },
      keyValidator: { validate: async () => true },
      handoverFacts: async () => HANDOVER_FACTS,
      providerFor: (c) => candidates.get(c.model) ?? candidateModel(),
    },
  });
  const headers = { "content-type": "application/json", "x-user-id": AI_USER };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = async (res: Response) => (await res.json()) as { ok: boolean; data: any };
  return {
    clock,
    settings,
    primary,
    fallback,
    candidates,
    events,
    urls: runner.urls,
    named: (name: string) => events.filter((e) => e.name === name),
    chat: async (text: string) =>
      json(
        await fetch(`${runner.urls.ai}/chat/message`, {
          method: "POST",
          headers,
          body: JSON.stringify({ text }),
        }),
      ),
    degraded: async () =>
      json(await fetch(`${runner.urls.ai}/status/degraded`, { headers })).then((b) => b.data),
    switchTo: async (model: string, apiKey: string) => {
      const res = await fetch(`${runner.urls.ai}/models/switch`, {
        method: "POST",
        headers,
        body: JSON.stringify({ provider: "openai", model, role: "primary", apiKey }),
      });
      return { status: res.status, text: await res.text() };
    },
    keys: async () => (await fetch(`${runner.urls.ai}/keys`, { headers })).text(),
    /** A rules-side query that must keep working while the models are down. */
    scheduleRoutines: () => fetch(`${runner.urls.schedule}/routines`, { headers }),
    stop: async () => runner.stop(),
  };
}

export type AiWorld = Awaited<ReturnType<typeof startAiWorld>>;
