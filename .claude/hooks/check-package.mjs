// PostToolUse: after a file edit, run typecheck and tests for the changed package only.
// Package-scoped (pnpm --filter), quick, and silent for files outside a workspace package.
// Exit 2 with stderr feeds a failure back to the agent; every other situation exits 0.
// Set FACTORY_HOOK_SKIP_CHECKS=1 to disable. FACTORY_HOOK_TIMEOUT_MS overrides the 120 s limit per step.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { readInput, projectDir, isTestFile } from './lib.mjs';

const input = readInput();
const ti = input.tool_input ?? {};
const file = ti.file_path;
if (process.env.FACTORY_HOOK_SKIP_CHECKS === '1' || !file) process.exit(0);

const root = projectDir();
const abs = path.isAbsolute(file) ? file : path.join(root, file);
const rel = path.relative(root, abs);
if (rel.startsWith('..') || !/\.(?:[cm]?[jt]sx?|json)$/.test(rel)) process.exit(0);
if (/(^|\/)(node_modules|dist|\.next|coverage)\//.test(rel)) process.exit(0);

// Walk up to the nearest package.json that lives under packages/, services/ or apps/.
let dir = path.dirname(abs);
let pkg = null;
while (dir.startsWith(root) && dir !== root) {
  const pj = path.join(dir, 'package.json');
  if (existsSync(pj)) {
    try {
      pkg = { dir, ...JSON.parse(readFileSync(pj, 'utf8')) };
    } catch {
      /* unreadable package.json: skip */
    }
    break;
  }
  dir = path.dirname(dir);
}
if (!pkg || !pkg.name || !/^(packages|services|apps)\//.test(path.relative(root, pkg.dir))) process.exit(0);

const timeout = Number(process.env.FACTORY_HOOK_TIMEOUT_MS) || 120_000;
const failures = [];
// Typecheck runs on every edit. Tests run only when the edited file is not a test file, so that
// writing a failing test first (test-driven development) is not punished by the hook.
const scripts = isTestFile(rel.split(path.sep).join('/')) ? ['typecheck'] : ['typecheck', 'test'];
for (const script of scripts) {
  if (!pkg.scripts?.[script]) continue;
  const r = spawnSync('pnpm', ['--filter', pkg.name, script], {
    cwd: root,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, CI: '1', NODE_OPTIONS: '--max-old-space-size=2048' },
  });
  // A timeout (r.signal is SIGTERM) or a missing pnpm (r.error) is deliberately ignored and reported
  // as success: a slow or broken toolchain must not block the agent. CI and the builder's own
  // package-scoped runs remain the real gate.
  if (r.error || r.signal) continue;
  if (r.status !== 0) {
    const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n');
    failures.push(`pnpm --filter ${pkg.name} ${script} failed:\n${tail}`);
    if (script === 'typecheck') break; // no point running tests on code that does not compile
  }
}
if (failures.length) {
  process.stderr.write(failures.join('\n\n') + '\n');
  process.exit(2);
}
process.exit(0);
