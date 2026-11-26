---
name: issue-workflow
description: Use when starting work on an issue, for example a new service behavior. Covers branch, tests first, package-scoped checks and handoff.
---

# Issue workflow

1. Read `CLAUDE.md`, the issue, the spec file it links, and the matching part of `packages/contracts`. Check `docs/decisions.md` for similar decisions.
2. Branch from `main`: `git switch -c <type>/<issue-number>-<short-kebab-summary>`.
3. Write one failing test per Given / When / Then criterion first. Run it and see it fail.
4. Implement the smallest change that passes. Business code takes time as a parameter. Money is integer VND. Every number from the spec is a configurable default.
5. Run package-scoped checks only: `pnpm --filter <package> typecheck`, `lint`, `test`. Never a repository-wide build, typecheck or test.
6. User-facing text goes into the `vi` and `en` locale files, never inline.
7. If the spec is silent, decide the simplest option and add one row to `docs/decisions.md`. If it is a product question, stop and ask.
8. Need to change `packages/contracts`, CI workflows, or an env file? Stop: that needs an ADR and the lead's approval.
9. Stop every watcher, dev server and container you started. Then follow the `open-pr` skill.

Never delete, skip or weaken a test. The factory hooks block it.
