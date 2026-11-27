import type { PhotoGrade } from "@my-wife/contracts";

export interface WakeChallenge {
  id: string;
  userId: string;
  messageKey: string;
  params: Record<string, string | number>;
  sentAt: Date;
  expiresAt: Date;
  /** `open` accepts a photo; `graded` is final (pass, fail, or unclear retries used up). `unclear` leaves it open. */
  status: "open" | "graded";
  /** Result only; the image is never part of a challenge record. */
  grade: PhotoGrade | null;
  /** Unclear photos so far; at `routine.wake_nudge_max` the flow falls back to a button. */
  unclearCount: number;
}

/** Port for challenge storage; the Drizzle table comes with the persistence issue. */
export interface ChallengeStore {
  save(challenge: WakeChallenge): Promise<void>;
  get(id: string): Promise<WakeChallenge | undefined>;
}

export class InMemoryChallengeStore implements ChallengeStore {
  private readonly rows = new Map<string, WakeChallenge>();

  async save(challenge: WakeChallenge): Promise<void> {
    this.rows.set(challenge.id, { ...challenge });
  }

  async get(id: string): Promise<WakeChallenge | undefined> {
    const row = this.rows.get(id);
    return row ? { ...row } : undefined;
  }
}
