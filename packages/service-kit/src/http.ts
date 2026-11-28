export interface FetchPolicy {
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Extra attempts after the first; only used when `idempotent` is true. */
  retries?: number;
  /** Delay before retry n is `backoffMs * 2^n`. */
  backoffMs?: number;
  /** Safe to repeat (reads, downloads). Non-idempotent calls are never retried. */
  idempotent?: boolean;
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
}

export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
export const DEFAULT_FETCH_RETRIES = 2;
export const DEFAULT_FETCH_BACKOFF_MS = 200;

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** An outbound HTTP call with a timeout per attempt and bounded retries for idempotent calls. */
export async function fetchWithPolicy(
  url: string,
  init: RequestInit = {},
  policy: FetchPolicy = {},
): Promise<Response> {
  const timeoutMs = policy.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const backoffMs = policy.backoffMs ?? DEFAULT_FETCH_BACKOFF_MS;
  const retries = policy.idempotent ? Math.max(0, policy.retries ?? DEFAULT_FETCH_RETRIES) : 0;
  const doFetch = policy.fetchFn ?? ((u, i) => fetch(u, i));
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= retries;
    try {
      const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (last || !RETRYABLE_STATUS.has(res.status)) return res;
    } catch (err) {
      if (last) throw err;
    }
    await sleep(backoffMs * 2 ** attempt);
  }
}
