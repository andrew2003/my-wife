// PreToolUse: block edits to packages/contracts and to env/secret files.
// Escape hatches (set by the lead only for issues that allow it):
//   FACTORY_ALLOW_CONTRACTS=1  allows packages/contracts (an ADR is still required)
//   FACTORY_ALLOW_ENV=1        allows plain .env files (never factory/INTAKE.env)
import { readInput, relPath, block, isEnvFile } from './lib.mjs';

const input = readInput();
const tool = input.tool_name;
const ti = input.tool_input ?? {};

const allowContracts = process.env.FACTORY_ALLOW_CONTRACTS === '1';
const allowEnv = process.env.FACTORY_ALLOW_ENV === '1';

const isIntake = (rel) => /(^|\/)INTAKE\.env$/.test(rel);
const isContracts = (rel) => rel === 'packages/contracts' || rel.startsWith('packages/contracts/');

function checkPath(rel) {
  if (!rel) return;
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
  const cmd = ti.command;
  // Never stage or commit secrets.
  if (/\bgit\s+(add|commit)\b/.test(cmd) && /INTAKE\.env/.test(cmd)) {
    block('factory/INTAKE.env must never be staged or committed.');
  }
  if (/\bgit\s+add\b[^;&|]*\s(-f|--force)\b/.test(cmd)) {
    block('git add --force is not allowed; it can stage ignored secrets.');
  }
  if (/\bgit\s+add\b[^;&|]*(\s|\/)\.env(\.(?!example\b)[\w.-]+)?(\s|$)/.test(cmd)) {
    block('env files must never be staged.');
  }
  // Shell writes (redirect, tee, sed -i, rm, mv, cp, truncate) aimed at protected paths.
  const writes = /(>|>>|\btee\b|\bsed\s+-[a-z]*i|\brm\b|\bmv\b|\bcp\b|\btruncate\b|\bperl\s+-[a-z]*i)/.test(cmd);
  if (writes) {
    if (/INTAKE\.env/.test(cmd)) block('factory/INTAKE.env must not be modified by agents.');
    if (!allowContracts && /packages\/contracts(\/|\s|$|['"])/.test(cmd)) {
      block('shell write to packages/contracts needs an ADR and FACTORY_ALLOW_CONTRACTS=1.');
    }
    if (!allowEnv && /(^|[\s/'"])\.env(\.(?!example\b)[\w.-]+)?(?=$|[\s'";&|])/.test(cmd)) {
      block('shell write to an env file needs FACTORY_ALLOW_ENV=1.');
    }
  }
}
process.exit(0);
