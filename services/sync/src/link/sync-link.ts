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

/** Injected side effects; the caller publishes `sync.failed` / `sync.link_revoked` and notifies. */
export type SyncLinkHooks = {
  onFailed?: (err: unknown, now: Date) => void;
  onRevoked?: () => void;
};

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
    private readonly hooks: SyncLinkHooks = {},
  ) {}

  get pending() {
    return this.queue.length;
  }

  /** Separate method so the check is not narrowed away across the awaited write. */
  private isRevoked() {
    return this.state === "revoked";
  }

  markReady() {
    if (this.state !== "revoked") this.state = "ready";
  }

  /** Token or consent revoked: no further writes. */
  revoke() {
    const already = this.state === "revoked";
    this.state = "revoked";
    this.queue = [];
    this.dueAt = null;
    this.nextAttemptAt = null;
    if (!already) this.hooks.onRevoked?.();
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
      if (this.isRevoked()) return;
      this.onFailure(err, now);
      return;
    }
    if (this.isRevoked()) return;
    this.queue = this.queue.slice(batch.length);
    this.attempts = 0;
    this.nextAttemptAt = null;
    // Items enqueued during the write wait for a fresh debounce instead of being stranded.
    this.dueAt =
      this.queue.length > 0 ? new Date(now.getTime() + this.settings.debounceSeconds * 1000) : null;
    this.state = "ready";
  }

  private onFailure(err: unknown, now: Date) {
    const backoff = this.settings.retryBackoffSeconds[this.attempts];
    if (backoff === undefined) {
      this.state = "error";
      this.nextAttemptAt = null;
      this.dueAt = null;
      this.hooks.onFailed?.(err, now);
      return;
    }
    this.attempts += 1;
    const retryAfter = err instanceof GoogleRateLimitError ? (err.retryAfterSeconds ?? 0) : 0;
    this.nextAttemptAt = new Date(now.getTime() + Math.max(backoff, retryAfter) * 1000);
    this.state = "ready";
  }
}
