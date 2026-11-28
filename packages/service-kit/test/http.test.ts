import { describe, expect, it, vi } from "vitest";
import { fetchWithPolicy } from "../src/http";

const ok = (status = 200) => new Response("{}", { status });

describe("fetchWithPolicy", () => {
  it("passes an abort signal so a hung call times out", async () => {
    const hang = vi.fn((_u: string, init?: RequestInit) => {
      return new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      });
    });
    await expect(
      fetchWithPolicy("http://x", {}, { timeoutMs: 10, retries: 0, fetchFn: hang }),
    ).rejects.toThrow();
    expect(hang).toHaveBeenCalledTimes(1);
  });

  it("retries idempotent calls on 503 and returns the first success", async () => {
    const fn = vi.fn().mockResolvedValueOnce(ok(503)).mockResolvedValueOnce(ok(200));
    const res = await fetchWithPolicy(
      "http://x",
      {},
      { timeoutMs: 100, retries: 2, backoffMs: 0, idempotent: true, fetchFn: fn },
    );
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("bounds retries", async () => {
    const fn = vi.fn().mockImplementation(async () => ok(503));
    const res = await fetchWithPolicy(
      "http://x",
      {},
      { timeoutMs: 100, retries: 2, backoffMs: 0, idempotent: true, fetchFn: fn },
    );
    expect(res.status).toBe(503);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("never retries a non-idempotent call", async () => {
    const fn = vi.fn().mockImplementation(async () => ok(503));
    await fetchWithPolicy(
      "http://x",
      {},
      { timeoutMs: 100, retries: 3, backoffMs: 0, fetchFn: fn },
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry client errors", async () => {
    const fn = vi.fn().mockImplementation(async () => ok(404));
    await fetchWithPolicy(
      "http://x",
      {},
      { timeoutMs: 100, retries: 3, backoffMs: 0, idempotent: true, fetchFn: fn },
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries network errors for idempotent calls", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("econnreset")).mockResolvedValueOnce(ok());
    const res = await fetchWithPolicy(
      "http://x",
      {},
      { timeoutMs: 100, retries: 1, backoffMs: 0, idempotent: true, fetchFn: fn },
    );
    expect(res.ok).toBe(true);
  });
});
