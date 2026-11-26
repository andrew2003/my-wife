// Best effort only: this guard catches the common edit paths (Edit, Write, MultiEdit and plain shell
// commands). It cannot stop determined bypasses such as `node -e`, `git checkout`, scripts that
// rewrite files, or test runners configured to ignore files. Review and CI remain the real gate.
// PreToolUse: block deleting, skipping or weakening tests (Edit, Write, MultiEdit, Bash).
import { readInput, relPath, newTexts, readIfExists, block, isTestFile, stripNoise } from './lib.mjs';

const input = readInput();
const tool = input.tool_name;
const ti = input.tool_input ?? {};

// Unconditional skips and focus markers. Conditional skips such as Playwright's
// test.skip(isMobile, 'reason') are allowed: only a literal first argument (string, template,
// true) or no argument at all counts as unconditional. it.todo additions are allowed; replacing a
// test with a todo is caught by the test-count check below.
const SKIP_PATTERNS = [
  /\b(it|test|describe|suite)\.skip\b(?!\s*\(\s*[^'"`\s)](?!rue\b))/,
  /\b(it|test|describe|suite)\.(only|fails)\b/,
  /\b(xit|xdescribe|xtest|fit|fdescribe)\s*\(/,
];
// Count test cases without parsing parentheses: it( / test( and one per it.each / test.each.
const TEST_CALL = /\b(it|test)(\.each\b|\s*\()/g;
const countTests = (s) => (s.match(TEST_CALL) ?? []).length;
const hasEach = (s) => /\b(it|test)\.each\b/.test(s);

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
      if (after < before && !hasEach(ti.content ?? '')) block(`${rel}: rewrite removes tests (${before} -> ${after}). Tests must not be deleted or weakened.`);
    } else {
      const edits = tool === 'MultiEdit' ? (ti.edits ?? []) : [ti];
      for (const e of edits) {
        const removed = countTests(e.old_string ?? '') - countTests(e.new_string ?? '');
        // Consolidating cases into a table-driven it.each / test.each may reduce the literal count.
        if (removed > 0 && !hasEach(e.new_string ?? '')) block(`${rel}: edit removes ${removed} test case(s). Tests must not be deleted or weakened.`);
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
  const cmd = stripNoise(ti.command);
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
