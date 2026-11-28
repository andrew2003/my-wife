#!/usr/bin/env node
// Records resident set size (RSS) of a process against the web container memory limit.
// Usage: node scripts/measure-rss.mjs <idle|e2e> <pid> [--seconds N] [--interval-ms N]
// Prints one JSON line; record it in docs/perf/README.md.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Keep in sync with `mem_limit` of the web service in infra/docker-compose.yml.
export const WEB_CONTAINER_LIMIT_MB = 256;

export function parseVmRssKb(statusText) {
  const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(statusText);
  return m ? Number(m[1]) : null;
}

export function summarize(phase, samplesKb, limitMb = WEB_CONTAINER_LIMIT_MB) {
  const peakMb = Math.round(Math.max(...samplesKb) / 1024);
  return {
    phase,
    samples: samplesKb.length,
    peakMb,
    limitMb,
    percentOfLimit: Math.round((peakMb / limitMb) * 100),
    withinLimit: peakMb <= limitMb,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const [phase, pid] = args;
  const opt = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? Number(args[i + 1]) : fallback;
  };
  if (!phase || !pid) {
    console.error("usage: measure-rss.mjs <idle|e2e> <pid> [--seconds N] [--interval-ms N]");
    process.exit(2);
  }
  const seconds = opt("--seconds", 30);
  const intervalMs = opt("--interval-ms", 1000);
  const samples = [];
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const kb = parseVmRssKb(readFileSync(`/proc/${pid}/status`, "utf8"));
    if (kb !== null) samples.push(kb);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (samples.length === 0) {
    console.error("no samples collected");
    process.exit(1);
  }
  console.log(JSON.stringify(summarize(phase, samples)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
