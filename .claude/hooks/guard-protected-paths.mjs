// Best effort only: this guard catches the common edit paths (Edit, Write, MultiEdit and plain shell
// writes). It cannot stop determined bypasses such as `node -e`, `git checkout`, scripts that write
// files, or editors spawned from the shell. Review and CI remain the real gate.
// PreToolUse: block edits to packages/contracts and to env/secret files.
// Escape hatches (set by the lead only for issues that allow it):
//   FACTORY_ALLOW_CONTRACTS=1  allows packages/contracts (an ADR is still required)
//   FACTORY_ALLOW_ENV=1        allows plain .env files (never factory/INTAKE.env)
//   FACTORY_ALLOW_CI=1         allows .github/workflows/**
// The hooks and Claude settings files are never editable by agents, with no escape hatch. The
// escape variables must come from the lead's process environment, never from a settings file.
import { readInput, relPath, block, isEnvFile, stripNoise } from './lib.mjs';

const input = readInput();
const tool = input.tool_name;
const ti = input.tool_input ?? {};

const allowContracts = process.env.FACTORY_ALLOW_CONTRACTS === '1';
const allowEnv = process.env.FACTORY_ALLOW_ENV === '1';
const allowCi = process.env.FACTORY_ALLOW_CI === '1';

const isIntake = (rel) => /(^|\/)INTAKE\.env$/.test(rel);
const isContracts = (rel) => rel === 'packages/contracts' || rel.startsWith('packages/contracts/');

const isFactoryConfig = (rel) =>
  rel.startsWith('.claude/hooks/') || rel === '.claude/settings.json' || rel === '.claude/settings.local.json';
const isCi = (rel) => rel.startsWith('.github/workflows/');

function checkPath(rel) {
  if (!rel) return;
  if (isFactoryConfig(rel)) block(`${rel} is factory configuration and is not editable by agents.`);
  if (isCi(rel) && !allowCi) block(`${rel} is a CI workflow. Changes need an ADR and the lead (FACTORY_ALLOW_CI=1).`);
  if (isIntake(rel)) block(`${rel} holds secrets and is never edited or committed by agents.`);
  if (isEnvFile(rel) && !allowEnv) {
    block(`${rel} is an env file. Edit .env.example instead, or ask the lead (FACTORY_ALLOW_ENV=1).`);
  }
  if (isContracts(rel) && !allowContracts) {
    block(
      `${rel} is in packages/contracts. Changes need an ADR in docs/adr/ and the lead's approval (FACTORY_ALLOW_CONTRACTS=1).`,
    );
  }
}

if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
  checkPath(relPath(ti.file_path ?? ti.notebook_path));
} else if (tool === 'Bash' && typeof ti.command === 'string') {
  const cmd = stripNoise(ti.command);
  // Never stage or commit secrets.
  if (/\bgit\s+(add|commit)\b/.test(cmd) && /INTAKE\.env/.test(cmd)) {
    block('factory/INTAKE.env must never be staged or committed.');
  }
  if (/\bgit\s+add\b[^;&|]*\s(-f|--force)\b/.test(cmd)) {
    block('git add --force is not allowed; it can stage ignored secrets.');
  }
  if (/\bgit\s+add\b[^;&|]*(\s|\/)\.env(\.(?!(example|sample|template)\b)[\w.-]+)?(\s|$)/.test(cmd)) {
    block('env files must never be staged.');
  }
  // Shell writes (redirect, tee, sed -i, rm, mv, cp, truncate) aimed at protected paths.
  const writes = /(>|>>|\btee\b|\bsed\s+-[a-z]*i|\brm\b|\bmv\b|\bcp\b|\btruncate\b|\bperl\s+-[a-z]*i)/.test(cmd);
  if (writes) {
    if (/INTAKE\.env/.test(cmd)) block('factory/INTAKE.env must not be modified by agents.');
    if (/\.claude\/(hooks\/|settings(\.local)?\.json)/.test(cmd)) block('factory hooks and settings are not editable by agents.');
    if (!allowCi && /\.github\/workflows\//.test(cmd)) block('shell write to CI workflows needs FACTORY_ALLOW_CI=1.');
    if (!allowContracts && /packages\/contracts(\/|\s|$|['"])/.test(cmd)) {
      block('shell write to packages/contracts needs an ADR and FACTORY_ALLOW_CONTRACTS=1.');
    }
    if (!allowEnv && /(^|[\s/'"])\.env(\.(?!(example|sample|template)\b)[\w.-]+)?(?=$|[\s'";&|])/.test(cmd)) {
      block('shell write to an env file needs FACTORY_ALLOW_ENV=1.');
    }
  }
}
process.exit(0);
