export type LinkState = "unlinked" | "linking" | "ready" | "syncing" | "error" | "revoked";

/** Both values are user-configurable settings (`sync.debounce_seconds`, `sync.retry_backoff_seconds`). */
export type SyncLinkSettings = {
  debounceSeconds: number;
  /** One entry per retry; the list length is the retry limit. */
  retryBackoffSeconds: number[];
};

/** Google API answered HTTP 429; `retryAfterSeconds` mirrors the Retry-After header. */
export class GoogleRateLimitError extends Error {
  constructor(readonly retryAfterSeconds?: number) {
    super("google rate limit");
  }
}

/**
 * Per-link sync state machine (spec 41 section 4). Time is always a parameter.
 * Work stays queued until a write succeeds, so a 429 never loses data; writes are idempotent.
 */
export class SyncLink<T = string> {
  state: LinkState = "unlinked";
  nextAttemptAt: Date | null = null;
  private queue: T[] = [];
  private dueAt: Date | null = null;
  private attempts = 0;

  constructor(
    private readonly settings: SyncLinkSettings,
    private readonly write: (batch: T[]) => Promise<void>,
  ) {}

  get pending() {
    return this.queue.length;
  }

  markReady() {
    if (this.state !== "revoked") this.state = "ready";
  }

  /** Token or consent revoked: no further writes. */
  revoke() {
    this.state = "revoked";
    this.queue = [];
    this.dueAt = null;
    this.nextAttemptAt = null;
  }

  enqueue(item: T, now: Date) {
    if (this.state === "revoked" || this.state === "unlinked" || this.state === "linking") return;
    this.queue.push(item);
    if (this.state === "error") {
      // After exhausted retries the next event retries.
      this.attempts = 0;
      this.state = "ready";
      this.nextAttemptAt = null;
    }
    if (!this.nextAttemptAt) {
      this.dueAt = new Date(now.getTime() + this.settings.debounceSeconds * 1000);
    }
  }

  /** Runs the pending sync when it is due at `now`. */
  async tick(now: Date): Promise<void> {
    if (this.state !== "ready" || this.queue.length === 0) return;
    const due = this.nextAttemptAt ?? this.dueAt;
    if (!due || now < due) return;
    const batch = this.queue.slice();
    this.state = "syncing";
    try {
      await this.write(batch);
    } catch (err) {
      this.onFailure(err, now);
      return;
    }
    this.queue = this.queue.slice(batch.length);
    this.attempts = 0;
    this.nextAttemptAt = null;
    this.dueAt = null;
    this.state = "ready";
  }

  private onFailure(err: unknown, now: Date) {
    const backoff = this.settings.retryBackoffSeconds[this.attempts];
    if (backoff === undefined) {
      this.state = "error";
      this.nextAttemptAt = null;
      return;
    }
    this.attempts += 1;
    const retryAfter = err instanceof GoogleRateLimitError ? (err.retryAfterSeconds ?? 0) : 0;
    this.nextAttemptAt = new Date(now.getTime() + Math.max(backoff, retryAfter) * 1000);
    this.state = "ready";
  }
}
