import { randomBytes, randomUUID } from "node:crypto";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { InMemoryPenaltyStore, InMemoryTrialStore } from "@my-wife/rules";
import { SimClock } from "@my-wife/test-kit";
// The dev runner exports no package entry point; the scenario mounts it from its sources.
import { startAll } from "../../dev-runner/src/runner";

export const ADMIN_USER = "0190a0a0-0000-7000-8000-0000000000a9";
export const EXPORT_BASE = "http://export.example.test";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = { ok: boolean; data?: any; error?: { code: string } };

/**
 * The identity, rules, schedule and budget services of the account lifecycle in one process
 * through the dev runner, on one `SimClock`. Accounts are created the way a real one is: an
 * admin invitation, accepted with its one-time token. Calls carry the user id (and the admin
 * role) the gateway would set after verifying a session.
 *
 * Wiring that exists only as a port is supplied here: the penalty port of identity reads the
 * real `GET /penalties` of rules, and the two checklist checks (a linked channel, verified mail
 * forwarding) are switches the scenario flips, because they belong to notify and ingest.
 */
export async function startOnboardingWorld(opts: { start: string }) {
  const config = loadConfig({
    SESSION_SECRET: "x".repeat(32),
    LOG_LEVEL: "silent",
    UI_LANGUAGE: "en",
    SECRETS_MASTER_KEY: randomBytes(32).toString("base64"),
  });
  const clock = new SimClock(opts.start);
  const now = () => clock.now();
  const events: EventEnvelope[] = [];
  const invitations = new Map<string, string>();
  const checks = { channelLinked: false, forwardingVerified: false };
  let rulesUrl = "";

  const runner = await startAll(config, {
    ephemeralPorts: true,
    onEvent: (e) => void events.push(e),
    identity: {
      now,
      exportBaseUrl: EXPORT_BASE,
      onInvitation: (email, token) => void invitations.set(email, token),
      checks: {
        channelLinked: async () => checks.channelLinked,
        forwardingVerified: async () => checks.forwardingVerified,
      },
      penalties: {
        listOpen: async (userId) => {
          const res = await fetch(`${rulesUrl}/penalties`, { headers: { "x-user-id": userId } });
          const body = (await res.json()) as Json;
          return (body.data.penalties as { amountVnd: number; status: string; dueDate: string }[])
            .filter((p) => p.status === "suspended" || p.status === "due")
            .map((p) => ({
              amountVnd: p.amountVnd,
              date: p.dueDate.slice(0, 10),
              status: p.status as "suspended" | "due",
            }));
        },
      },
    },
    budget: { now },
    schedule: { now },
    rules: {
      now,
      penaltyStore: new InMemoryPenaltyStore(),
      trialStore: new InMemoryTrialStore(),
    },
    // The identity publisher is wrapped by the runner; events of every service reach `onEvent`.
  });
  rulesUrl = runner.urls.rules;

  const call = async (
    service: "identity" | "rules" | "schedule" | "budget",
    userId: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    role?: "admin",
  ) => {
    const res = await fetch(`${runner.urls[service]}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-user-id": userId,
        ...(role ? { "x-user-role": role } : {}),
      },
      // Fastify refuses a JSON content type with an empty body.
      ...(method === "GET" || method === "DELETE" ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    const text = await res.text();
    let json: Json | undefined;
    try {
      json = JSON.parse(text) as Json;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, headers: res.headers };
  };

  const envelope = (type: EventEnvelope["type"], userId: string, payload: unknown) =>
    ({
      id: randomUUID(),
      type,
      userId,
      occurredAt: now().toISOString(),
      schemaVersion: 1,
      payload,
    }) as EventEnvelope;

  return {
    clock,
    checks,
    urls: runner.urls,
    events,
    types: () => events.map((e) => e.type),
    ofType: <T extends EventEnvelope["type"]>(type: T) =>
      events.filter((e) => e.type === type) as EventEnvelope<T>[],
    call,
    admin: (method: "GET" | "POST", path: string, body?: unknown) =>
      call("identity", ADMIN_USER, method, path, body, "admin"),
    /** Invites an email as the admin, then accepts the one-time token: returns the new user id. */
    createAccount: async (email: string) => {
      const invited = await call(
        "identity",
        ADMIN_USER,
        "POST",
        "/invitations",
        { email },
        "admin",
      );
      if (invited.status !== 201) throw new Error(`invitation failed: ${invited.status}`);
      const token = invitations.get(email);
      const accepted = await call("identity", ADMIN_USER, "POST", "/invitations/accept", { token });
      if (accepted.status !== 200) throw new Error(`accept failed: ${accepted.status}`);
      return accepted.json!.data.user.id as string;
    },
    /** Routes a complete event as the bus would. */
    emit: (type: EventEnvelope["type"], userId: string, payload: unknown) =>
      runner.publish(envelope(type, userId, payload)),
    /** Posts an event to a rules internal entry (the dev runner does not route every subject). */
    postEvent: (type: EventEnvelope["type"], userId: string, path: string, payload: unknown) =>
      fetch(`${runner.urls.rules}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope(type, userId, payload)),
      }),
    stop: () => runner.stop(),
  };
}

export type OnboardingWorld = Awaited<ReturnType<typeof startOnboardingWorld>>;
