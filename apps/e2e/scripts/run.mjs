// One command: rebuild all state, build the web app for production, run the suite, clean up.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const root = join(pkg, "../..");
const db = process.env.E2E_DB_NAME ?? "mywife_e2e";
const env = { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" };

function step(cmd, args, cwd = root, extra = {}) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...env, ...extra } });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

step("node", [join(here, "make-fake-video.mjs"), join(pkg, ".cache/fake-camera.y4m")]);
step(join(here, "reset-db.sh"), [db]);
// The page is prerendered, so the locale is fixed at build time.
step("pnpm", ["--filter", "@my-wife/web", "build"], root, { UI_LANGUAGE: "en" });
step("pnpm", ["exec", "playwright", "test", ...process.argv.slice(2)], pkg);
// The money scenario drives the services in process on simulated time; it needs no web build.
step("pnpm", ["exec", "vitest", "run"], pkg);
