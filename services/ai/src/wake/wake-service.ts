import { randomInt, randomUUID } from "node:crypto";
import { SETTINGS, type PhotoGrade } from "@my-wife/contracts";
import { encryptSecret, type Keyring } from "../keys/secrets-crypto";
import type { ChallengeStore, WakeChallenge } from "./challenge-store";
import type { FailedPhotoStore } from "./failed-photo-store";
import type { VisionModel } from "./vision";

/** Challenge templates (locale keys); `n` is filled for the fingers request. */
const FINGERS_KEY = "ai.wake.challenge.fingers";
const CHALLENGE_KEYS = [FINGERS_KEY, "ai.wake.challenge.sink", "ai.wake.challenge.object"];
/** Fingers to hold up: 1..MAX_FINGERS. */
const MAX_FINGERS = 5;
const WINDOW_KEY = "routine.wake_photo_window_minutes";
const NUDGE_MAX_KEY = "routine.wake_nudge_max";
const RETENTION_KEY = "routine.retention.failed_wake_photo_hours";
const HOUR_MS = 3_600_000;

/** What the bot does after a grade: `retake` asks for another photo, `button_check_in` falls back. */
export type WakeNext = "done" | "retake" | "button_check_in";
export interface WakePhotoOutcome {
  grade: PhotoGrade;
  next: WakeNext;
}

export class WakeError extends Error {
  constructor(
    readonly code:
      | "consent_required"
      | "not_found"
      | "expired"
      | "already_graded"
      | "empty_image"
      | "grading_failed",
  ) {
    super(code);
  }
}

export interface WakeServiceOptions {
  store: ChallengeStore;
  vision: VisionModel;
  publish: (event: { name: "ai.photo_graded"; payload: unknown }) => Promise<void>;
  readSettings: (userId: string) => Promise<Record<string, unknown>>;
  hasConsent: (userId: string) => Promise<boolean>;
  /** Where failing photos wait, encrypted, until the appeal window ends. */
  failedPhotos: FailedPhotoStore;
  /** Secrets keyring; without one a failing photo cannot be kept encrypted, so it is not kept. */
  ring: Keyring | null;
  /** Random integer in [0, max); injectable so tests are deterministic. */
  random?: (max: number) => number;
  /** Image-free diagnostics only. */
  warn?: (fields: Record<string, unknown>, message: string) => void;
}

export class WakeService {
  constructor(private readonly o: WakeServiceOptions) {}

  /** A setting from the registry: the user's value when valid, else the default. */
  private async setting(
    userId: string,
    key: typeof WINDOW_KEY | typeof NUDGE_MAX_KEY | typeof RETENTION_KEY,
  ): Promise<number> {
    const parsed = SETTINGS[key].schema.safeParse((await this.o.readSettings(userId))[key]);
    return parsed.success ? parsed.data : SETTINGS[key].default;
  }

  async createChallenge(userId: string, now: Date): Promise<WakeChallenge> {
    if (!(await this.o.hasConsent(userId))) throw new WakeError("consent_required");
    const windowMinutes = await this.setting(userId, WINDOW_KEY);
    const random = this.o.random ?? randomInt;
    const messageKey = CHALLENGE_KEYS[random(CHALLENGE_KEYS.length)] ?? FINGERS_KEY;
    const challenge: WakeChallenge = {
      id: randomUUID(),
      userId,
      messageKey,
      params: messageKey === FINGERS_KEY ? { n: 1 + random(MAX_FINGERS) } : {},
      sentAt: now,
      expiresAt: new Date(now.getTime() + windowMinutes * 60_000),
      status: "open",
      grade: null,
      unclearCount: 0,
    };
    await this.o.store.save(challenge);
    return challenge;
  }

  /**
   * Grades one photo. The image is wiped from memory in every outcome and never logged; only a
   * `fail` photo is kept, encrypted, until the appeal window ends. The grade is informational (a
   * proposal): `unclear` is never a failure, it asks for another photo.
   */
  async submitPhoto(
    userId: string,
    challengeId: string,
    image: Buffer,
    now: Date,
  ): Promise<WakePhotoOutcome> {
    try {
      if (image.length === 0) throw new WakeError("empty_image");
      const challenge = await this.o.store.get(challengeId);
      if (!challenge || challenge.userId !== userId) throw new WakeError("not_found");
      if (challenge.status === "graded") throw new WakeError("already_graded");
      if (now.getTime() > challenge.expiresAt.getTime()) throw new WakeError("expired");
      let grade: PhotoGrade;
      try {
        grade = await this.o.vision.grade({ image, challengeKey: challenge.messageKey });
      } catch {
        // The error text could carry request data; log only the fact.
        this.o.warn?.({ challengeId }, "wake photo grading failed");
        throw new WakeError("grading_failed");
      }
      await this.o.publish({
        name: "ai.photo_graded",
        payload: { challengeId, grade, gradedAt: now.toISOString() },
      });
      let next: WakeNext = "done";
      let unclearCount = challenge.unclearCount;
      if (grade === "unclear") {
        unclearCount += 1;
        const max = await this.setting(userId, NUDGE_MAX_KEY);
        next = unclearCount >= max ? "button_check_in" : "retake";
      }
      if (grade === "fail") await this.keepFailed(userId, challengeId, image, now);
      await this.o.store.save({
        ...challenge,
        grade,
        unclearCount,
        status: next === "retake" ? "open" : "graded",
      });
      return { grade, next };
    } finally {
      image.fill(0);
    }
  }

  /** Deletes failing photos whose appeal window has ended; run by a periodic job. */
  purgeExpired(now: Date): Promise<number> {
    return this.o.failedPhotos.deleteExpired(now);
  }

  /** Deletes every kept photo of the user at once (the `wake_photo` consent was revoked). */
  deleteAllFor(userId: string): Promise<number> {
    return this.o.failedPhotos.deleteForUser(userId);
  }

  private async keepFailed(
    userId: string,
    challengeId: string,
    image: Buffer,
    now: Date,
  ): Promise<void> {
    if (!this.o.ring) {
      this.o.warn?.({ challengeId }, "failing wake photo not kept: no encryption key");
      return;
    }
    const hours = await this.setting(userId, RETENTION_KEY);
    const id = randomUUID();
    await this.o.failedPhotos.save({
      id,
      userId,
      challengeId,
      sealed: encryptSecret(image.toString("base64"), this.o.ring, `${userId}:wake_photo:${id}`),
      keptAt: now,
      deleteAfter: new Date(now.getTime() + hours * HOUR_MS),
    });
  }
}
