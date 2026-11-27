import type { SealedSecret } from "../keys/secrets-crypto";

/** A failing wake photo kept (encrypted) as evidence until the appeal window ends. */
export interface FailedPhoto {
  id: string;
  userId: string;
  challengeId: string;
  /** The image, sealed with the secrets keyring and bound to the user; never plain. */
  sealed: SealedSecret;
  keptAt: Date;
  /** The appeal window end: `keptAt` plus `routine.retention.failed_wake_photo_hours`. */
  deleteAfter: Date;
}

/** Port for failing-photo storage; the Drizzle table comes with the persistence issue. */
export interface FailedPhotoStore {
  save(photo: FailedPhoto): Promise<void>;
  /** Removes every photo whose `deleteAfter` is at or before `now`; returns how many. */
  deleteExpired(now: Date): Promise<number>;
  /** Removes every photo of one user (consent revoked); returns how many. */
  deleteForUser(userId: string): Promise<number>;
}

export class InMemoryFailedPhotoStore implements FailedPhotoStore {
  private readonly rows = new Map<string, FailedPhoto>();

  async save(photo: FailedPhoto): Promise<void> {
    this.rows.set(photo.id, { ...photo });
  }

  async deleteExpired(now: Date): Promise<number> {
    return this.removeWhere((p) => p.deleteAfter.getTime() <= now.getTime());
  }

  async deleteForUser(userId: string): Promise<number> {
    return this.removeWhere((p) => p.userId === userId);
  }

  size(): number {
    return this.rows.size;
  }

  /** Raw rows, for tests that check nothing is stored in the clear. */
  dump(): FailedPhoto[] {
    return [...this.rows.values()];
  }

  private removeWhere(test: (p: FailedPhoto) => boolean): number {
    let n = 0;
    for (const [id, p] of this.rows) {
      if (test(p)) {
        this.rows.delete(id);
        n += 1;
      }
    }
    return n;
  }
}
