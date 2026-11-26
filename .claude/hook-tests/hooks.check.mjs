// Sample-JSON checks for the factory hooks. Run with: node --test .claude/hook-tests/hooks.check.mjs
// (The file is not named *.test.* on purpose: it contains skip markers as test data.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hook = (name) => path.join(root, '.claude/hooks', name);

function run(name, input, env = {}) {
  const r = spawnSync('node', [hook(name)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: root, ...env },
  });
  return r.status;
}
const edit = (file_path, old_string, new_string) => ({
  tool_name: 'Edit',
  tool_input: { file_path, old_string, new_string },
});
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const write = (file_path, content) => ({ tool_name: 'Write', tool_input: { file_path, content } });

const P = 'guard-protected-paths.mjs';
const T = 'guard-tests.mjs';

const protectedCases = [
  ['contracts edit blocked', edit('packages/contracts/src/a.ts', 'a', 'b'), {}, 2],
  ['contracts edit allowed with hatch', edit('packages/contracts/src/a.ts', 'a', 'b'), { FACTORY_ALLOW_CONTRACTS: '1' }, 0],
  ['.env write blocked', write('.env', 'X=1'), {}, 2],
  ['.env write allowed with hatch', write('.env', 'X=1'), { FACTORY_ALLOW_ENV: '1' }, 0],
  ['.env.example allowed', write('.env.example', 'X='), {}, 0],
  ['.env.sample allowed', write('.env.sample', 'X='), {}, 0],
  ['.env.template allowed', write('.env.template', 'X='), {}, 0],
  ['intake blocked even with hatch', write('factory/INTAKE.env', 'X=1'), { FACTORY_ALLOW_ENV: '1' }, 2],
  ['hooks edit blocked', edit('.claude/hooks/lib.mjs', 'a', 'b'), {}, 2],
  ['settings.json edit blocked', write('.claude/settings.json', '{}'), {}, 2],
  ['settings.local.json edit blocked', write('.claude/settings.local.json', '{}'), {}, 2],
  ['skills edit allowed', write('.claude/skills/x/SKILL.md', 'x'), {}, 0],
  ['workflow edit blocked', write('.github/workflows/ci.yml', 'x'), {}, 2],
  ['workflow edit allowed with hatch', write('.github/workflows/ci.yml', 'x'), { FACTORY_ALLOW_CI: '1' }, 0],
  ['git add intake blocked', bash('git add factory/INTAKE.env'), {}, 2],
  ['git add .env.example allowed', bash('git add .env.example'), {}, 0],
  ['redirect into contracts blocked', bash('echo x > packages/contracts/a.ts'), {}, 2],
  ['cat contracts allowed', bash('cat packages/contracts/src/a.ts'), {}, 0],
  ['ls contracts with 2>&1 allowed', bash('ls packages/contracts 2>&1'), {}, 0],
  ['grep contracts to /dev/null allowed', bash('grep -r foo packages/contracts >/dev/null 2>&1'), {}, 0],
  ['grep arrow in contracts allowed', bash("grep -rn '=>' packages/contracts/src"), {}, 0],
  ['shell write to settings blocked', bash('echo {} > .claude/settings.local.json'), {}, 2],
];

const testCases = [
  ['rm test file blocked', bash('rm services/budget/src/a.test.ts'), 2],
  ['rm dist allowed', bash('rm -rf dist'), 0],
  ['it.skip blocked', edit('a.test.ts', 'it("a", () => {})', 'it.skip("a", () => {})'), 2],
  ['it.only blocked', edit('a.test.ts', 'x', 'it.only("a", () => {})'), 2],
  ['xit blocked', edit('a.test.ts', 'x', 'xit("a", () => {})'), 2],
  ['unconditional test.skip() blocked', edit('a.spec.ts', 'x', 'test.skip();'), 2],
  ['conditional playwright test.skip allowed', edit('a.spec.ts', 'x', "test.skip(isMobile, 'desktop only');"), 0],
  ['it.todo replacing a test blocked', edit('a.test.ts', 'it("a", () => {})', 'it.todo("a")'), 2],
  ['it.todo addition allowed', edit('a.test.ts', 'x', 'it.todo("later")'), 0],
  ['adding a test allowed', edit('a.test.ts', 'x', 'it("b", () => {})'), 0],
  ['removing a test blocked', edit('a.test.ts', 'it("a", () => {})', 'const x = 1;'), 2],
  [
    'consolidating into it.each allowed',
    edit('a.test.ts', 'it("a", () => {})\nit("b", () => {})', 'it.each([[1],[2]])("c %s", () => {})'),
    0,
  ],
  ['nested parens in it.each counted safely', edit('a.test.ts', 'x', 'it.each([[f(1)],[g(2)]])("c", () => {})'), 0],
  ['skip outside tests allowed', edit('src/a.ts', 'x', 'it.skip(1)'), 0],
  ['lowering threshold blocked', edit('vitest.config.ts', 'lines: 80', 'lines: 50'), 2],
  ['raising threshold allowed', edit('vitest.config.ts', 'lines: 80', 'lines: 90'), 0],
  ['passWithNoTests blocked', bash('vitest run --passWithNoTests'), 2],
  ['arrow function in a test-path grep allowed', bash("grep -rn '=>' services/budget/src/a.test.ts"), 0],
  ['cat test with 2>&1 allowed', bash('cat services/budget/src/a.test.ts 2>&1'), 0],
  ['run tests with 2>&1 allowed', bash('pnpm --filter @my-wife/budget test 2>&1 | tail -20'), 0],
];

for (const [name, input, env, expected] of protectedCases) {
  test(`protected: ${name}`, () => assert.equal(run(P, input, env), expected));
}
for (const [name, input, expected] of testCases) {
  test(`tests: ${name}`, () => assert.equal(run(T, input), expected));
}
