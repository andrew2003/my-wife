#!/usr/bin/env node
// My Wife factory controller. Entry point: scripts/run.sh <command>
// No dependencies. Requires Node.js >= 20.
//
//   scripts/run.sh test [--quick]      self-test against the real Claude Code; must pass before run
//   scripts/run.sh run [--fg]          start or resume
//   scripts/run.sh stop [--now]        stop (default: after the current cycle)
//   scripts/run.sh status              show progress and answer questions
//   scripts/run.sh log [-f] [-n N]     show the log
//
// This script only does the mechanical work: validate the intake form, invoke
// Claude Code once per cycle, back off when the usage limit is hit, detect
// stalls, and store questions and answers. Everything that requires judgment
// lives in factory/prompts/lead.md and factory/agents/.

import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const FDIR = path.dirname(SELF);
const ROOT = path.resolve(FDIR, '..');
const P = {
  intake: path.join(FDIR, 'INTAKE.env'),
  intakeExample: path.join(FDIR, 'INTAKE.example.env'),
  config: path.join(FDIR, 'config.env'),
  state: path.join(FDIR, 'state.json'),
  runtime: path.join(FDIR, '.runtime.json'),
  stop: path.join(FDIR, 'STOP'),
  logDir: path.join(FDIR, 'logs'),
  log: path.join(FDIR, 'logs', 'factory.log'),
  questions: path.join(FDIR, 'questions'),
  handoff: path.join(FDIR, 'handoff'),
  backlog: path.join(FDIR, 'backlog.json'),
  progress: path.join(FDIR, 'PROGRESS.md'),
  agents: path.join(ROOT, '.claude', 'agents'),
  agentSrc: path.join(FDIR, 'agents'),
  selftestDir: path.join(FDIR, '.selftest'),
  selftestMarker: path.join(FDIR, '.selftest.json'),
  selftestReport: path.join(FDIR, 'selftest-report.md'),
};

// Fields that must be filled in before the factory can start.
const REQUIRED = ['PROJECT_NAME', 'GITHUB_OWNER', 'GITHUB_REPO', 'GIT_USER_NAME', 'GIT_USER_EMAIL', 'DEFAULT_TIMEZONE'];
// Fields needed before the real acceptance test of a milestone (reminder only, shown by `status`).
const NEEDED_BY = {
  M1: ['ADMIN_EMAIL', 'DOMAIN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'TELEGRAM_BOT_TOKEN', 'DISCORD_BOT_TOKEN', 'DISCORD_APPLICATION_ID', 'LLM_API_KEY'],
  M2: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
};

// ---------- utilities ----------
const now = () => new Date();
const stamp = () => {
  const d = now();
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => fs.existsSync(p);
const readText = (p, d = '') => (exists(p) ? fs.readFileSync(p, 'utf8') : d);
function readJson(p, d = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; }
}
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
}
function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}
function setEnvValue(file, key, value) {
  const lines = readText(file).split(/\r?\n/);
  let found = false;
  const next = lines.map((l) => {
    if (l.trim().startsWith(key + '=')) { found = true; return `${key}=${value}`; }
    return l;
  });
  if (!found) next.push(`${key}=${value}`);
  fs.writeFileSync(file, next.join('\n'));
}
const cfg = () => parseEnv(readText(P.config));
const intake = () => parseEnv(readText(P.intake));
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

function log(msg, tag = 'factory') {
  fs.mkdirSync(P.logDir, { recursive: true });
  const line = `[${stamp()}] [${tag}] ${msg}\n`;
  fs.appendFileSync(P.log, line);
  if (process.env.FACTORY_FG === '1') process.stdout.write(line);
}
process.stdout.on('error', () => {});
function say(msg = '') { process.stdout.write(msg + '\n'); }

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a.trim()); }));
}
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
  return { ok: r.status === 0, code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), missing: !!r.error };
}
const claudeBin = () => process.env.FACTORY_CLAUDE_BIN || 'claude';

// ---------- machine resources ----------
function meminfo(key) {
  try {
    const m = new RegExp('^' + key + ':\\s+(\\d+)', 'm').exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) return Math.round(Number(m[1]) / 1024);
  } catch {}
  return null;
}
const memAvailableMB = () => meminfo('MemAvailable') ?? Math.round(os.freemem() / 1048576);
function machine() {
  const totalMB = Math.round(os.totalmem() / 1048576);
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return { totalMB, cpus, availMB: memAvailableMB(), swapMB: meminfo('SwapTotal') };
}
// MAX_PARALLEL=auto picks a value from installed RAM: <12 GB -> 1, <24 GB -> 2, <48 GB -> 3, else 4.
function maxParallel(c = cfg()) {
  const v = (c.MAX_PARALLEL || 'auto').trim();
  if (v !== 'auto') return Math.max(1, num(v, 2));
  const gb = machine().totalMB / 1024;
  return gb < 12 ? 1 : gb < 24 ? 2 : gb < 48 ? 3 : 4;
}

// ---------- state ----------
function readState() {
  return readJson(P.state, { state: 'new', milestone: 'M0', note: 'Not started', updated: '' });
}
function writeState(patch) {
  const s = { ...readState(), ...patch, updated: now().toISOString() };
  writeJson(P.state, s);
  return s;
}
function readRuntime() { return readJson(P.runtime, {}); }
function isRunning() {
  const rt = readRuntime();
  if (!rt.pid) return false;
  try { process.kill(rt.pid, 0); return true; } catch { return false; }
}

// ---------- questions ----------
function listQuestions(dir = P.questions) {
  if (!exists(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^Q-\d+\.md$/.test(f)).sort().map((f) => {
    const file = path.join(dir, f);
    const text = fs.readFileSync(file, 'utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const meta = {};
    if (fm) for (const l of fm[1].split(/\r?\n/)) {
      const i = l.indexOf(':');
      if (i > 0) meta[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
    const body = fm ? text.slice(fm[0].length).trim() : text.trim();
    const title = (/^#\s+(.+)$/m.exec(body) || [null, f])[1];
    return { id: meta.id || f.replace('.md', ''), status: meta.status || 'open', blocking: meta.blocking || 'issue', from: meta.from || '?', file, text, body, title };
  });
}
const openQuestions = () => listQuestions().filter((q) => q.status === 'open');
function answerQuestion(q, answer) {
  let t = q.text.replace(/^status:\s*open.*$/m, `status: answered\nanswered: ${now().toISOString()}`);
  if (/^##\s*Answer\s*$/m.test(t)) t = t.replace(/^##\s*Answer\s*$/m, `## Answer\n\n${answer}\n`);
  else t = t.trimEnd() + `\n\n## Answer\n\n${answer}\n`;
  fs.writeFileSync(q.file, t);
}
function createQuestion({ title, context, options = [], recommendation = '', blocking = 'all', from = 'factory' }) {
  fs.mkdirSync(P.questions, { recursive: true });
  const ids = listQuestions().map((q) => Number((/(\d+)/.exec(q.id) || [0, 0])[1]));
  const id = 'Q-' + String((ids.length ? Math.max(...ids) : 0) + 1).padStart(4, '0');
  const md = [
    '---', `id: ${id}`, 'status: open', `blocking: ${blocking}`, `from: ${from}`, `created: ${now().toISOString()}`, '---',
    `# ${title}`, '', '## Context', '', context, '',
    '## Options', '', ...(options.length ? options.map((o) => `- ${o}`) : ['- (free text)']), '',
    '## Recommendation', '', recommendation || '(none)', '', '## Answer', '',
  ].join('\n');
  fs.writeFileSync(path.join(P.questions, id + '.md'), md);
  return id;
}
async function answerInteractively() {
  const qs = openQuestions();
  let answered = 0;
  for (const q of qs) {
    say('\n' + '-'.repeat(64));
    say(`${q.id}  [blocking: ${q.blocking}]  from: ${q.from}`);
    const lines = q.body.split('\n');
    say(lines.slice(0, 60).join('\n'));
    if (lines.length > 60) say(`... (full text: ${path.relative(ROOT, q.file)})`);
    const a = await ask('\nYour answer (press Enter to skip): ');
    if (a) { answerQuestion(q, a); answered++; say(`Saved the answer to ${q.id}.`); }
  }
  return answered;
}

// ---------- generate .claude/agents from factory/agents + models in config.env ----------
// Source (committed): factory/agents/*.md. Generated (not committed): .claude/agents/*.md.
function syncModels() {
  const c = cfg();
  if (!exists(P.agentSrc)) return [];
  fs.mkdirSync(P.agents, { recursive: true });
  const changed = [];
  for (const f of fs.readdirSync(P.agentSrc).filter((x) => x.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(P.agentSrc, f), 'utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!fm) continue;
    const name = (/^name:\s*(.+)$/m.exec(fm[1]) || [null, f.replace('.md', '')])[1].trim();
    const want = c['MODEL_' + name.toUpperCase().replace(/-/g, '_')] || 'sonnet';
    let head = fm[1];
    if (/^model:\s*.*$/m.test(head)) head = head.replace(/^model:\s*.*$/m, `model: ${want}`);
    else head += `\nmodel: ${want}`;
    const out = text.replace(fm[1], head);
    const dest = path.join(P.agents, f);
    if (readText(dest, null) !== out) {
      fs.writeFileSync(dest, out);
      changed.push(`${name}=${want}`);
    }
  }
  return changed;
}

// ---------- preflight ----------
async function preflight() {
  const tty = process.stdin.isTTY && process.stdout.isTTY;
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) { say(`Node.js >= 20 is required (found ${process.versions.node}).`); return false; }

  if (!exists(P.intake)) {
    fs.copyFileSync(P.intakeExample, P.intake);
    say('Created factory/INTAKE.env from the example file.');
  }
  let it = intake();
  const missing = REQUIRED.filter((k) => !it[k]);
  if (missing.length) {
    if (!tty) {
      say('The intake form factory/INTAKE.env is incomplete. Missing: ' + missing.join(', '));
      say('Fill it in, then run the command again.');
      return false;
    }
    say('Some required fields are missing. Enter them here (or press Ctrl+C and edit factory/INTAKE.env):');
    for (const k of missing) {
      const v = await ask(`  ${k} = `);
      if (!v) { say(`${k} is still empty. Stopping.`); return false; }
      setEnvValue(P.intake, k, v);
    }
    it = intake();
  }

  const c = cfg();
  const problems = [];
  const warns = [];
  if (!sh('git', ['--version']).ok) problems.push('git is not installed.');
  const cv = sh(claudeBin(), ['--version']);
  if (!cv.ok) problems.push('Cannot run Claude Code (the `claude` command). Install it and sign in first.');
  else if (!process.env.FACTORY_CLAUDE_BIN) {
    const au = sh(claudeBin(), ['auth', 'status']);
    if (!au.ok) problems.push('Claude Code is not signed in. Run `claude` once and sign in with your plan.');
  }
  if ((c.GITHUB_MODE || 'full') === 'full') {
    const gh = sh('gh', ['auth', 'status']);
    if (gh.missing) problems.push('GitHub CLI (`gh`) is not installed. Install it and run `gh auth login`, or set GITHUB_MODE=local in factory/config.env.');
    else if (!gh.ok) problems.push('GitHub CLI is not signed in. Run `gh auth login`.');
  }
  if (!sh('docker', ['--version']).ok) warns.push('docker was not found. Agents cannot run the demo environment until docker is available.');
  if (problems.length) { say('Cannot start:'); problems.forEach((p) => say('  x ' + p)); return false; }
  warns.forEach((w) => say('  ! ' + w));

  // git repository
  if (!sh('git', ['rev-parse', '--is-inside-work-tree']).ok) {
    sh('git', ['init', '-b', 'main']);
    say('Initialized a git repository (branch main).');
  }
  if (!sh('git', ['config', 'user.name']).out) sh('git', ['config', 'user.name', it.GIT_USER_NAME]);
  if (!sh('git', ['config', 'user.email']).out) sh('git', ['config', 'user.email', it.GIT_USER_EMAIL]);
  if (!sh('git', ['rev-parse', '--verify', 'HEAD']).ok) {
    sh('git', ['add', '-A']);
    const cm = sh('git', ['commit', '-m', 'chore: add factory kit and product spec']);
    say(cm.ok ? 'Created the initial commit (factory kit and spec).' : '  ! Could not create the initial commit: ' + (cm.err || cm.out));
  }
  const tracked = sh('git', ['ls-files', '--error-unmatch', 'factory/INTAKE.env']);
  if (tracked.ok) { say('  x factory/INTAKE.env is tracked by git. Remove it (git rm --cached factory/INTAKE.env) and run again.'); return false; }

  const ch = syncModels();
  if (ch.length) say('Agent models applied: ' + ch.join(', '));
  return true;
}

// ---------- main loop ----------
let child = null;
let stopping = false;
let lastOutput = '';
const LIMIT_RE = /(usage limit|rate limit|limit reached|credit balance is too low|overloaded)/i;

async function sleepWatch(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (stopping || exists(P.stop)) return false;
    await sleep(Math.min(2000, Math.max(50, end - Date.now())));
  }
  return true;
}

function runClaude(cycle, parallel) {
  const c = cfg();
  const mc = machine();
  const prompt = [
    'You are the lead orchestrator of the My Wife factory.',
    'Read factory/prompts/lead.md and carry out exactly ONE cycle as described there, then finish.',
    `Cycle number: ${cycle}. Current time: ${now().toISOString()}.`,
    `Machine: ${(mc.totalMB / 1024).toFixed(1)} GB RAM, ${mc.cpus} logical CPUs, ${mc.availMB} MB available now. Follow the resource budget in CLAUDE.md.`,
    `MAX_PARALLEL=${parallel}. HANDOFF_AT=${c.HANDOFF_AT || 'M1,M4'}. GITHUB_MODE=${c.GITHUB_MODE || 'full'}. AUTO_MERGE=${c.AUTO_MERGE || 'yes'}. OWNER_LANGUAGE=${c.OWNER_LANGUAGE || 'vi'}.`,
  ].join('\n');
  const args = ['-p', prompt, '--model', c.MODEL_LEAD || 'sonnet', '--permission-mode', c.PERMISSION_MODE || 'auto'];
  if ((c.PERMISSION_PROMPTS || 'none') === 'none') args.push('--permission-prompts', 'none');
  if (c.FALLBACK_MODEL) args.push('--fallback-model', c.FALLBACK_MODEL);
  if (c.MAX_TURNS) args.push('--max-turns', String(c.MAX_TURNS));
  if (c.CLAUDE_EXTRA_ARGS) args.push(...c.CLAUDE_EXTRA_ARGS.split(/\s+/).filter(Boolean));
  lastOutput = '';
  return new Promise((resolve) => {
    child = spawn(claudeBin(), args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const pipe = (stream, tag) => {
      let buf = '';
      stream.on('data', (d) => {
        buf += d.toString();
        const parts = buf.split('\n');
        buf = parts.pop();
        for (const l of parts) if (l.trim()) { log(l, tag); lastOutput = (lastOutput + '\n' + l).slice(-4000); }
      });
      stream.on('end', () => { if (buf.trim()) log(buf, tag); });
    };
    pipe(child.stdout, 'claude');
    pipe(child.stderr, 'claude!');
    let settled = false;
    const finish = (code) => { if (settled) return; settled = true; child = null; resolve(code); };
    child.on('error', (e) => { log('Could not start Claude Code: ' + e.message); finish(127); });
    // Use 'exit' instead of 'close': grandchildren of Claude Code may keep the pipes open after it exits.
    child.on('exit', (code, signal) => {
      const c2 = child;
      setTimeout(() => { try { c2 && c2.stdout.destroy(); c2 && c2.stderr.destroy(); } catch {} }, 500).unref();
      finish(code == null ? (signal ? 143 : 1) : code);
    });
  });
}

function gitHead() { return sh('git', ['rev-parse', 'HEAD']).out; }
function fingerprint() {
  const qs = listQuestions().map((q) => q.id + q.status).join(',');
  return [readState().updated, gitHead(), qs, readText(P.backlog).length].join('|');
}

async function loop() {
  const fg = process.env.FACTORY_FG === '1';
  const c0 = cfg();
  const cooldown = num(process.env.FACTORY_COOLDOWN_MS, num(c0.COOLDOWN_SECONDS, 20) * 1000);
  const poll = num(process.env.FACTORY_POLL_MS, num(c0.POLL_SECONDS, 30) * 1000);
  const maxStalled = num(c0.MAX_STALLED, 3);
  const backoff = (c0.BACKOFF_MINUTES || '5,15,30,60').split(',').map((x) => num(x.trim(), 15));
  const backoffUnit = num(process.env.FACTORY_BACKOFF_UNIT_MS, 60000);
  const killWait = num(process.env.FACTORY_KILL_WAIT_MS, 30000);
  const minFree = num(process.env.FACTORY_MIN_FREE_MEM_MB, num(c0.MIN_FREE_MEM_MB, 2500));
  const memWaitMax = num(process.env.FACTORY_MEM_WAIT_MS, 600000);

  writeJson(P.runtime, { ...readRuntime(), pid: process.pid, startedAt: now().toISOString(), fg });
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    log('Stop signal received.');
    if (child) {
      try { child.kill('SIGINT'); } catch {}
      setTimeout(() => { if (child) { try { child.kill('SIGTERM'); } catch {} } }, killWait).unref();
      setTimeout(() => { if (child) { try { child.kill('SIGKILL'); } catch {} } }, killWait + 15000).unref();
    }
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  log('Factory started.');
  if (readState().state === 'new') writeState({ state: 'working', milestone: 'M0', note: 'Starting M0' });
  let cycle = num(readRuntime().cycle, 0);
  let stalled = 0;
  let failures = 0;
  let waitingLogged = false;

  while (true) {
    if (stopping || exists(P.stop)) { log('Stopping as requested.'); break; }
    const st = readState();
    if (st.state === 'done') { log('All milestones are done. The factory is stopping.'); break; }

    if (st.state === 'waiting_user' || st.state === 'milestone_review') {
      if (openQuestions().length > 0) {
        if (fg && process.stdin.isTTY) {
          say('\nThe factory is waiting for your answers:');
          const n = await answerInteractively();
          if (n === 0) { if (!(await sleepWatch(poll))) continue; }
        } else {
          if (!waitingLogged) { log(`Waiting for you to answer ${openQuestions().length} question(s) (use scripts/run.sh status).`); waitingLogged = true; }
          await sleepWatch(poll);
        }
        continue;
      }
      waitingLogged = false;
      writeState({ state: 'working', note: 'Answers received, resuming.' });
      log('Answers received, resuming.');
    }

    const ch = syncModels();
    if (ch.length) log('Agent models applied: ' + ch.join(', '));
    let parallel = maxParallel();
    if (memAvailableMB() < minFree) {
      log(`Only ${memAvailableMB()} MB of memory available (minimum ${minFree}). Waiting for memory to free up.`);
      let waited = 0;
      while (memAvailableMB() < minFree && waited < memWaitMax) {
        if (!(await sleepWatch(poll))) break;
        waited += poll;
      }
      if (stopping || exists(P.stop)) continue;
      if (memAvailableMB() < minFree) { parallel = 1; log('Memory is still low. Continuing with one issue at a time.'); }
    }
    cycle += 1;
    writeJson(P.runtime, { ...readRuntime(), cycle });
    const before = fingerprint();
    log(`-- Cycle ${cycle} started (milestone ${readState().milestone}).`);
    const t0 = Date.now();
    const code = await runClaude(cycle, parallel);
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    log(`-- Cycle ${cycle} finished after ${mins} min, exit code ${code}.`);
    if (stopping || exists(P.stop)) continue;

    const limited = fingerprint() === before && LIMIT_RE.test(lastOutput);
    if (code !== 0 || limited) {
      failures += 1;
      const wait = backoff[Math.min(failures, backoff.length) - 1];
      log(limited
        ? `The usage limit seems to be reached. Waiting ${wait} min before retrying.`
        : `Claude Code exited with an error (usage limit or network are the usual causes). Waiting ${wait} min before retrying. Consecutive failures: ${failures}.`);
      writeJson(P.runtime, { ...readRuntime(), lastError: now().toISOString(), failures });
      await sleepWatch(wait * backoffUnit);
      continue;
    }
    failures = 0;
    writeJson(P.runtime, { ...readRuntime(), failures: 0 });

    if (fingerprint() === before) {
      stalled += 1;
      log(`Cycle ${cycle} produced no change (${stalled}/${maxStalled}).`);
    } else stalled = 0;
    if (stalled >= maxStalled) {
      const id = createQuestion({
        title: 'The factory is stalled: several cycles in a row made no progress',
        context: `${maxStalled} consecutive cycles produced no commit, no state change and no new question. Run scripts/run.sh log to see what the agents are stuck on.`,
        options: ['continue: try again', 'Or write a specific instruction for the agents'],
        recommendation: 'Read the last 100 lines of the log before deciding.',
      });
      writeState({ state: 'waiting_user', note: `Stalled, needs your attention (${id}).` });
      log(`Created question ${id} and paused until you answer.`);
      stalled = 0;
      continue;
    }
    await sleepWatch(cooldown);
  }

  const rt = readRuntime();
  delete rt.pid;
  writeJson(P.runtime, { ...rt, stoppedAt: now().toISOString() });
  if (exists(P.stop)) fs.rmSync(P.stop);
  log('Factory stopped.');
}

// ---------- self-test (scripts/run.sh test) ----------
// Runs every check that can be made before real work starts, including short
// real calls to Claude Code. `run` refuses to start until this passes 100%.
const MIN_CLAUDE = [2, 1, 259];
const COMMIT_RE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9-]+\))?!?: .{1,72}$/;

function distinctModels(c = cfg()) {
  const set = new Set();
  for (const [k, v] of Object.entries(c)) if (k.startsWith('MODEL_') && v) set.add(v);
  if (!set.size) set.add('sonnet');
  return [...set].sort();
}
function selftestFingerprint() {
  const c = cfg();
  const v = sh(claudeBin(), ['--version']).out;
  const raw = [v, c.PERMISSION_MODE || 'auto', c.GITHUB_MODE || 'full', distinctModels(c).join(',')].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}
function versionAtLeast(text, min) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text || '');
  if (!m) return null;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) { if (v[i] > min[i]) return true; if (v[i] < min[i]) return false; }
  return true;
}
function claudeOnce(prompt, { model, mode, timeoutMs = 300000, maxTurns } = {}) {
  const c = cfg();
  const args = ['-p', prompt, '--model', model || c.MODEL_LEAD || 'sonnet', '--permission-mode', mode || c.PERMISSION_MODE || 'auto'];
  if ((c.PERMISSION_PROMPTS || 'none') === 'none') args.push('--permission-prompts', 'none');
  if (maxTurns) args.push('--max-turns', String(maxTurns));
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const ch = spawn(claudeBin(), args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (code, timedOut = false) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out, timedOut }); };
    const timer = setTimeout(() => { try { ch.kill('SIGTERM'); } catch {} finish(124, true); }, timeoutMs);
    ch.stdout.on('data', (d) => { out += d.toString(); });
    ch.stderr.on('data', (d) => { out += d.toString(); });
    ch.on('error', (e) => { out += String(e.message); finish(127); });
    ch.on('exit', (code, signal) => {
      setTimeout(() => { try { ch.stdout.destroy(); ch.stderr.destroy(); } catch {} finish(code == null ? (signal ? 143 : 1) : code); }, 300);
    });
  });
}
const tail = (t, n = 300) => (t || '').trim().replace(/\s+/g, ' ').slice(-n);

async function cmdTest(args) {
  const quick = args.includes('--quick');
  const tty = process.stdin.isTTY && process.stdout.isTTY;
  const c = cfg();
  const results = [];
  const add = (id, title, status, detail = '', fix = '') => {
    results.push({ id, title, status, detail, fix });
    say(`[${status}] ${id} ${title}${detail ? ' — ' + detail : ''}`);
  };
  const failed = () => results.filter((r) => r.status === 'FAIL');

  say('MY WIFE FACTORY SELF-TEST');
  say('Part A: this machine (no usage consumed)\n');

  // A1 Node
  const major = Number(process.versions.node.split('.')[0]);
  add('A1', 'Node.js 20 or later', major >= 20 ? 'PASS' : 'FAIL', `found ${process.versions.node}`, 'Install Node.js 20 or later (for example with nvm: `nvm install 22`).');

  // A2 git
  const git = sh('git', ['--version']);
  add('A2', 'git is installed', git.ok ? 'PASS' : 'FAIL', git.out, 'Install git with your package manager (for example `sudo apt install git`).');

  // A3 intake form
  if (!exists(P.intake)) fs.copyFileSync(P.intakeExample, P.intake);
  let it = intake();
  let missing = REQUIRED.filter((k) => !it[k]);
  if (missing.length && tty) {
    say('     Required intake fields are missing. Enter them now (or press Enter to skip):');
    for (const k of missing) { const v = await ask(`     ${k} = `); if (v) setEnvValue(P.intake, k, v); }
    it = intake();
    missing = REQUIRED.filter((k) => !it[k]);
  }
  add('A3', 'Intake form has every required field', missing.length ? 'FAIL' : 'PASS', missing.length ? 'missing: ' + missing.join(', ') : '', 'Open factory/INTAKE.env and fill in the fields tagged [REQUIRED].');

  // A4 git repository and secrets
  if (git.ok) {
    if (!sh('git', ['rev-parse', '--is-inside-work-tree']).ok) sh('git', ['init', '-b', 'main']);
    if (it.GIT_USER_NAME && !sh('git', ['config', 'user.name']).out) sh('git', ['config', 'user.name', it.GIT_USER_NAME]);
    if (it.GIT_USER_EMAIL && !sh('git', ['config', 'user.email']).out) sh('git', ['config', 'user.email', it.GIT_USER_EMAIL]);
    if (!sh('git', ['rev-parse', '--verify', 'HEAD']).ok && !missing.length) {
      sh('git', ['add', '-A']);
      sh('git', ['commit', '-m', 'chore: add factory kit and product spec']);
    }
    const hasHead = sh('git', ['rev-parse', '--verify', 'HEAD']).ok;
    add('A4', 'Git repository with an initial commit', hasHead ? 'PASS' : 'FAIL', hasHead ? sh('git', ['log', '-1', '--format=%s']).out : '', 'Fill in GIT_USER_NAME and GIT_USER_EMAIL in the intake form, then run the test again; the first commit is created for you.');
    const tracked = sh('git', ['ls-files', '--error-unmatch', 'factory/INTAKE.env']).ok;
    add('A5', 'Secrets file is not tracked by git', tracked ? 'FAIL' : 'PASS', '', 'Run `git rm --cached factory/INTAKE.env` and commit. Rotate any secret that was already pushed.');
  }

  // A6 agent definitions
  const agentProblems = [];
  const agentFiles = exists(P.agentSrc) ? fs.readdirSync(P.agentSrc).filter((f) => f.endsWith('.md')) : [];
  for (const f of agentFiles) {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readText(path.join(P.agentSrc, f)));
    if (!fm) { agentProblems.push(`${f}: no frontmatter`); continue; }
    if (!/^name:\s*\S+/m.test(fm[1])) agentProblems.push(`${f}: no name`);
    const d = /^description:\s*(.+)$/m.exec(fm[1]);
    if (!d) agentProblems.push(`${f}: no description`);
    else if (/: /.test(d[1]) && !/^["']/.test(d[1])) agentProblems.push(`${f}: description contains ": " and must be quoted`);
  }
  for (const f of ['lead.md', 'milestones.md']) if (!exists(path.join(FDIR, 'prompts', f))) agentProblems.push(`missing factory/prompts/${f}`);
  if (!agentFiles.length) agentProblems.push('no files in factory/agents');
  add('A6', `Agent definitions and prompts are valid (${agentFiles.length} agents)`, agentProblems.length ? 'FAIL' : 'PASS', agentProblems.join('; '), 'Restore the files from the kit, or fix the frontmatter of the file named in the detail.');
  syncModels();

  // A7 Claude Code installed, recent enough, signed in
  const cv = sh(claudeBin(), ['--version']);
  const stub = !!process.env.FACTORY_CLAUDE_BIN;
  const recent = cv.ok ? versionAtLeast(cv.out, MIN_CLAUDE) : false;
  add('A7', `Claude Code is installed, version ${MIN_CLAUDE.join('.')} or later`, cv.ok && (recent || (stub && recent === null)) ? 'PASS' : 'FAIL', cv.ok ? cv.out : 'the `claude` command was not found', 'Install or update Claude Code (`claude update`), then open a new terminal.');
  let signedIn = stub;
  if (cv.ok && !stub) {
    const au = sh(claudeBin(), ['auth', 'status']);
    let j = null; try { j = JSON.parse(au.out); } catch {}
    signedIn = j ? j.loggedIn === true : au.ok;
    add('A8', 'Claude Code is signed in', signedIn ? 'PASS' : 'FAIL', j && j.authMethod ? `auth method: ${j.authMethod}` : '', 'Run `claude` once in a terminal and sign in with your Claude plan.');
  }

  // A9 GitHub
  if ((c.GITHUB_MODE || 'full') === 'full') {
    const gh = sh('gh', ['auth', 'status']);
    const ghText = gh.out + '\n' + gh.err;
    if (gh.missing) add('A9', 'GitHub CLI is installed and signed in', 'FAIL', '`gh` was not found', 'Install GitHub CLI (https://cli.github.com), run `gh auth login`, or set GITHUB_MODE=local in factory/config.env.');
    else if (!gh.ok) add('A9', 'GitHub CLI is installed and signed in', 'FAIL', tail(ghText, 160), 'Run `gh auth login` and choose HTTPS with a browser login.');
    else {
      add('A9', 'GitHub CLI is installed and signed in', 'PASS');
      const sc = /Token scopes:\s*(.+)$/m.exec(ghText);
      if (sc) {
        const need = ['repo', 'workflow'].filter((x) => !sc[1].includes(x));
        add('A10', 'GitHub token can push code and workflows', need.length ? 'FAIL' : 'PASS', need.length ? 'missing scope: ' + need.join(', ') : '', 'Run `gh auth refresh -s repo,workflow` so agents can push branches and CI workflow files.');
      } else add('A10', 'GitHub token can push code and workflows', 'WARN', 'could not read the token scopes; make sure the token may write contents, pull requests and workflows');
      if (it.GITHUB_OWNER && it.GITHUB_REPO) {
        const rv = sh('gh', ['repo', 'view', `${it.GITHUB_OWNER}/${it.GITHUB_REPO}`, '--json', 'name']);
        if (rv.ok) add('A11', 'GitHub repository is reachable', 'PASS', `${it.GITHUB_OWNER}/${it.GITHUB_REPO}`);
        else if ((it.GITHUB_CREATE_REPO || 'yes') === 'yes') add('A11', 'GitHub repository is reachable', 'PASS', 'does not exist yet; agents will create it during M0');
        else add('A11', 'GitHub repository is reachable', 'FAIL', `${it.GITHUB_OWNER}/${it.GITHUB_REPO} not found`, 'Create the repository and add it as the `origin` remote, or set GITHUB_CREATE_REPO=yes in the intake form.');
      }
    }
  }

  // A12 Docker
  const di = sh('docker', ['info']);
  const dc = sh('docker', ['compose', 'version']);
  add('A12', 'Docker daemon and Compose are available', di.ok && dc.ok ? 'PASS' : 'FAIL', !di.ok ? tail(di.err || 'docker not found or daemon not running', 160) : !dc.ok ? 'docker compose plugin not found' : dc.out,
    'Install Docker Engine with the Compose plugin, start it, and add your user to the docker group (`sudo usermod -aG docker $USER`, then sign in again).');

  // A13 resources
  const mc = machine();
  const gb = (mc.totalMB / 1024).toFixed(1);
  add('A13', 'Memory is sufficient (8 GB minimum)', mc.totalMB >= 7500 ? 'PASS' : 'FAIL', `${gb} GB RAM, ${mc.availMB} MB available, ${mc.cpus} CPUs -> up to ${maxParallel()} issue(s) in parallel`, 'The factory needs at least 8 GB of RAM. Close other programs or use a bigger machine.');
  if (mc.swapMB === 0 && mc.totalMB < 24000) add('A14', 'Swap space is configured', 'WARN', 'no swap; a memory spike can kill processes. Recommended: add an 8 GB swap file');
  const df = sh('df', ['-Pk', ROOT]);
  const freeGB = df.ok ? Number((df.out.split('\n').pop() || '').split(/\s+/)[3]) / 1048576 : null;
  if (freeGB != null) add('A15', 'Free disk space (15 GB minimum)', freeGB >= 15 ? 'PASS' : 'FAIL', `${freeGB.toFixed(0)} GB free`, 'Free up disk space; Docker images, node_modules and worktrees need room.');
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (isRoot) add('A16', 'Not running as root', (c.PERMISSION_MODE === 'bypassPermissions') ? 'FAIL' : 'WARN', 'running as root', 'Create a normal user and run the factory as that user. Claude Code refuses bypassPermissions as root.');

  // Part B: real Claude Code
  const claudeUsable = cv.ok && signedIn && !failed().some((r) => ['A1', 'A2', 'A4', 'A6', 'A7', 'A8'].includes(r.id));
  let claudeWorks = false;
  if (!claudeUsable) {
    say('\nPart B skipped: fix the failed checks above first, then run the test again.');
  } else {
    say('\nPart B: real Claude Code (uses a small amount of your plan)\n');
    fs.rmSync(P.selftestDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(P.selftestDir, 'questions'), { recursive: true });

    // B1 each configured model answers in unattended mode
    let b1ok = true;
    for (const m of distinctModels(c)) {
      const r = await claudeOnce('Reply with exactly the single word FACTORY_OK and nothing else.', { model: m, timeoutMs: 180000, maxTurns: 3 });
      const ok = r.code === 0 && /FACTORY_OK/.test(r.out);
      if (!ok) b1ok = false;
      add('B1', `Model "${m}" answers in unattended mode`, ok ? 'PASS' : 'FAIL', ok ? '' : (r.timedOut ? 'timed out; ' : `exit code ${r.code}; `) + tail(r.out),
        `Check that your plan includes the model "${m}" and that the usage limit is not exhausted, or change the MODEL_ lines in factory/config.env. If the error mentions the permission mode, set PERMISSION_MODE in factory/config.env to a mode your Claude Code supports.`);
    }
    claudeWorks = b1ok;

    if (b1ok && !quick) {
      // B2 file edit + shell command without prompts
      const r2 = await claudeOnce('Create the file factory/.selftest/hello.txt containing exactly the text selftest-ok (use your file tool). Then run the shell command `node -e "console.log(40+2)"` and reply with the number it printed.', { timeoutMs: 300000 });
      const fileOk = readText(path.join(P.selftestDir, 'hello.txt')).trim() === 'selftest-ok';
      const ok2 = r2.code === 0 && fileOk && /\b42\b/.test(r2.out);
      add('B2', 'Agents can edit files and run commands unattended', ok2 ? 'PASS' : 'FAIL', ok2 ? '' : `${fileOk ? 'file written' : 'file not written'}; exit code ${r2.code}; ` + tail(r2.out),
        'The permission mode blocks unattended work. Keep PERMISSION_MODE=auto if your plan supports auto mode; otherwise run inside a container and set PERMISSION_MODE=bypassPermissions.');

      // B3 subagents load and run in parallel
      const r3 = await claudeOnce('Use the Agent tool to call the subagent named `po` and the subagent named `scribe` in the same turn, each with exactly this task: "Reply with exactly the word PONG." Then reply with one line in this exact format: PO=<answer of po> SCRIBE=<answer of scribe>', { timeoutMs: 600000 });
      const ok3 = r3.code === 0 && /PO\s*=\s*"?PONG/i.test(r3.out) && /SCRIBE\s*=\s*"?PONG/i.test(r3.out);
      add('B3', 'Subagents from factory/agents load and answer', ok3 ? 'PASS' : 'FAIL', ok3 ? '' : `exit code ${r3.code}; ` + tail(r3.out),
        'Check that .claude/agents/ was generated (it is created from factory/agents/ by this script) and that every agent file has valid frontmatter.');

      // B4 a builder works in its own worktree and commits by convention
      const branch = 'selftest/worktree-probe';
      const cleanup = () => {
        const wl = sh('git', ['worktree', 'list', '--porcelain']).out.split('\n\n');
        for (const block of wl) if (block.includes('refs/heads/' + branch)) {
          const wp = (/^worktree (.+)$/m.exec(block) || [])[1];
          if (wp && path.resolve(wp) !== ROOT) sh('git', ['worktree', 'remove', '--force', wp]);
        }
        sh('git', ['worktree', 'prune']);
        sh('git', ['branch', '-D', branch]);
      };
      cleanup();
      const headBefore = sh('git', ['rev-parse', 'HEAD']).out;
      const branchBefore = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out;
      const r4 = await claudeOnce(`Use the Agent tool to call the subagent named \`builder-service\` with exactly this task: "Create a file named selftest-probe.txt in the repository root containing the single word probe. Commit it on a new branch named ${branch} with the commit message 'test(factory): add worktree probe'. Do not push and do not open a pull request. Report the branch name." When the subagent has finished, reply with the single word DONE.`, { timeoutMs: 600000 });
      const hasBranch = sh('git', ['rev-parse', '--verify', 'refs/heads/' + branch]).ok;
      const subject = hasBranch ? sh('git', ['log', '-1', '--format=%s', branch]).out : '';
      const isolated = sh('git', ['rev-parse', 'HEAD']).out === headBefore && sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out === branchBefore && !exists(path.join(ROOT, 'selftest-probe.txt'));
      const conventional = COMMIT_RE.test(subject);
      const ok4 = hasBranch && isolated && conventional;
      add('B4', 'A builder works in an isolated worktree and commits by convention', ok4 ? 'PASS' : 'FAIL',
        ok4 ? `commit: ${subject}` : `${hasBranch ? '' : 'branch not created; '}${isolated ? '' : 'the main checkout was changed; '}${hasBranch && !conventional ? `commit message "${subject}" is not a Conventional Commit; ` : ''}exit code ${r4.code}; ` + tail(r4.out, 200),
        'Make sure the repository has at least one commit and that `isolation: worktree` is present in factory/agents/builder-*.md. If the commit message is wrong, strengthen the Git conventions section of CLAUDE.md.');
      cleanup();
      if (exists(path.join(ROOT, 'selftest-probe.txt'))) fs.rmSync(path.join(ROOT, 'selftest-probe.txt'));

      // B5 the lead follows the question and state file protocol
      const r5 = await claudeOnce(`Rehearsal of the factory protocol. Read sections 6 and 8 of factory/prompts/lead.md. Then, writing ONLY inside the directory factory/.selftest/: (1) create factory/.selftest/questions/Q-9001.md following the question template exactly, with id Q-9001, blocking: issue, from: po, and any one-line test question written in the language "${c.OWNER_LANGUAGE || 'vi'}"; (2) create factory/.selftest/state.json in the exact shape from section 8 with state "working" and milestone "M0". Do not touch any other file. Reply with the single word DONE.`, { timeoutMs: 600000 });
      const q = listQuestions(path.join(P.selftestDir, 'questions')).find((x) => x.id === 'Q-9001');
      const stj = readJson(path.join(P.selftestDir, 'state.json'), null);
      const qOk = !!q && q.status === 'open' && q.blocking === 'issue' && /^##\s*Answer\s*$/m.test(q.text) && /^##\s*Options\s*$/m.test(q.text);
      const sOk = !!stj && stj.state === 'working' && stj.milestone === 'M0' && typeof stj.note === 'string' && !!stj.updated;
      add('B5', 'The lead writes question and state files in the expected format', qOk && sOk ? 'PASS' : 'FAIL', qOk && sOk ? '' : `${qOk ? '' : 'question file missing or malformed; '}${sOk ? '' : 'state.json missing or malformed; '}exit code ${r5.code}; ` + tail(r5.out, 200),
        'The lead did not follow factory/prompts/lead.md. Try a stronger model for MODEL_LEAD in factory/config.env, or make sections 6 and 8 of lead.md more explicit.');
    }
    fs.rmSync(P.selftestDir, { recursive: true, force: true });
  }

  // summary
  const fails = failed();
  const warns = results.filter((r) => r.status === 'WARN');
  const required = results.filter((r) => r.status !== 'WARN');
  const partial = quick || !claudeUsable;
  const passed = fails.length === 0 && !partial;
  say('\n' + '='.repeat(64));
  say(`RESULT: ${required.length - fails.length}/${required.length} required checks passed${warns.length ? `, ${warns.length} warning(s)` : ''}.`);

  let guidance = '';
  if (fails.length) {
    say('\nHOW TO FIX');
    fails.forEach((r) => say(`  ${r.id} ${r.title}\n     -> ${r.fix}`));
    if (claudeWorks) {
      say('\nAsking an agent for step-by-step guidance for this machine...');
      const gp = `You are helping the project owner get the My Wife factory ready on this machine. The self-test below has failed checks. For each failed check, explain in the language "${c.OWNER_LANGUAGE || 'vi'}" how to fix it on this machine, step by step, with the exact commands to run. You may inspect the machine with read-only commands, but do not change anything. Be concise; no introduction.\n\nFailed checks (JSON):\n${JSON.stringify(fails, null, 2)}`;
      const rg = await claudeOnce(gp, { mode: 'dontAsk', timeoutMs: 300000 });
      if (rg.code === 0 && rg.out.trim()) { guidance = rg.out.trim(); say('\n' + guidance); }
    }
  }

  const report = ['# Factory self-test report', '', `Run at: ${now().toISOString()}`, `Result: ${passed ? 'PASSED' : partial && !fails.length ? 'INCOMPLETE' : 'FAILED'}`, '',
    '| Check | Status | Title | Detail |', '| --- | --- | --- | --- |',
    ...results.map((r) => `| ${r.id} | ${r.status} | ${r.title} | ${(r.detail || '').replace(/\|/g, '/')} |`), '',
    ...(fails.length ? ['## How to fix', '', ...fails.map((r) => `- **${r.id} ${r.title}:** ${r.fix}`), ''] : []),
    ...(guidance ? ['## Guidance from the agent', '', guidance, ''] : [])].join('\n');
  fs.writeFileSync(P.selftestReport, report);
  writeJson(P.selftestMarker, { passed, at: now().toISOString(), fingerprint: selftestFingerprint(), failed: fails.map((r) => r.id), warnings: warns.map((r) => r.id) });

  say('');
  if (passed) say('All required checks passed (100%). Start the real work with:  scripts/run.sh run');
  else if (!fails.length && partial) say(quick ? 'Quick test passed. Run the full test before starting:  scripts/run.sh test' : 'Part B did not run. Run the test again.');
  else say('Fix the items above, then run again:  scripts/run.sh test');
  say('Report saved to factory/selftest-report.md');
  if (!passed) process.exitCode = 1;
}

// ---------- commands ----------
async function cmdRun(args) {
  const fg = args.includes('--fg');
  if (isRunning()) { say(`The factory is already running (pid ${readRuntime().pid}). Use scripts/run.sh status or scripts/run.sh log.`); return; }
  if (!(await preflight())) { process.exitCode = 1; return; }
  if (!args.includes('--skip-test')) {
    const m = readJson(P.selftestMarker, null);
    if (!m || !m.passed) {
      say('The self-test has not passed yet. Run it first:  scripts/run.sh test');
      say('(To start anyway, at your own risk:  scripts/run.sh run --skip-test)');
      process.exitCode = 1; return;
    }
    if (m.fingerprint !== selftestFingerprint()) {
      say('The setup changed since the last self-test (Claude Code version, models, permission mode or GitHub mode).');
      say('Run it again:  scripts/run.sh test');
      process.exitCode = 1; return;
    }
  }
  if (exists(P.stop)) fs.rmSync(P.stop);
  fs.mkdirSync(P.logDir, { recursive: true });
  fs.mkdirSync(P.questions, { recursive: true });
  fs.mkdirSync(P.handoff, { recursive: true });
  if (fg) {
    process.env.FACTORY_FG = '1';
    say('Running in the foreground. Press Ctrl+C to stop.');
    await loop();
    return;
  }
  const out = fs.openSync(P.log, 'a');
  const p = spawn(process.execPath, [SELF, '_loop'], { cwd: ROOT, detached: true, stdio: ['ignore', out, out], env: { ...process.env, FACTORY_FG: '0' } });
  p.unref();
  say(`The factory is running in the background (pid ${p.pid}).`);
  say('  Progress:    scripts/run.sh status');
  say('  Follow log:  scripts/run.sh log -f');
  say('  Stop:        scripts/run.sh stop');
}

async function cmdStop(args) {
  const nowFlag = args.includes('--now');
  if (!isRunning()) { say('The factory is not running.'); if (exists(P.stop)) fs.rmSync(P.stop); return; }
  fs.writeFileSync(P.stop, now().toISOString() + '\n');
  const pid = readRuntime().pid;
  if (nowFlag) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    say('Immediate stop requested. Work in progress is discarded; the agents redo it on the next run.');
  } else {
    say('Stop flag set. The factory stops when the current cycle finishes.');
    say('To stop immediately: scripts/run.sh stop --now');
  }
}

function backlogSummary() {
  const b = readJson(P.backlog, null);
  const items = Array.isArray(b) ? b : b && Array.isArray(b.items) ? b.items : null;
  if (!items) return null;
  const by = {};
  for (const it of items) {
    const m = it.milestone || '?';
    by[m] = by[m] || { total: 0, done: 0, doing: 0, blocked: 0 };
    by[m].total += 1;
    if (it.status === 'done') by[m].done += 1;
    else if (it.status === 'doing' || it.status === 'review') by[m].doing += 1;
    else if (it.status === 'blocked') by[m].blocked += 1;
  }
  return { by, total: items.length, done: items.filter((x) => x.status === 'done').length };
}

async function cmdStatus(args) {
  const st = readState();
  const rt = readRuntime();
  const labels = { new: 'not started', working: 'working', waiting_user: 'waiting for your answer', milestone_review: 'waiting for your milestone review', done: 'done' };
  say('MY WIFE FACTORY');
  say(`  Process:    ${isRunning() ? `running (pid ${rt.pid})` : 'not running'}`);
  say(`  State:      ${labels[st.state] || st.state}`);
  say(`  Milestone:  ${st.milestone || '?'}`);
  say(`  Cycles run: ${rt.cycle || 0}${rt.failures ? `   (${rt.failures} consecutive failure(s), possibly the usage limit)` : ''}`);
  const mc = machine();
  say(`  Machine:    ${(mc.totalMB / 1024).toFixed(1)} GB RAM (${mc.availMB} MB available), ${mc.cpus} CPUs, up to ${maxParallel()} issue(s) in parallel`);
  const stt = readJson(P.selftestMarker, null);
  say(`  Self-test:  ${stt ? (stt.passed ? 'passed' : 'FAILED') + ' at ' + stt.at : 'not run yet (scripts/run.sh test)'}`);
  if (st.note) say(`  Note:       ${st.note}`);
  if (st.updated) say(`  Updated:    ${st.updated}`);

  const bs = backlogSummary();
  if (bs) {
    say(`\nWORK: ${bs.done}/${bs.total} issues done`);
    for (const m of Object.keys(bs.by).sort()) {
      const x = bs.by[m];
      say(`  ${m}: ${x.done}/${x.total} done, ${x.doing} in progress, ${x.blocked} blocked`);
    }
  } else say('\nWORK: no backlog yet (it is generated during milestone M0).');

  const it = intake();
  const order = ['M0', 'M1', 'M2', 'M3', 'M4'];
  const cur = Math.max(0, order.indexOf(st.milestone || 'M0'));
  const need = [];
  for (const [m, keys] of Object.entries(NEEDED_BY)) {
    if (order.indexOf(m) <= cur + 1) for (const k of keys) if (!it[k]) need.push(`${k} (needed before the ${m} acceptance test)`);
  }
  if (need.length) { say('\nINTAKE FORM, STILL MISSING (factory/INTAKE.env):'); need.forEach((n) => say('  - ' + n)); }

  const ho = exists(P.handoff) ? fs.readdirSync(P.handoff).filter((f) => f.endsWith('.md')).sort() : [];
  if (ho.length) say('\nHANDOFF: ' + ho.map((f) => 'factory/handoff/' + f).join(', '));

  const qs = openQuestions();
  if (!qs.length) { say('\nQUESTIONS: none pending.'); return; }
  say(`\nQUESTIONS PENDING: ${qs.length}`);
  qs.forEach((q) => say(`  ${q.id} [blocking: ${q.blocking}] ${q.title}`));
  if (args.includes('--no-input') || !process.stdin.isTTY) {
    say('\nTo answer: run scripts/run.sh status in a terminal, or edit the file in factory/questions/ (write under "## Answer" and change status to answered).');
    return;
  }
  const n = await answerInteractively();
  if (n > 0 && !isRunning()) say('\nSaved. The factory is not running; use scripts/run.sh run to resume.');
  else if (n > 0) say('\nSaved. The factory will resume on its own.');
}

async function cmdLog(args) {
  const follow = args.includes('-f') || args.includes('--follow');
  const ni = args.indexOf('-n');
  const n = ni >= 0 ? num(args[ni + 1], 60) : 60;
  if (!exists(P.log)) { say('No log yet.'); if (!follow) return; fs.mkdirSync(P.logDir, { recursive: true }); fs.writeFileSync(P.log, ''); }
  const lines = readText(P.log).split('\n');
  say(lines.slice(-n - 1).join('\n').trimEnd());
  if (!follow) return;
  let pos = fs.statSync(P.log).size;
  while (true) {
    await sleep(1000);
    const size = fs.statSync(P.log).size;
    if (size > pos) {
      const fd = fs.openSync(P.log, 'r');
      const buf = Buffer.alloc(size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      fs.closeSync(fd);
      process.stdout.write(buf.toString());
      pos = size;
    } else if (size < pos) pos = size;
  }
}

function help() {
  say([
    'My Wife factory. Usage: scripts/run.sh <command>',
    '  test [--quick]    self-test with the real Claude Code; must pass 100% before run',
    '  run [--fg]        start or resume (background by default; --fg to watch live)',
    '  stop [--now]      stop after the current cycle (--now: stop immediately)',
    '  status            show progress, missing intake fields, and answer questions',
    '  log [-f] [-n N]   show the log (-f: follow)',
    '',
    'Full guide: FACTORY.md',
  ].join('\n'));
}

const [cmd, ...rest] = process.argv.slice(2);
const table = { test: cmdTest, run: cmdRun, stop: cmdStop, status: cmdStatus, log: cmdLog, _loop: loop };
if (!cmd || !table[cmd]) help();
else table[cmd](rest).catch((e) => { log('Error: ' + (e && e.stack ? e.stack : e)); say('Error: ' + (e && e.message ? e.message : e)); process.exitCode = 1; });
