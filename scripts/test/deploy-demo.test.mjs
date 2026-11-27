import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(root, "scripts", "deploy-demo.sh");

const complete = {
  DEPLOY_TARGET: "this_server",
  DOMAIN: "example.test",
  APP_SUBDOMAIN: "demo",
  CLOUDFLARE_TUNNEL_TOKEN: "tok-SECRET-123",
  SESSION_SECRET: "sess-SECRET-123",
  APP_ENCRYPTION_KEY: "enc-SECRET-123",
  ADMIN_EMAIL: "admin@example.test",
};

function baseEnv(extra) {
  return { PATH: process.env.PATH, HOME: process.env.HOME, ...extra };
}

function run(env, args = ["--check"]) {
  return spawnSync("bash", [script, ...args], {
    env: baseEnv({ INTAKE_FILE: "/nonexistent", ...env }),
    encoding: "utf8",
  });
}

test("skips with exit 0 when DEPLOY_TARGET is none or unset", () => {
  assert.equal(run({ DEPLOY_TARGET: "none" }).status, 0);
  assert.equal(run({}).status, 0);
});

test("rejects an unknown DEPLOY_TARGET", () => {
  assert.equal(run({ DEPLOY_TARGET: "mars" }).status, 2);
});

test("lists missing names only, never values", () => {
  const r = run({ ...complete, CLOUDFLARE_TUNNEL_TOKEN: "", DOMAIN: "" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /DOMAIN/);
  assert.match(r.stderr, /CLOUDFLARE_TUNNEL_TOKEN/);
  assert.doesNotMatch(r.stderr, /-SECRET-/);
});

test("complete intake passes the check and prints the address without secrets", () => {
  const r = run(complete);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /https:\/\/demo\.example\.test/);
  assert.doesNotMatch(r.stdout + r.stderr, /-SECRET-/);
});

test("compose config has cloudflared, 256 MB service limits and loopback-only ports", () => {
  const r = spawnSync(
    "docker",
    [
      "compose",
      "-f",
      "infra/docker-compose.yml",
      "-f",
      "infra/docker-compose.cloudflare.yml",
      "config",
      "--format",
      "json",
    ],
    { cwd: root, env: baseEnv({ ...complete, BIND_ADDR: "127.0.0.1" }), encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(r.stdout);
  assert.ok(cfg.services.cloudflared);
  const services = [
    "gateway",
    "identity",
    "budget",
    "ingest",
    "schedule",
    "monitor",
    "rules",
    "ai",
    "notify",
    "sync",
    "web",
  ];
  for (const name of services) {
    assert.equal(Number(cfg.services[name].mem_limit), 256 * 1024 * 1024, name);
  }
  for (const name of ["gateway", "web", "postgres", "redis", "nats"]) {
    for (const port of cfg.services[name].ports ?? []) {
      assert.equal(port.host_ip, "127.0.0.1", `${name} must bind to loopback`);
    }
  }
});
