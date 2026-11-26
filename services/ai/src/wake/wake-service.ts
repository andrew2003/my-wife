import { randomInt, randomUUID } from "node:crypto";
import { SETTINGS, type PhotoGrade } from "@my-wife/contracts";
import type { ChallengeStore, WakeChallenge } from "./challenge-store";
import type { VisionModel } from "./vision";

/** Challenge templates (locale keys); `n` is filled for the fingers request. */
const FINGERS_KEY = "ai.wake.challenge.fingers";
const CHALLENGE_KEYS = [FINGERS_KEY, "ai.wake.challenge.sink", "ai.wake.challenge.object"];
/** Fingers to hold up: 1..MAX_FINGERS. */
const MAX_FINGERS = 5;
const WINDOW_KEY = "routine.wake_photo_window_minutes";

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
  /** Random integer in [0, max); injectable so tests are deterministic. */
  random?: (max: number) => number;
  /** Image-free diagnostics only. */
  warn?: (fields: Record<string, unknown>, message: string) => void;
}

export class WakeService {
  constructor(private readonly o: WakeServiceOptions) {}

  async createChallenge(userId: string, now: Date): Promise<WakeChallenge> {
    if (!(await this.o.hasConsent(userId))) throw new WakeError("consent_required");
    const parsed = SETTINGS[WINDOW_KEY].schema.safeParse(
      (await this.o.readSettings(userId))[WINDOW_KEY],
    );
    const windowMinutes = parsed.success ? parsed.data : SETTINGS[WINDOW_KEY].default;
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
    };
    await this.o.store.save(challenge);
    return challenge;
  }

  /**
   * Grades one photo. The image is wiped from memory in every outcome, is never stored or logged,
   * and only the grade leaves this method. The grade is informational (a proposal).
   */
  async submitPhoto(
    userId: string,
    challengeId: string,
    image: Buffer,
    now: Date,
  ): Promise<PhotoGrade> {
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
      await this.o.store.save({
        ...challenge,
        grade,
        status: grade === "unclear" ? "open" : "graded",
      });
      return grade;
    } finally {
      image.fill(0);
    }
  }
}
