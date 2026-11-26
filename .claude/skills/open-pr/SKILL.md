---
name: open-pr
description: Use when committing and opening a pull request for a finished issue.
---

# Commit and open a PR

- Branch: `<type>/<issue-number>-<short-kebab-summary>`.
- Commits are Conventional Commits with one scope: `feat(budget): record coded transfers in the matching category`. Subject is imperative, lowercase, no trailing period, at most 72 characters. One logical change per commit. Footer: `Refs: #123` or `Closes: #123`.
- Never commit secrets, `.env` files or anything under `factory/` that is git-ignored. Stage files by name, not with `git add -A`.
- Before pushing run the package-scoped `typecheck`, `lint` and `test` for the touched packages.
- Open the PR with `gh pr create`. The title is itself a valid Conventional Commit (squash merge turns it into the commit on `main`). The body states what changed, why, how to verify, and links the issue.
- Do not merge. Squash merge only, after green CI and review. Never force push to `main`.
