import type { AppConfig } from "@my-wife/config";
import { parseEvent, type EventEnvelope } from "@my-wife/contracts";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";
import { buildSampleDay, type SampleAnswers, type SampleBlock } from "./sample-schedule";

export const SERVICE_NAME = "schedule";

export type ScheduleDeps = ServiceDeps & {
  /** Time is a parameter so tests can simulate it. */
  now?: () => Date;
  /** Reads the user's settings (identity `GET /settings` in production). */
  readSettings?: (userId: string) => Promise<SampleAnswers>;
};

interface SampleSchedule {
  generatedAt: string;
  blocks: SampleBlock[];
}

/** Without a settings source every answer falls back to its registry default. */
const defaultReader = async (): Promise<SampleAnswers> => ({});

/** Factory used by main.ts, the dev runner and tests; no process-level globals (ADR 0007). */
export function createApp(config: AppConfig, deps: ScheduleDeps = {}) {
  const app = createServiceApp({
    name: SERVICE_NAME,
    logLevel: config.logLevel,
    nats: deps.nats,
  });
  const now = deps.now ?? (() => new Date());
  const readSettings = deps.readSettings ?? defaultReader;
  const samples = new Map<string, SampleSchedule>();

  /** Internal entry for the bus bridge: `onboarding.step_completed` with step `qa_templates`. */
  app.post("/events/onboarding-step-completed", async (req, reply) => {
    const parsed = parseEvent(req.body);
    if (!parsed.success || parsed.data.type !== "onboarding.step_completed") {
      return reply.code(400).send({ ok: false, error: { code: "schedule.invalid_event" } });
    }
    const { userId, payload } = parsed.data as EventEnvelope<"onboarding.step_completed">;
    if (payload.step !== "qa_templates" || samples.has(userId)) {
      return { ok: true, data: { generated: false } };
    }
    // Reserve first so a concurrent delivery cannot generate twice.
    const sample: SampleSchedule = { generatedAt: now().toISOString(), blocks: [] };
    samples.set(userId, sample);
    try {
      sample.blocks = buildSampleDay(await readSettings(userId));
    } catch (err) {
      samples.delete(userId);
      throw err;
    }
    return { ok: true, data: { generated: true } };
  });

  app.get("/sample-schedule", async (req, reply) => {
    const id = req.headers["x-user-id"];
    if (typeof id !== "string" || !id) {
      return reply.code(401).send({ ok: false, error: { code: "schedule.unauthenticated" } });
    }
    const sample = samples.get(id);
    if (!sample) return reply.code(404).send({ ok: false, error: { code: "schedule.not_found" } });
    return { ok: true, data: sample };
  });
  return app;
}
