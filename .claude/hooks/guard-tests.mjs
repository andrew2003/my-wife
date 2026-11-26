// PreToolUse: block deleting, skipping or weakening tests (Edit, Write, MultiEdit, Bash).
import { readInput, relPath, newTexts, readIfExists, block, isTestFile } from './lib.mjs';

const input = readInput();
const tool = input.tool_name;
const ti = input.tool_input ?? {};

const SKIP_PATTERNS = [
  /\b(it|test|describe|suite)\.(skip|only|todo|skipIf|fails)\b/,
  /\b(xit|xdescribe|xtest|fit|fdescribe)\s*\(/,
  /\b(it|test|describe)\.each\b[^\n]*\.skip\b/,
];
const TEST_CALL = /\b(it|test)(\.each\([^)]*\))?\s*\(/g;
const countTests = (s) => (s.match(TEST_CALL) ?? []).length;

// Coverage threshold keys; the new value must not be lower than the old one.
function thresholds(text) {
  const out = {};
  for (const m of text.matchAll(/\b(lines|functions|branches|statements|perFile|global)\b\s*:\s*(\d+(?:\.\d+)?)/g)) {
    out[m[1]] = Math.max(out[m[1]] ?? 0, Number(m[2]));
  }
  return out;
}
const isConfig = (rel) => /(^|\/)(vitest|vite|jest)\.(config|workspace)\.[cm]?[jt]s$/.test(rel);

function checkSkips(texts, rel) {
  for (const t of texts) {
    for (const re of SKIP_PATTERNS) {
      if (re.test(t)) block(`${rel}: skipping, focusing or stubbing tests (.skip/.only/.todo/xit/xdescribe) is not allowed.`);
    }
  }
}

if (['Edit', 'Write', 'MultiEdit'].includes(tool)) {
  const rel = relPath(ti.file_path);
  const texts = newTexts(ti);
  if (isTestFile(rel)) {
    checkSkips(texts, rel);
    if (tool === 'Write') {
      const before = countTests(readIfExists(ti.file_path));
      const after = countTests(ti.content ?? '');
      if (after < before) block(`${rel}: rewrite removes tests (${before} -> ${after}). Tests must not be deleted or weakened.`);
    } else {
      const edits = tool === 'MultiEdit' ? (ti.edits ?? []) : [ti];
      for (const e of edits) {
        const removed = countTests(e.old_string ?? '') - countTests(e.new_string ?? '');
        if (removed > 0) block(`${rel}: edit removes ${removed} test case(s). Tests must not be deleted or weakened.`);
      }
    }
  }
  if (isConfig(rel)) {
    const oldText = tool === 'Write' ? readIfExists(ti.file_path) : (ti.old_string ?? (ti.edits ?? []).map((e) => e.old_string).join('\n'));
    const before = thresholds(oldText);
    const after = thresholds(texts.join('\n'));
    for (const [k, v] of Object.entries(after)) {
      if (k in before && v < before[k]) block(`${rel}: lowering coverage threshold ${k} (${before[k]} -> ${v}) is not allowed.`);
    }
  }
} else if (tool === 'Bash' && typeof ti.command === 'string') {
  const cmd = ti.command;
  const testPath = String.raw`[^\s;&|'"]*(\.(test|spec)\.[cm]?[jt]sx?|/__tests__/|/tests?/)[^\s;&|'"]*`;
  if (new RegExp(String.raw`\b(rm|unlink|shred)\b[^;&|]*${testPath}`).test(cmd) ||
      new RegExp(String.raw`\bgit\s+(rm|mv)\b[^;&|]*${testPath}`).test(cmd)) {
    block('deleting or moving test files is not allowed.');
  }
  const touchesTests = new RegExp(testPath).test(cmd);
  const writes = /(>|>>|\btee\b|\bsed\s+-[a-z]*i|\bperl\s+-[a-z]*i)/.test(cmd);
  if (touchesTests && writes) {
    for (const re of SKIP_PATTERNS) {
      if (re.test(cmd)) block('shell edit adds .skip/.only/.todo/xit/xdescribe to a test file.');
    }
    if (/\bsed\s+-[a-z]*i[^;&|]*\/d\b/.test(cmd)) block('sed deletion in a test file is not allowed.');
  }
  if (/\b(vitest|jest)\b/.test(cmd) && /--passWithNoTests/.test(cmd)) {
    block('--passWithNoTests can hide deleted tests.');
  }
  if (/(--coverage\.thresholds?\.\w+[= ]\s*0\b|--coverage\.thresholds?\.\w+=0)/.test(cmd)) {
    block('lowering coverage thresholds is not allowed.');
  }
}
process.exit(0);
