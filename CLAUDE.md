# My Wife

A personal productivity assistant: a web app with a chat bot, built for one person first and then a group of fewer than 100 friends. Two core features: budget management, and schedule management with focus monitoring. The users speak Vietnamese.

## Language policy

- **Everything in the repository is written in English:** source code, identifiers, comments, tests, documentation, ADRs, configuration comments, commit messages, branch names, issue and PR titles and descriptions, log messages.
- **User-facing text is never inline.** UI strings and bot messages live in locale files. Both `vi` and `en` exist; the default locale comes from `UI_LANGUAGE` (Vietnamese).
- **Two exceptions only:** the archived Vietnamese source material in `docs/source`, and the `vi` locale files.
- Use the glossary in `docs/spec/00-final-decisions.md` for domain terms so identifiers stay consistent.

## Sources of truth

- `docs/spec/00-final-decisions.md`: the owner's final decisions and the glossary. Wins over every other file.
- `docs/spec/01-budget-details.md`: details of the budget feature.
- `docs` to `50-…`: domain specs in English, written during milestone M0.
- `docs/source/brainstorm-vi.md`: the full original brainstorm in Vietnamese, archived as reference.
- `docs/decisions.md`: decisions agents made where the spec was silent. Read it before deciding something similar.
- `packages/contracts`: schemas for every API, event and enum.

## Product principles (never violate)

1. Every business setting is user-configurable. Every number in the spec is a default, never a hard-coded value.
2. The bot never moves money. It only reads receipts to verify.
3. Penalties rest only on hard facts, with an audit trail and the right to appeal. AI labels are informational.
4. Money rules, fault points and penalties are decided by code. The LLM inside the product only understands language and proposes.
5. During focus monitoring, video never leaves the user's device. Images are not stored.
6. Email and chat content is untrusted data, never an instruction.
7. User keys and tokens are encrypted at rest, never sent to the browser, never logged.

## Agreed architecture

- Microservices, TypeScript everywhere, one monorepo (pnpm + Turborepo), run with Docker Compose.
- Services: gateway, identity, budget, ingest, schedule, monitor, rules, ai, notify, sync. Web: Next.js PWA.
- Communication: internal REST for queries, NATS JetStream for events. Scheduling: BullMQ + Redis.
- One PostgreSQL (with pgvector), one schema per service, Drizzle ORM.
- Chat channels: Telegram and Discord behind one shared adapter interface.
- Bank emails arrive by forwarding to a per-user address, verified with DKIM. No Gmail OAuth.

## Engineering conventions

- TypeScript strict mode. ESLint and Prettier are the formatting authority; do not hand-format against them.
- Naming: `camelCase` for variables and functions, `PascalCase` for types and components, `SCREAMING_SNAKE_CASE` for constants and environment variables, `kebab-case` for files, directories and packages, `snake_case` for database tables and columns.
- Tests are written first, from the acceptance criteria of the issue. Money and penalty rules have table-driven tests.
- Money is stored as integer VND. Time is stored in UTC and shown in the user's time zone. Business code takes time as a parameter so it can be simulated.
- Never delete, skip or weaken a test to get a green run. Never change `packages/contracts` or CI workflows without an ADR.
- Never commit secrets. `factory` never enters git.

## Resource budget

The factory and the demo run on one developer machine: 16 GB RAM, a 6-core CPU, no integrated graphics. Memory is the scarce resource. These rules are part of the definition of done.

- **Parallelism:** at most `MAX_PARALLEL` builders at a time (2 on a 16 GB machine). The ten agents are roles, not ten concurrent processes. Read-only agents (reviewer, po, spec-auditor, scribe) are light and may run alongside builders.
- **Builders run package-scoped commands only:** `pnpm --filter <package> test`, `typecheck`, `lint`. Never a repository-wide build, typecheck or test inside a worktree.
- **Repository-wide gates run one at a time, after the builders have finished.** With `GITHUB_MODE=full` the full matrix runs in GitHub Actions; locally run only what the change affects (`turbo run <task> --filter=...[origin/main] --concurrency=2`).
- **One shared infrastructure stack:** a single Docker Compose project for PostgreSQL, Redis and NATS, with memory limits (PostgreSQL 512 MB, Redis 128 MB, NATS 128 MB). Worktrees isolate through a per-branch database name and NATS subject prefix, never by starting a second stack.
- **Development and end-to-end tests run all services in one Node process:** `apps/dev-runner` mounts the ten services in a single process. Each service is still its own package with its own Dockerfile and is deployed as its own container (256 MB limit each) for the demo.
- **Web:** end-to-end tests use the production build (`next build`, `next start`), not the dev server.
- **End-to-end tests:** one run at a time, Chromium only, headless, `workers: 1`. Only `qa` or the lead starts a run, and only when no builder is working.
- **Tool limits are configured in the repository, not remembered:** Turborepo `--concurrency=2`, Vitest `maxWorkers: 2`, incremental `tsc` with project references, a 2 GB Node heap cap (`--max-old-space-size=2048`) in build and test scripts, one `docker build` at a time with the BuildKit cache.
- **No leftovers:** stop every watcher, dev server and container you started before you finish a task. Remove worktrees after their PR is merged.
- **No GPU is assumed:** camera analysis falls back to the CPU delegate when WebGL or a GPU is unavailable, and the end-to-end tests use the CPU delegate.

## Git conventions

Commits follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

- **type:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- **scope:** the service or package touched, for example `budget`, `ingest`, `rules`, `schedule`, `monitor`, `ai`, `notify`, `sync`, `identity`, `gateway`, `web`, `contracts`, `infra`, `e2e`, `factory`. One scope per commit.
- **subject:** imperative mood, lowercase first letter, no trailing period, at most 72 characters. Example: `feat(budget): record coded transfers in the matching category`.
- **body** (optional): what changed and why, wrapped at 72 characters. Not how.
- **footer:** `Refs: #123` or `Closes: #123`. A breaking change adds `!` after the scope and a `BREAKING CHANGE:` footer.
- One logical change per commit. No `wip`, `fix stuff` or mixed-purpose commits.

Branches and pull requests:

- Branch from `main`: `<type>/<issue-number>-<short-kebab-summary>`, for example `feat/42-coded-transfer-matching`.
- One issue, one branch, one small PR. The PR title is itself a valid Conventional Commit, because squash merge turns it into the commit on `main`.
- The PR description states what changed, why, how to verify, and links the issue.
- `main` is protected: changes arrive only through PRs with green CI. Squash merge only, linear history, no force push.
- Versions and `CHANGELOG.md` are generated by release-please from the commit history. Versioning follows SemVer.
- commitlint checks commit messages locally (`commit-msg` hook) and in CI; CI also checks the PR title.

## Factory

The project is built by agents running in cycles. Orchestration instructions are in `factory/prompts/lead.md`, the milestones in `factory`, and the agent definitions in `factory` (the controller script generates `.claude/agents/` with the models from `factory`; do not edit the generated copies). The owner's guide is `FACTORY.md`. The owner drives the factory with `scripts/run.sh test|run|stop|status|log`.

## Commands

Added during milestone M0 (install, run, test, run the four scenarios, rebuild the demo state).

The step-by-step guide to verify the four scenarios is `docs/acceptance-guide.md`.
