import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import { createFaultService, InMemoryFaultStore, summarizeWaivedFaults } from "@my-wife/rules";
import type { IncidentWindow } from "@my-wife/rules";
import { DAY_MS } from "@my-wife/test-kit";
import {
  ADMIN_USER,
  EXPORT_BASE,
  startOnboardingWorld,
  type OnboardingWorld,
} from "../support/onboarding-world";

/**
 * Scenario 1, extended: the account lifecycle of a preview account on simulated time, past the
 * happy path of `onboarding.spec.ts`.
 *
 * Monday 2026-12-07 (Asia/Ho_Chi_Minh, default cycle of 4 weeks).
 *
 * - Checklist: every item starts pending; each flips on its real fact (a linked channel, a saved
 *   key, a granted camera consent) or on the recorded step (skipped, done).
 * - Contract per cycle: a new cycle asks for a new signature, loosening stays locked to the cycle
 *   end, a repeat signature changes nothing.
 * - Admin incident: only an admin declares it, it is audited without personal data, a fault in
 *   its window is waived with the incident as cause, one outside it is recorded.
 * - Export: a one-time link with an expiry; no secret in the archive; nobody else can read it.
 * - Deletion: a typed confirmation is needed; open penalties keep the account `closing`; a clean
 *   account is `closed` at once.
 * The steps build on the state of the previous one.
 */
async function step(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    throw new Error(`step failed: ${name}`, { cause: err });
  }
}

const START = "2026-12-07T03:00:00.000Z"; // 10:00 local
const EMAIL = "preview@example.test";
const OTHER_EMAIL = "clean@example.test";
const LLM_KEY = "sk-preview-secret-1234567890";
const CYCLE_ONE = randomUUID();
const CYCLE_TWO = randomUUID();

let world: OnboardingWorld;
let user: string;
let downloadPath: string;

beforeAll(async () => {
  world = await startOnboardingWorld({ start: START });
});
afterAll(async () => {
  await world.stop();
});

const as = (method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) =>
  world.call("identity", user, method, path, body);
const checklist = async () => {
  const res = await as("GET", "/onboarding/checklist");
  expect(res.status).toBe(200);
  return Object.fromEntries(
    (res.json!.data.items as { step: string; status: string; checked: boolean }[]).map((i) => [
      i.step,
      i.status,
    ]),
  );
};
const contractStatus = async () =>
  (await world.call("rules", user, "GET", "/contracts/status")).json!.data;
const sign = async (cycleId: string) =>
  (await world.call("rules", user, "POST", "/contracts/sign", { cycleId })).json!.data.contract as {
    id: string;
    version: number;
  };

it("onboarding extended: checklist, contract per cycle, admin incident, export and deletion", async () => {
  await step(
    "an invited preview account answers the setup and applies a starter pack",
    async () => {
      user = await world.createAccount(EMAIL);
      const answers = await as("POST", "/onboarding/setup-answers", {
        answers: { "routine.wake.time": "06:15" },
      });
      expect(answers.status).toBe(200);
      expect(answers.json!.data.changedKeys).toEqual(["routine.wake.time"]);
      const packs = await as("GET", "/onboarding/packs");
      expect((packs.json!.data.packs as { id: string }[]).map((p) => p.id)).toContain("student");
      const applied = await as("POST", "/onboarding/packs/student/apply");
      expect(applied.status).toBe(200);
      const settings = (await as("GET", "/settings")).json!.data.values;
      expect(settings["routine.wake.time"]).toBe("06:30"); // the pack overrides the earlier answer
      expect(settings["budget.tolerance_min_vnd"]).toBe(5000);
      const completed = await as("POST", "/onboarding/steps", {
        step: "qa_templates",
        skipped: false,
      });
      expect(completed.status).toBe(200);
      expect(world.ofType("user.activated")).toHaveLength(1);
      expect(world.types()).toContain("cycle.draft_created");
    },
  );

  await step("the checklist starts with every item pending", async () => {
    expect(await checklist()).toEqual({
      connect_channel: "pending",
      llm_key: "pending",
      mail_forwarding: "pending",
      notifications_camera_install: "pending",
      do_not_disturb: "pending",
    });
  });

  await step("each item turns on its real fact or its recorded step", async () => {
    world.checks.channelLinked = true;
    expect((await checklist()).connect_channel).toBe("done");

    const saved = await as("PUT", "/secrets/llm_key", { value: LLM_KEY });
    expect(saved.status).toBe(200);
    expect(saved.text).not.toContain(LLM_KEY);
    expect((await checklist()).llm_key).toBe("done");

    // A check that fails stays pending; a skipped step is reported as skipped.
    await as("POST", "/onboarding/steps", { step: "mail_forwarding", skipped: true });
    expect((await checklist()).mail_forwarding).toBe("skipped");
    world.checks.forwardingVerified = true;
    expect((await checklist()).mail_forwarding).toBe("done");

    expect((await checklist()).notifications_camera_install).toBe("pending");
    const consent = await as("POST", "/consents", { kind: "camera", textVersion: 1 });
    expect(consent.status).toBe(200);
    expect((await checklist()).notifications_camera_install).toBe("done");

    // Do not disturb has no server-side fact: the recorded step decides.
    await as("POST", "/onboarding/steps", { step: "do_not_disturb", skipped: false });
    expect(await checklist()).toEqual({
      connect_channel: "done",
      llm_key: "done",
      mail_forwarding: "done",
      notifications_camera_install: "done",
      do_not_disturb: "done",
    });
  });

  await step("a cycle opens and asks for a signature; loosening stays locked", async () => {
    expect(
      (
        await world.postEvent("cycle.opened", user, "/events/cycle-opened", {
          cycleId: CYCLE_ONE,
          sequence: 1,
          firstDay: "2026-12-07",
        })
      ).status,
    ).toBe(200);
    expect(await contractStatus()).toMatchObject({
      cycleId: CYCLE_ONE,
      contractRequired: true,
      looseningLockedUntil: "2027-01-03T17:00:00.000Z", // Monday 4 January, local midnight
    });
  });

  await step("signing once satisfies the cycle; a repeat changes nothing", async () => {
    const first = await sign(CYCLE_ONE);
    expect(first.version).toBe(1);
    expect(await contractStatus()).toMatchObject({ cycleId: CYCLE_ONE, contractRequired: false });
    expect(await sign(CYCLE_ONE)).toEqual(first);
    expect(world.ofType("contract.signed")).toHaveLength(1);
  });

  await step("an overspend in the trial is suspended, not due", async () => {
    await world.emit("overspend.detected", user, {
      cycleId: CYCLE_ONE,
      weekIndex: 1,
      categoryId: randomUUID(),
      priority: "want",
      weeklyLimitVnd: 100_000,
      spentVnd: 150_000,
      excessVnd: 50_000,
    });
    const penalties = (await world.call("rules", user, "GET", "/penalties")).json!.data;
    expect(penalties.penalties).toHaveLength(1);
    expect(penalties.penalties[0]).toMatchObject({ status: "suspended" });
    expect(world.types()).toContain("penalty.suspended");
    expect(world.types()).not.toContain("penalty.issued");
  });

  await step("the next cycle asks for its own new signature", async () => {
    await world.clock.advanceTo("2027-01-03T17:00:00.000Z"); // Monday 4 January, local midnight
    await world.postEvent("cycle.opened", user, "/events/cycle-opened", {
      cycleId: CYCLE_TWO,
      sequence: 2,
      firstDay: "2027-01-04",
    });
    expect(await contractStatus()).toMatchObject({ cycleId: CYCLE_TWO, contractRequired: true });
    const second = await sign(CYCLE_TWO);
    expect(second.version).toBe(1);
    expect(await contractStatus()).toMatchObject({ cycleId: CYCLE_TWO, contractRequired: false });
    const signed = world.ofType("contract.signed");
    expect(signed).toHaveLength(2);
    expect(signed.map((e) => (e.payload as { cycleId: string }).cycleId)).toEqual([
      CYCLE_ONE,
      CYCLE_TWO,
    ]);
  });

  let incidentId = "";
  await step("only an admin declares an incident, and the action is audited", async () => {
    await world.clock.advanceTo("2027-01-05T03:00:00.000Z");
    const body = {
      startsAt: "2027-01-05T07:00:00.000Z", // 14:00 local
      endsAt: "2027-01-05T07:30:00.000Z",
      scope: "all",
      reason: "Platform outage",
    };
    const refused = await as("POST", "/admin/incidents", body);
    expect(refused.status).toBe(403);
    expect(refused.json!.error!.code).toBe("identity.forbidden");
    expect((await world.admin("POST", "/admin/incidents", { ...body, reason: "  " })).status).toBe(
      400,
    );
    const declared = await world.admin("POST", "/admin/incidents", body);
    expect(declared.status).toBe(201);
    incidentId = declared.json!.data.incident.id;
    expect(declared.json!.data.incident).toMatchObject({
      state: "ended",
      reason: "Platform outage",
    });
    expect(world.ofType("incident.declared")).toHaveLength(1);

    const audit = (await world.admin("GET", "/admin/audit?action=incident")).json!.data.entries;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: ADMIN_USER, action: "incident.declared" });
    expect(JSON.stringify(audit)).not.toContain(EMAIL);
    expect((await as("GET", "/admin/audit")).status).toBe(403);
  });

  await step(
    "a fault inside the incident is waived with it as cause, one outside is not",
    async () => {
      const store = new InMemoryFaultStore();
      const published: EventEnvelope[] = [];
      // The rules app does not read incidents yet; its fault service takes them from this port.
      const faults = createFaultService({
        store,
        publish: (e) => void published.push(e),
        listIncidents: async () =>
          (
            (await world.admin("GET", "/admin/incidents")).json!.data.incidents as IncidentWindow[]
          ).filter((i) => i.id === incidentId),
      });
      const detected = (signalRef: string, occurredAt: string) =>
        ({
          id: randomUUID(),
          type: "fault.detected",
          userId: user,
          occurredAt,
          schemaVersion: 1,
          payload: {
            signalRef,
            type: "wake_late",
            occurredAt,
            reason: "none",
            reasonRef: null,
            reasonKind: null,
            overlapsOutage: false,
          },
        }) as EventEnvelope;
      const inside = await faults.onFaultDetected(
        detected("in-window", "2027-01-05T07:10:00.000Z"),
        world.clock.now(),
      );
      const outside = await faults.onFaultDetected(
        detected("out-of-window", "2027-01-05T07:45:00.000Z"),
        world.clock.now(),
      );
      expect(inside.status).toBe("waived_system");
      expect(outside.status).toBe("recorded");
      const waived = published.filter((e) => e.type === "fault.waived");
      expect(waived).toHaveLength(1);
      expect(waived[0]!.payload).toMatchObject({ cause: "admin_incident", kind: "system" });
      expect(published.filter((e) => e.type === "fault.recorded")).toHaveLength(1);

      const report = summarizeWaivedFaults(
        store.list(user),
        new Date("2027-01-04T17:00:00.000Z"),
        new Date("2027-01-11T17:00:00.000Z"),
      );
      expect(report.items).toHaveLength(1);
      expect(report.items[0]).toMatchObject({ cause: "admin_incident", type: "wake_late" });
      // The affected user reads the reason of the incident behind the waiver.
      const seen = await as("GET", `/incidents/${incidentId}`);
      expect(seen.json!.data.incident.reason).toBe("Platform outage");
    },
  );

  await step("an open incident ends and a mistaken one is cancelled, both audited", async () => {
    await world.clock.advanceTo("2027-01-05T09:00:00.000Z");
    const open = await world.admin("POST", "/admin/incidents", {
      startsAt: "2027-01-05T08:00:00.000Z",
      endsAt: null,
      scope: "all",
      reason: "Queue stalled",
    });
    expect(open.json!.data.incident.state).toBe("active");
    const ended = await world.admin(
      "POST",
      `/admin/incidents/${open.json!.data.incident.id}/end`,
      {},
    );
    expect(ended.json!.data.incident).toMatchObject({
      state: "ended",
      endsAt: world.clock.now().toISOString(),
    });
    const cancelled = await world.admin("POST", `/admin/incidents/${incidentId}/cancel`);
    expect(cancelled.json!.data.incident.state).toBe("cancelled");
    expect((await world.admin("POST", `/admin/incidents/${incidentId}/cancel`)).status).toBe(409);
    expect(world.ofType("incident.ended")).toHaveLength(1);
    expect(world.ofType("incident.cancelled")).toHaveLength(1);
    const actions = (await world.admin("GET", "/admin/audit")).json!.data.entries.map(
      (e: { action: string }) => e.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(["incident.declared", "incident.ended", "incident.cancelled"]),
    );
  });

  await step("an export link works once built, holds no secret and is private", async () => {
    const res = await as("POST", "/export");
    expect(res.status).toBe(200);
    const { downloadUrl, expiresAt } = res.json!.data;
    expect(downloadUrl.startsWith(`${EXPORT_BASE}/exports/`)).toBe(true);
    expect(expiresAt).toBe(new Date(world.clock.now().getTime() + DAY_MS).toISOString());
    expect(world.ofType("export.ready")).toHaveLength(1);
    expect(JSON.stringify(world.ofType("export.ready")[0]!.payload)).not.toContain("exports/");

    downloadPath = new URL(downloadUrl).pathname;
    const file = await as("GET", downloadPath);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toContain("my-wife-export.json");
    const archive = file.json as unknown as {
      profile: { email: string };
      settings: Record<string, unknown>;
      consents: { kind: string }[];
      onboarding: { step: string }[];
    };
    expect(archive.profile.email).toBe(EMAIL);
    expect(archive.settings["routine.wake.time"]).toBe("06:30");
    expect(archive.consents.map((c) => c.kind)).toEqual(["camera"]);
    expect(archive.onboarding.map((s) => s.step)).toContain("qa_templates");
    for (const secret of [LLM_KEY, "tokenHash", "sessionToken", "ciphertext"]) {
      expect(file.text).not.toContain(secret);
    }

    const stranger = await world.call("identity", ADMIN_USER, "GET", downloadPath);
    expect(stranger.status).toBe(404);
  });

  await step("the export link expires after its time to live", async () => {
    await world.clock.advanceBy(DAY_MS + 60_000);
    const late = await as("GET", downloadPath);
    expect(late.status).toBe(410);
    expect(late.json!.error!.code).toBe("identity.export_expired");
  });

  await step(
    "deletion needs the typed email; open penalties keep the account closing",
    async () => {
      const fresh = (await as("POST", "/export")).json!.data.downloadUrl as string;
      downloadPath = new URL(fresh).pathname;
      expect((await as("GET", downloadPath)).status).toBe(200);

      const unconfirmed = await as("POST", "/account/deletion", { confirmation: "delete" });
      expect(unconfirmed.status).toBe(400);
      expect(unconfirmed.json!.error!.code).toBe("identity.deletion_not_confirmed");
      expect(world.types()).not.toContain("user.closing");

      const deleted = await as("POST", "/account/deletion", { confirmation: EMAIL });
      expect(deleted.status).toBe(200);
      expect(deleted.json!.data).toEqual({ state: "closing", exportOffered: true });
      expect(world.ofType("user.closing")).toHaveLength(1);
      expect(world.ofType("user.closing")[0]!.payload).toMatchObject({
        reason: "deletion_requested",
      });
      expect((await as("GET", downloadPath)).status).toBe(404);
      expect((await as("GET", "/consents")).json!.data.consents).toEqual([]);
      expect((await as("GET", "/secrets")).json!.data).toEqual([]);

      // The suspended penalty is still open, so the housekeeping job keeps the account closing.
      const job = await as("POST", "/jobs/closing");
      expect(job.json!.data).toEqual({ closed: 0 });
      expect(world.types()).not.toContain("user.closed");
      // Asking again is safe.
      expect((await as("POST", "/account/deletion", {})).json!.data.state).toBe("closing");
    },
  );

  await step("an account with no open penalty is closed at once", async () => {
    const other = await world.createAccount(OTHER_EMAIL);
    const res = await world.call("identity", other, "POST", "/account/deletion", {
      confirmation: OTHER_EMAIL.toUpperCase(),
    });
    expect(res.status).toBe(200);
    expect(res.json!.data).toEqual({ state: "closed", exportOffered: true });
    const closed = world.ofType("user.closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]!.userId).toBe(other);
    // A closed account cannot be deleted again.
    const again = await world.call("identity", other, "POST", "/account/deletion", {
      confirmation: OTHER_EMAIL,
    });
    expect(again.status).toBe(409);
  });
});
