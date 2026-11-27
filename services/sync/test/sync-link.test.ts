import { describe, expect, it } from "vitest";
import { GoogleRateLimitError, SyncLink, type SyncLinkSettings } from "../src/link/sync-link";

const T0 = new Date("2026-11-27T00:00:00Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const SETTINGS: SyncLinkSettings = {
  debounceSeconds: 5,
  retryBackoffSeconds: [10, 30, 90],
};

function setup(failures: unknown[]) {
  const written: string[] = [];
  const queue = [...failures];
  const link = new SyncLink(SETTINGS, async (batch) => {
    const f = queue.shift();
    if (f) throw f;
    written.push(...batch);
  });
  return { link, written };
}

describe("SyncLink state machine", () => {
  it("moves ready -> syncing -> ready after the debounce", async () => {
    const { link, written } = setup([]);
    link.markReady();
    link.enqueue("a", T0);
    await link.tick(at(4));
    expect(written).toEqual([]);
    await link.tick(at(5));
    expect(link.state).toBe("ready");
    expect(written).toEqual(["a"]);
  });

  it("backs off on a 429 and ends in ready without data loss", async () => {
    const { link, written } = setup([new GoogleRateLimitError(), new GoogleRateLimitError()]);
    link.markReady();
    link.enqueue("a", T0);
    await link.tick(at(5)); // first 429 -> retry at +10
    expect(link.state).toBe("ready");
    expect(link.nextAttemptAt).toEqual(at(15));
    link.enqueue("b", at(6)); // arrives during backoff, must be kept
    await link.tick(at(14));
    expect(written).toEqual([]);
    await link.tick(at(15)); // second 429 -> +30
    expect(link.nextAttemptAt).toEqual(at(45));
    await link.tick(at(45));
    expect(written).toEqual(["a", "b"]);
    expect(link.state).toBe("ready");
    expect(link.pending).toBe(0);
  });

  it("honours a Retry-After longer than the configured backoff", async () => {
    const { link } = setup([new GoogleRateLimitError(60)]);
    link.markReady();
    link.enqueue("a", T0);
    await link.tick(at(5));
    expect(link.nextAttemptAt).toEqual(at(65));
  });

  it("goes to error when retries are exhausted, keeps the data, and the next event retries", async () => {
    const { link, written } = setup(Array.from({ length: 4 }, () => new GoogleRateLimitError()));
    link.markReady();
    link.enqueue("a", T0);
    await link.tick(at(5));
    await link.tick(at(15));
    await link.tick(at(45));
    await link.tick(at(135));
    expect(link.state).toBe("error");
    expect(link.pending).toBe(1);
    link.enqueue("b", at(200));
    await link.tick(at(205));
    expect(written).toEqual(["a", "b"]);
    expect(link.state).toBe("ready");
  });

  it("retries with backoff after a non-429 API error", async () => {
    const { link, written } = setup([new Error("boom")]);
    link.markReady();
    link.enqueue("a", T0);
    await link.tick(at(5));
    expect(link.nextAttemptAt).toEqual(at(15));
    await link.tick(at(15));
    expect(written).toEqual(["a"]);
  });

  it("makes no writes after revoke", async () => {
    const { link, written } = setup([]);
    link.markReady();
    link.enqueue("a", T0);
    link.revoke();
    link.enqueue("b", T0);
    await link.tick(at(100));
    expect(link.state).toBe("revoked");
    expect(written).toEqual([]);
  });
  it("keeps the revoked state when revoked during a pending write", async () => {
    const written: string[] = [];
    let release!: () => void;
    const link: SyncLink = new SyncLink(SETTINGS, async (batch) => {
      await new Promise<void>((r) => (release = r));
      written.push(...batch);
    });
    link.markReady();
    link.enqueue("a", T0);
    const running = link.tick(at(5));
    link.revoke();
    release();
    await running;
    expect(link.state).toBe("revoked");
    expect(link.pending).toBe(0);
  });

  it("does not strand an item enqueued during an in-flight write", async () => {
    const written: string[][] = [];
    let release!: () => void;
    let first = true;
    const link: SyncLink = new SyncLink(SETTINGS, async (batch) => {
      if (first) {
        first = false;
        await new Promise<void>((r) => (release = r));
      }
      written.push([...batch]);
    });
    link.markReady();
    link.enqueue("a", T0);
    const running = link.tick(at(5));
    link.enqueue("b", at(6));
    release();
    await running;
    expect(link.pending).toBe(1);
    await link.tick(at(10));
    expect(written).toEqual([["a"], ["b"]]);
    expect(link.pending).toBe(0);
  });

  it("calls onFailed once when retries are exhausted", async () => {
    const failed: unknown[] = [];
    const link = new SyncLink(
      { debounceSeconds: 5, retryBackoffSeconds: [10] },
      async () => {
        throw new GoogleRateLimitError();
      },
      { onFailed: (err) => void failed.push(err) },
    );
    link.markReady();
    link.enqueue("a", T0);
    await link.tick(at(5));
    expect(failed).toHaveLength(0);
    await link.tick(at(15));
    expect(link.state).toBe("error");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toBeInstanceOf(GoogleRateLimitError);
  });

  it("calls onRevoked once on revoke", () => {
    let calls = 0;
    const link = new SyncLink(SETTINGS, async () => {}, { onRevoked: () => void calls++ });
    link.markReady();
    link.revoke();
    link.revoke();
    expect(calls).toBe(1);
  });
});
