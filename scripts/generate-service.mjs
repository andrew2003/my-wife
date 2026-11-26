#!/usr/bin/env node
// Generates services/<name> from templates/service.
// Usage: pnpm generate:service <name> [--force]
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVICE_NAMES = [
  "gateway", "identity", "budget", "ingest", "schedule",
  "monitor", "rules", "ai", "notify", "sync",
];
const BASE_PORT = 4000;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [name, ...flags] = process.argv.slice(2);

if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error("Usage: generate-service <kebab-case-name> [--force]");
  process.exit(1);
}

const target = join(root, "services", name);
if (existsSync(target) && !flags.includes("--force")) {
  console.error(`services/${name} already exists (use --force to regenerate)`);
  process.exit(1);
}

const index = SERVICE_NAMES.indexOf(name);
const port = BASE_PORT + (index >= 0 ? index : SERVICE_NAMES.length);

function copy(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const src = join(from, entry);
    const dst = join(to, entry);
    if (statSync(src).isDirectory()) {
      copy(src, dst);
      continue;
    }
    const text = readFileSync(src, "utf8").replaceAll("__NAME__", name).replaceAll("__PORT__", String(port));
    // Never overwrite hand-written source on --force: only create missing files under src/ and test/.
    if (existsSync(dst) && /[/\\](src|test)[/\\]/.test(dst)) continue;
    writeFileSync(dst, text);
  }
}

copy(join(root, "templates", "service"), target);
console.log(`Generated services/${name} (port ${port}). Run pnpm install to link it.`);
