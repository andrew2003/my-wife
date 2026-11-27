import { afterAll, beforeAll, expect, it } from "vitest";
import { startAiWorld, candidateModel, HANDOVER_FACTS, type AiWorld } from "../support/ai-world";

/**
 * Scenario, extended: the AI service with a failing primary model, on simulated time.
 *
 * Saturday 2026-12-05 (Asia/Ho_Chi_Minh), threshold `ai.fallback_after_failures` = 3, handover
 * pass ratio = the registry default (1.0), a daily token cap of 450 tokens set by the scenario.
 *
 * - Healthy: the primary answers and the user is not told anything.
 * - Fallback: three primary failures, then the fallback answers with the same memories, and the
 *   user is told once.
 * - Degraded: when the fallback fails as well, chat points to the inbox and buttons, the banner
 *   flag is set, `ai.degraded_entered` goes out once, and rules keep answering.
 * - Recovery: the first success leaves degraded mode.
 * - Handover: a model that fails one question is refused and the old key stays active; a model
 *   that passes is enabled. The key never appears in a response.
 * - Token cap: once the cap is reached the model is not called, the user gets the refusal, the
 *   event goes out once, and the next day chat answers again.
 */
async function step(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    throw new Error(`step failed: ${name}`, { cause: err });
  }
}

const START = "2026-12-05T03:00:00.000Z"; // 10:00 local
const DEGRADED_TEXT_PART = "inbox";
const OLD_KEY = "sk-old-key-1234567890";
const BAD_KEY = "sk-bad-key-1234567890";
const GOOD_KEY = "sk-new-key-1234567890";

const settings: Record<string, unknown> = {};
let world: AiWorld;
beforeAll(async () => {
  world = await startAiWorld({ start: START, settings });
});
afterAll(async () => {
  await world.stop();
});

it("fallback, degraded mode, handover refusal and the token cap, with the primary failing", async () => {
  await step("healthy: the primary answers", async () => {
    await world.chat("please remember that I like tea");
    const reply = await world.chat("hello");
    expect(reply.data.reply.text).toBe("primary answers");
    expect(reply.data.degraded).toBe(false);
    expect(await world.degraded()).toEqual({ degraded: false, reason: null });
  });

  await step(
    "fallback: three primary failures, then the backup answers once informed",
    async () => {
      world.primary.down = true;
      for (let i = 0; i < 3; i++) {
        const failed = await world.chat("hello");
        expect(failed.data.degraded).toBe(true);
        expect(failed.data.reply.text).toContain("try again");
      }
      expect(world.fallback.requests).toHaveLength(0);
      const reply = await world.chat("what do I like?");
      expect(reply.data.reply.text).toContain("backup model");
      expect(reply.data.reply.text).toContain("fallback answers");
      expect(reply.data.degraded).toBe(false);
      // Same memories: the backup got the same prompt the primary last received.
      expect(world.fallback.requests[0]?.system).toContain("like tea");
      expect(world.fallback.requests[0]?.system).toBe(world.primary.requests.at(-1)?.system);
      // Told once only.
      expect((await world.chat("again")).data.reply.text).toBe("fallback answers");
      expect(world.named("ai.degraded_entered")).toHaveLength(0);
    },
  );

  await step("degraded: no model works, the banner shows and rules keep answering", async () => {
    world.fallback.down = true;
    for (let i = 0; i < 3; i++) await world.chat("hello");
    const reply = await world.chat("free text");
    expect(reply.data.degraded).toBe(true);
    expect(reply.data.reply.text).toContain(DEGRADED_TEXT_PART);
    expect(await world.degraded()).toEqual({ degraded: true, reason: "provider_down" });
    expect(world.named("ai.degraded_entered")).toHaveLength(1);
    expect((await world.scheduleRoutines()).status).toBe(200);
  });

  await step("recovery: the first success leaves degraded mode", async () => {
    world.primary.down = false;
    const reply = await world.chat("back");
    expect(reply.data.reply.text).toBe("primary answers");
    expect(await world.degraded()).toEqual({ degraded: false, reason: null });
    expect(world.named("ai.degraded_exited")).toHaveLength(1);
  });

  await step("handover: a model that fails one question is refused", async () => {
    const first = await world.switchTo("old-model", OLD_KEY);
    expect(first.status).toBe(200);
    expect(JSON.parse(first.text).data.state).toBe("passed");
    world.candidates.set("bad-model", candidateModel(["late_task"]));
    const refused = await world.switchTo("bad-model", BAD_KEY);
    expect(refused.status).toBe(200);
    const body = JSON.parse(refused.text).data;
    expect(body.state).toBe("failed");
    expect(body.failedQuestions).toEqual(["late_task"]);
    expect(body.passRatio).toBe(1 / HANDOVER_FACTS.length);
    expect(world.named("ai.handover_failed")).toHaveLength(1);
    expect(world.named("ai.model_changed")).toHaveLength(1); // only the old model's
    const keys = await world.keys();
    expect(keys).toContain("old-model");
    expect(keys).not.toContain("bad-model");
    for (const secret of [OLD_KEY, BAD_KEY]) {
      expect(keys).not.toContain(secret);
      expect(refused.text).not.toContain(secret);
    }
  });

  await step("handover: a model that passes is enabled", async () => {
    const passed = await world.switchTo("new-model", GOOD_KEY);
    expect(JSON.parse(passed.text).data.state).toBe("passed");
    expect(world.named("ai.handover_passed")).toHaveLength(2);
    const keys = await world.keys();
    expect(keys).toContain("new-model");
    expect(keys).not.toContain(GOOD_KEY);
  });

  await step(
    "token cap: refused once reached, announced once, answers again next day",
    async () => {
      settings["ai.daily_token_cap"] = 450;
      // Earlier answers already spent tokens today; count them as the cap's starting point.
      const calls = () => world.primary.requests.length;
      let guard = 0;
      while (!world.named("ai.token_cap_reached").length && guard++ < 20) {
        const reply = await world.chat("hello");
        if (reply.data.reply.text.includes("daily token limit")) break;
      }
      expect(guard).toBeLessThan(20);
      const before = calls();
      const refused = await world.chat("one more");
      expect(refused.data.reply.text).toContain("daily token limit");
      expect(refused.data.reply.text).toContain("Rules, countdowns and penalties keep working");
      expect(calls()).toBe(before);
      expect(world.named("ai.token_cap_reached")).toHaveLength(1);
      expect(world.named("ai.token_cap_reached")[0]?.payload).toEqual({
        day: "2026-12-05",
        cap: 450,
      });
      expect((await world.scheduleRoutines()).status).toBe(200);

      await world.clock.advanceTo("2026-12-06T03:00:00.000Z");
      expect((await world.chat("good morning")).data.reply.text).toBe("primary answers");
      expect(world.named("ai.token_cap_reached")).toHaveLength(1);
    },
  );
});
