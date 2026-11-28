import { z } from "zod";
import { aiEvents } from "../ai/events";
import { commandEvents } from "../commands/events";
import { budgetEvents } from "../budget/events";
import { IdSchema, IsoDateTimeSchema, type ServiceName } from "../common";
import { adminEvents, identityEvents } from "../identity/events";
import { ingestEvents } from "../ingest/events";
import { monitorEvents } from "../monitor/events";
import { notifyEvents } from "../notify/events";
import { rulesEvents } from "../rules/events";
import { scheduleEvents } from "../schedule/events";
import { syncEvents } from "../sync/events";

/** Bump when an event envelope changes shape. Payload changes need an ADR. */
export const EVENT_SCHEMA_VERSION = 1;

const tag = <S extends ServiceName, M extends Record<string, z.ZodTypeAny>>(
  publisher: S,
  events: M,
) => ({ publisher, events });

const groups = [
  tag("budget", budgetEvents),
  tag("ingest", ingestEvents),
  tag("rules", rulesEvents),
  tag("schedule", scheduleEvents),
  tag("monitor", monitorEvents),
  tag("ai", aiEvents),
  tag("notify", notifyEvents),
  tag("identity", identityEvents),
  tag("identity", adminEvents),
  tag("sync", syncEvents),
  tag("notify", commandEvents),
] as const;

type AllEvents = typeof budgetEvents &
  typeof ingestEvents &
  typeof rulesEvents &
  typeof scheduleEvents &
  typeof monitorEvents &
  typeof aiEvents &
  typeof notifyEvents &
  typeof identityEvents &
  typeof adminEvents &
  typeof syncEvents &
  typeof commandEvents;

export type EventSubject = keyof AllEvents;
export type EventPayload<S extends EventSubject> = z.infer<AllEvents[S]>;

export interface EventDefinition {
  publisher: ServiceName;
  payload: z.ZodTypeAny;
}

function build(): Record<EventSubject, EventDefinition> {
  const registry: Record<string, EventDefinition> = {};
  for (const group of groups) {
    for (const [subject, payload] of Object.entries(group.events)) {
      if (registry[subject]) throw new Error(`duplicate event subject: ${subject}`);
      registry[subject] = { publisher: group.publisher, payload };
    }
  }
  return registry as Record<EventSubject, EventDefinition>;
}

/** Authoritative registry: subject -> publisher and payload schema (ADR 0002). */
export const EVENT_REGISTRY = build();

export const eventSubjects = (): EventSubject[] => Object.keys(EVENT_REGISTRY) as EventSubject[];

const envelopeBase = {
  id: IdSchema,
  occurredAt: IsoDateTimeSchema,
  userId: IdSchema,
  schemaVersion: z.number().int().positive(),
};

/** Envelope schema per subject, for publishers and consumers. */
export const EventEnvelopeSchemas = Object.fromEntries(
  eventSubjects().map((subject) => [
    subject,
    z.object({ ...envelopeBase, type: z.literal(subject), payload: EVENT_REGISTRY[subject].payload }),
  ]),
) as unknown as { [S in EventSubject]: z.ZodType<{ id: string; occurredAt: string; userId: string; schemaVersion: number; type: S; payload: EventPayload<S> }> };

export type EventEnvelope<S extends EventSubject = EventSubject> = {
  id: string;
  occurredAt: string;
  userId: string;
  schemaVersion: number;
  type: S;
  payload: EventPayload<S>;
};

export function parseEvent(
  input: unknown,
): { success: true; data: EventEnvelope } | { success: false; error: string } {
  const type = (input as { type?: unknown } | null)?.type;
  if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(EVENT_REGISTRY, type)) {
    return { success: false, error: `unknown event type: ${String(type)}` };
  }
  const result = EventEnvelopeSchemas[type as EventSubject].safeParse(input);
  return result.success
    ? { success: true, data: result.data as EventEnvelope }
    : { success: false, error: result.error.message };
}
