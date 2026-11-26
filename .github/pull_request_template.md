## What changed

<!-- One logical change. The PR title must be a valid Conventional Commit. -->

## Why

<!-- Link the issue: Closes #123 -->

## How to verify

<!-- Package-scoped commands, for example: pnpm --filter @my-wife/budget test -->

## Checklist

- [ ] Tests were written first from the acceptance criteria
- [ ] Lint and typecheck pass for the touched packages
- [ ] No hard-coded business numbers; user-facing text is in the `vi` and `en` locale files
- [ ] No secrets, keys or tokens in code, logs or fixtures
- [ ] `packages/contracts` is untouched, or an ADR covers the change
