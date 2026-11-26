import { randomUUID } from "node:crypto";
import type { EventEnvelope, PhotoGrade } from "@my-wife/contracts";
import { RoutineLevelSchema, SETTINGS } from "@my-wife/contracts";
import type { PlanDeps } from "./plan";
import { zoneParts, zoneSetting, zonedInstant } from "./review";

const MINUTE_MS = 60_000;

/** A localized message by key; the chat layer renders it with the user's locale. */
export interface MessageRef {
  key: string;
  params: Record<string, string | number>;
}

export interface GeneratedChallenge extends MessageRef {
  challengeId: string;
}

export type WakeChallengeState = "sent" | "received" | "graded";

/** Result only; a photo never reaches this service. */
export interface WakeChallenge {
  challengeId: string;
  userId: string;
  /** Wake time of that day (UTC ISO); lateness is measured against it. */
  wakeAt: string;
  sentAt: string;
  /** Message key of the challenge text; ai grades the photo against it. */
  challengeKey: string;
  windowEndsAt: string;
  state: WakeChallengeState;
  /** Send time of the latest photo accepted inside the window. */
  receivedAt: string | null;
  grade: PhotoGrade | null;
}

/** Port: the Drizzle store replaces the in-memory one without touching the logic. */
export interface WakeStore {
  get(challengeId: string): WakeChallenge | undefined;
  put(challenge: WakeChallenge): void;
  /** The challenge of a user for a local date, if one was sent. */
  forDay(userId: string, day: string): WakeChallenge | undefined;
  putDay(userId: string, day: string, challengeId: string): void;
}

export function createMemoryWakeStore(): WakeStore {
  const byId = new Map<string, WakeChallenge>();
  const byDay = new Map<string, string>();
  return {
    get: (id) => byId.get(id),
    put: (c) => void byId.set(c.challengeId, c),
    forDay: (u, d) => {
      const id = byDay.get(`${u}|${d}`);
      return id ? byId.get(id) : undefined;
    },
    putDay: (u, d, id) => void byDay.set(`${u}|${d}`, id),
  };
}

export interface WakeDeps {
  plan: PlanDeps;
  store: WakeStore;
  readSettings: (userId: string) => Promise<Record<string, unknown>>;
  generateChallenge: (userId: string, now: Date) => Promise<GeneratedChallenge>;
  /** notify `sendPhotoRequest` through the shared channel adapter. */
  sendPhotoRequest: (userId: string, message: MessageRef, challengeId: string) => Promise<void>;
  /** A plain chat reply. */
  sendReply: (userId: string, message: MessageRef) => Promise<void>;
}

const FAKE_KEYS = [
  "routine.wake_challenge.fingers",
  "routine.wake_challenge.sink",
  "routine.wake_challenge.object",
];
const FAKE_MAX_FINGERS = 5;

/** Fake generator for M1: the challenge changes by day; the real text comes from ai later. */
export const fakeChallengeGenerator: WakeDeps["generateChallenge"] = async (_userId, now) => {
  const dayIndex = Math.floor(now.getTime() / (24 * 60 * MINUTE_MS));
  const key = FAKE_KEYS[dayIndex % FAKE_KEYS.length] as string;
  return {
    challengeId: randomUUID(),
    key,
    params:
      key === FAKE_KEYS[0]
        ? { n: 1 + (dayIndex % FAKE_MAX_FINGERS) }
        : ({} as Record<string, number>),
  };
};

interface WakeSettings {
  active: boolean;
  hour: number;
  minute: number;
  windowMinutes: number;
  zone: string;
}

/** Invalid or missing values fall back to the registry defaults. */
function wakeSettings(raw: Record<string, unknown>): WakeSettings {
  const level = RoutineLevelSchema.safeParse(raw["routine.wake.level"]);
  const levelValue = level.success ? level.data : SETTINGS["routine.wake.level"].default;
  const time = raw["routine.wake.time"];
  const timeValue =
    typeof time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(time)
      ? time
      : (SETTINGS["routine.wake.time"].default as string);
  const window = raw["routine.wake_photo_window_minutes"];
  const windowValue =
    typeof window === "number" && Number.isInteger(window) && window > 0
      ? window
      : (SETTINGS["routine.wake_photo_window_minutes"].default as number);
  const [hour, minute] = timeValue.split(":").map(Number) as [number, number];
  return {
    active: levelValue !== "off",
    hour,
    minute,
    windowMinutes: windowValue,
    zone: zoneSetting(raw["calendar.time_zone"]),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

function envelope<T extends EventEnvelope["type"]>(
  deps: WakeDeps,
  id: string,
  type: T,
  userId: string,
  payload: unknown,
): EventEnvelope {
  return {
    id,
    type,
    occurredAt: deps.plan.now().toISOString(),
    userId,
    schemaVersion: 1,
    payload,
  } as EventEnvelope;
}

/**
 * Sends today's challenge once the wake time is reached and the photo window is still open.
 * The event is announced only after the send succeeded, so a failure is retried by the next run.
 */
export async function runWakeForUser(deps: WakeDeps, userId: string, now: Date): Promise<void> {
  const s = wakeSettings(await deps.readSettings(userId));
  if (!s.active) return;
  const nowMs = now.getTime();
  const today = zoneParts(nowMs, s.zone);
  const day = `${today.y}-${pad(today.mo)}-${pad(today.d)}`;
  const wakeMs = zonedInstant(today.y, today.mo, today.d, s.hour, s.minute, s.zone);
  // Last moment to start the challenge; the photo window itself runs from the actual send.
  const windowEndMs = wakeMs + s.windowMinutes * MINUTE_MS;
  if (nowMs < wakeMs || nowMs > windowEndMs) return;
  if (deps.store.forDay(userId, day)) return;

  const generated = await deps.generateChallenge(userId, now);
  await deps.sendPhotoRequest(
    userId,
    { key: generated.key, params: generated.params },
    generated.challengeId,
  );
  deps.store.put({
    challengeId: generated.challengeId,
    userId,
    wakeAt: new Date(wakeMs).toISOString(),
    sentAt: now.toISOString(),
    challengeKey: generated.key,
    windowEndsAt: new Date(nowMs + s.windowMinutes * MINUTE_MS).toISOString(),
    state: "sent",
    receivedAt: null,
    grade: null,
  });
  deps.store.putDay(userId, day, generated.challengeId);
  await deps.plan.publish(
    envelope(
      deps,
      `routine-wake-challenge-sent-${generated.challengeId}`,
      "routine.wake_challenge_sent",
      userId,
      {
        challengeId: generated.challengeId,
        sentAt: now.toISOString(),
      },
    ),
  );
}

export async function runWakeJob(
  deps: WakeDeps,
  now: Date,
): Promise<{ checked: number; failed: string[] }> {
  const users = [...new Set(deps.plan.store.allWeeks().map((w) => w.userId))];
  const failed: string[] = [];
  for (const userId of users) {
    try {
      await runWakeForUser(deps, userId, now);
    } catch {
      failed.push(userId);
    }
  }
  return { checked: users.length, failed };
}

export type PhotoResult =
  | { ok: true; accepted: boolean; challengeKey: string }
  | { ok: false; error: "not_found" | "already_graded" };

/**
 * A photo arrived in chat at `sentAt` (the channel's send time, the hard fact). Inside the window
 * it is announced and notify goes on to hand it to ai; after the window it is answered in plain
 * words and never graded as the wake proof.
 */
export async function receiveWakePhoto(
  deps: WakeDeps,
  userId: string,
  challengeId: string,
  sentAt: Date,
): Promise<PhotoResult> {
  const c = deps.store.get(challengeId);
  if (!c || c.userId !== userId) return { ok: false, error: "not_found" };
  if (c.state === "graded") return { ok: false, error: "already_graded" };
  if (c.state === "received") {
    // The first photo is being checked; it stays the proof and its send time is kept.
    await deps.sendReply(userId, { key: "routine.wake_photo_pending", params: {} });
    return { ok: true, accepted: false, challengeKey: c.challengeKey };
  }
  const sentMs = sentAt.getTime();
  if (sentMs > Date.parse(c.windowEndsAt) || sentMs < Date.parse(c.sentAt)) {
    await deps.sendReply(userId, { key: "routine.wake_photo_late", params: {} });
    return { ok: true, accepted: false, challengeKey: c.challengeKey };
  }
  c.state = "received";
  c.receivedAt = sentAt.toISOString();
  deps.store.put(c);
  await deps.plan.publish(
    envelope(
      deps,
      `routine-wake-photo-received-${challengeId}-${sentMs}`,
      "routine.wake_photo_received",
      userId,
      {
        challengeId,
        receivedAt: c.receivedAt,
      },
    ),
  );
  return { ok: true, accepted: true, challengeKey: c.challengeKey };
}

/**
 * `ai.photo_graded`: ai already deleted the image. A pass makes the send time of the accepted
 * photo the wake time; `unclear` asks for another photo and records no wake time; a repeated
 * delivery is ignored once the challenge is graded.
 */
export async function applyPhotoGrade(
  deps: WakeDeps,
  challengeId: string,
  grade: PhotoGrade,
): Promise<"applied" | "ignored"> {
  const c = deps.store.get(challengeId);
  if (!c || c.state !== "received" || !c.receivedAt) return "ignored";
  const userId = c.userId;
  let wakeTime: string | null = null;
  let minutesLate: number | null = null;
  if (grade === "unclear") {
    c.state = "sent";
    c.receivedAt = null;
  } else {
    c.state = "graded";
    c.grade = grade;
    if (grade === "pass") {
      wakeTime = c.receivedAt;
      minutesLate = Math.max(
        0,
        Math.floor((Date.parse(wakeTime) - Date.parse(c.wakeAt)) / MINUTE_MS),
      );
    }
  }
  deps.store.put(c);
  await deps.plan.publish(
    envelope(
      deps,
      `routine-wake-graded-${challengeId}-${grade}-${c.state}-${wakeTime ?? "none"}`,
      "routine.wake_graded",
      userId,
      {
        challengeId,
        grade,
        wakeTime,
        minutesLate,
      },
    ),
  );
  const zone = zoneSetting((await deps.readSettings(userId))["calendar.time_zone"]);
  const reply: MessageRef =
    grade === "unclear"
      ? { key: "routine.wake_photo_unclear", params: {} }
      : grade === "fail"
        ? { key: "routine.wake_photo_failed", params: {} }
        : minutesLate === 0
          ? { key: "routine.wake_recorded", params: { time: localTime(wakeTime as string, zone) } }
          : {
              key: "routine.wake_recorded_late",
              params: { time: localTime(wakeTime as string, zone), minutes: minutesLate as number },
            };
  await deps.sendReply(userId, reply);
  return "applied";
}

function localTime(iso: string, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}
