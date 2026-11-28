import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVmRssKb, summarize, WEB_CONTAINER_LIMIT_MB } from "../measure-rss.mjs";

test("parses VmRSS from /proc status text", () => {
  assert.equal(parseVmRssKb("Name:\tnode\nVmRSS:\t  204800 kB\nThreads:\t4\n"), 204800);
  assert.equal(parseVmRssKb("Name:\tnode\n"), null);
});

test("web container limit is 256 MB", () => {
  assert.equal(WEB_CONTAINER_LIMIT_MB, 256);
});

test("summarize reports peak and share of the limit", () => {
  const out = summarize("idle", [100 * 1024, 128 * 1024, 64 * 1024]);
  assert.equal(out.phase, "idle");
  assert.equal(out.peakMb, 128);
  assert.equal(out.limitMb, 256);
  assert.equal(out.percentOfLimit, 50);
  assert.equal(out.withinLimit, true);
  assert.equal(summarize("e2e", [300 * 1024]).withinLimit, false);
});
