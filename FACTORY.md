# My Wife factory guide

This kit turns the repository into a "factory": Claude Code agents read the spec, split the work, write the code, review it and merge it. You control it with one script, `scripts/run.sh`, and only answer when an agent hits something beyond its authority.

## 1. Start in six steps

1. **Unzip** the archive into an empty directory (or a new repository without `CLAUDE.md` and `.gitignore`).
2. **Prepare the machine** as described in section 2.
3. **Fill in the intake form:** copy `factory/INTAKE.example.env` to `factory` and fill in the fields tagged `[REQUIRED]`. The rest can wait.
4. **(Optional) Adjust models and handoff milestones** in `factory/config.env`. By default every agent uses Sonnet and the factory pauses for you at M1 and M4.
5. **Run the self-test** until it passes 100%:

```bash
scripts/run.sh test
```

6. **Start the real work** with one command. It runs from M0 to the end and only pauses at handoff milestones and for questions:

```bash
scripts/run.sh run
```

The first time, `scripts/run.sh run --fg` lets you watch the first cycle live. Press Ctrl+C and run it again without `--fg` to put it in the background.

## 2. Machine requirements

| Requirement | Notes |
| --- | --- |
| Linux or macOS | Not tested on Windows; use WSL there |
| 16 GB RAM (8 GB minimum) and 15 GB of free disk | The defaults are tuned for 16 GB and a 6-core CPU. Add an 8 GB swap file if you have none |
| Node.js 20 or later | The controller script has no dependencies |
| git | |
| Claude Code, signed in with your plan | Run `claude` once to sign in. Version 2.1.259 or later |
| GitHub CLI `gh`, signed in, with the `repo` and `workflow` scopes | Not needed when `GITHUB_MODE=local` in `factory/config.env` |
| Docker with the Compose plugin | So agents can run the database and the demo |

**Run it inside a container or a virtual machine, as a non-root user.** The agents run unattended and can execute commands. Keep nothing on that machine that you would not want an agent to touch, and never give it real bank emails that have not been redacted.

## 3. The commands

Everything goes through one script: `scripts/run.sh <command>`.

| Command | Effect |
| --- | --- |
| `scripts/run.sh test` | Self-test against the real Claude Code. Must pass 100% before `run`. `--quick` checks only the machine and one model call |
| `scripts/run.sh run` | Start, or resume after a stop. Runs in the background. Add `--fg` to watch live |
| `scripts/run.sh stop` | Stop after the current cycle finishes. Add `--now` to stop immediately (work in progress is discarded and redone later) |
| `scripts/run.sh status` | Show state, milestone, issue counts, machine memory, missing intake fields, handoff documents, and **answer questions** in the terminal |
| `scripts/run.sh log` | Show the log. `-f` follows it, `-n 200` shows more lines |

### The self-test

`scripts/run.sh test` runs two groups of checks and prints PASS, FAIL or WARN for each:

- **Part A, the machine (uses no plan usage):** Node.js, git, the intake form, the git repository and that the secrets file is untracked, the agent definition files, the Claude Code version and sign-in, GitHub CLI sign-in, token scopes and repository, Docker and Compose, memory, swap, disk space.
- **Part B, the real Claude Code (uses a small amount of your plan):** every configured model answers in unattended mode; an agent can edit a file and run a command without prompts; subagents from `factory/agents` load and answer in parallel; a builder works in an isolated worktree and writes a Conventional Commit; the lead writes question and state files in the format the controller parses.

When a check fails, the test prints a fix for it. If Claude Code itself works, an agent then inspects the machine read-only and writes step-by-step guidance in your language (`OWNER_LANGUAGE`). Everything is saved to `factory`. Fix, run the test again, and repeat until it reports 100%.

`run` refuses to start until the self-test has passed, and asks for a new test when the Claude Code version, the set of models, the permission mode or the GitHub mode changed. Warnings do not block. `scripts/run.sh run --skip-test` overrides the gate at your own risk.

### Running on a 16 GB machine

- The ten agents are roles, not ten processes running at once. At most `MAX_PARALLEL` builders work at the same time. With `MAX_PARALLEL=auto` that is 2 on a 16 GB machine and 1 below 12 GB.
- Before each cycle the controller checks available memory. Below `MIN_FREE_MEM_MB` it waits; if memory stays low it runs one issue at a time.
- The agents follow a resource budget written into `CLAUDE.md`: package-scoped test and typecheck commands only, a single shared PostgreSQL, Redis and NATS stack with memory limits, all ten services in one process for development and end-to-end tests, one end-to-end run at a time, and the full CI matrix on GitHub's runners instead of this machine.
- The 12th-generation i5 "F" processors have no integrated graphics. If the machine has no graphics card either, in-browser camera analysis uses the CPU; the spec requires that fallback.
- GitHub's free plan has a monthly quota of Actions minutes for private repositories. If it runs out, CI stops reporting and merges wait; check the quota in your GitHub billing settings.

## 4. How the factory works

- The controller runs in **cycles**. Each cycle invokes Claude Code once as the lead orchestrator. The lead reads the state, picks at most `MAX_PARALLEL` issues, dispatches them to specialized agents running in parallel (each builder in its own worktree), has the reviewer check the result, merges when every gate is green, writes the state and finishes.
- The next cycle starts with a clean context. All memory lives in files and on GitHub.
- Agents discuss through the lead and through issue and PR comments. A builder and the reviewer argue for at most two rounds; then the architect arbitrates.
- Any decision the spec does not cover is recorded in `docs/decisions.md`. Read it when you have time; you can overrule an entry by leaving feedback when you answer a milestone review.

Milestones (details in `factory/prompts/milestones.md`):

| Milestone | Content |
| --- | --- |
| M0 | Spec audit, scaffolding, the complete backlog |
| M1 | Walking skeleton of the four scenarios, happy path. **First demo** |
| M2 | Money, complete |
| M3 | Time and monitoring, complete |
| M4 | Routines, AI, onboarding, admin, deployment. **Full demo** |

## 5. Language and Git conventions

- The whole codebase is English: code, comments, identifiers, documentation, issues, PRs, commit messages and branch names.
- UI text and bot messages live in locale files (`vi` and `en`); the default locale is `UI_LANGUAGE`.
- Commits follow Conventional Commits 1.0.0: `type(scope): subject`, imperative, at most 72 characters, with `Refs:` or `Closes:` footers. Branches are `type/issue-number-short-summary`. `main` is protected, squash merge only, and the PR title is itself a valid commit message.
- commitlint enforces this locally and in CI; release-please generates versions and `CHANGELOG.md`. The full rules are in `CLAUDE.md` under "Git conventions".
- Files written for you (questions, handoff notes, the progress journal) are local, never committed, and written in `OWNER_LANGUAGE` from `factory/config.env` (default `vi`).

## 6. Multiple handoffs

`HANDOFF_AT` in `factory/config.env` decides at which milestones the factory pauses for you. The default is `M1,M4`. Set `M1,M2,M3,M4` to review after every milestone.

At a handoff milestone:

1. The factory writes `factory`: what exists, what does not, and how to run the demo step by step.
2. It creates an acceptance question and pauses.
3. You try the demo, run `scripts/run.sh status`, and answer `ok` or write feedback. Feedback becomes issues that are done before the next milestone starts.

## 7. When agents ask you, and where you answer

Agents ask only in six cases: new money, accounts or secrets; changing an agreed product rule; privacy and legal matters; irreversible actions; a spec conflict with no safe option; being stuck.

- Each question is a file in `factory/questions` with options and the agent's recommendation.
- `scripts/run.sh status` lists pending questions and lets you type an answer. Press Enter to skip one.
- For a long answer: open the question file, write under `## Answer`, and change `status: open` to `status: answered`.
- Each question says what it blocks: `issue` (one task is parked, the factory keeps working), `milestone` (the milestone cannot close), `all` (the factory pauses).
- If the factory is running, it resumes by itself after you answer. If it is stopped, use `scripts/run.sh run`.
- With `--fg`, questions appear directly in that terminal.

## 8. The intake form (`factory`)

Only group A is required to start. Before the acceptance tests, agents work against emulators (fake Telegram, sample emails, fake camera), so you can fill in the rest gradually. The `status` command always lists what is missing for the upcoming milestone.

| Group | Contains | Needed when |
| --- | --- | --- |
| A. Project | Project name, GitHub owner and repository, commit identity, time zone | Before `run` |
| B. Open choices | Sign-in method, first day of the week, banks in use | Optional, defaults exist |
| C. Demo infrastructure | Domain, Cloudflare account and token | Before the M1 acceptance test |
| D. Chat channels | Telegram bot token, Discord token and application ID | Before the M1 acceptance test |
| E. Google | OAuth client for Sheets and Calendar (and sign-in if you chose Google) | Before M2, or before M1 with Google sign-in |
| F. LLM for the bot | Your own API key for testing the bot | Before the M1 acceptance test |
| G. Generated | Encryption key, session secret, VAPID keys, database password | Leave empty |
| H. Test data | A folder with real, redacted bank receipt emails | Optional; improves receipt parsing |

`factory` is never committed: `.gitignore` excludes it and the `run` command double-checks. Do not paste its contents into an AI chat.

**Getting an API key for group F from the API credits included with the Max plan:** on claude.ai open Settings > Billing, and in the API credits section link an organization on platform.claude.com (create one if needed; sign in with the same email). Then create an API key in that organization's Console. You must have been on the Max plan for seven days. The credits do not roll over and cannot be used for Claude Code.

## 9. Choosing a model per agent

Edit the `MODEL_...` lines in `factory/config.env`. Values: `sonnet`, `opus`, `haiku`, `fable`, or a full model name. Changes apply from the next cycle without stopping the factory. Do not edit `.claude/agents/`; it is regenerated from `factory` every cycle.

The shares below are **estimates** of the workload across roughly 160 issues, not measurements:

| Agent | Config line | Share | Difficulty | Suggestion |
| --- | --- | --- | --- | --- |
| Service builder | `MODEL_BUILDER_SERVICE` | ~21% (about 55 issues) | Medium | Sonnet |
| Core builder (money, penalties, receipts) | `MODEL_BUILDER_CORE` | ~19% (about 45 issues) | High | Sonnet. Upgrade to Opus if the reviewer rejects its work often |
| Web builder | `MODEL_BUILDER_WEB` | ~19% (about 45 issues) | Medium | Sonnet |
| Reviewer | `MODEL_REVIEWER` | ~9% (every PR, diffs only) | High | Second upgrade priority: Opus |
| Lead orchestrator | `MODEL_LEAD` | ~8% (every cycle) | Medium | Sonnet |
| Realtime builder | `MODEL_BUILDER_REALTIME` | ~7% (about 15 issues) | High | Sonnet. Upgrade when stuck on browser quirks |
| QA | `MODEL_QA` | ~7% | Medium | Sonnet |
| Architect | `MODEL_ARCHITECT` | ~6% | Highest | First upgrade priority: Opus |
| Product owner proxy | `MODEL_PO` | ~2% | Medium | Sonnet |
| Spec auditor | `MODEL_SPEC_AUDITOR` | ~1% | High, rare | Opus |
| Scribe | `MODEL_SCRIBE` | ~1% | Low | Haiku |

How to read it: the first three builders carry about 60% of the workload, so upgrading them costs the most usage. The architect, the reviewer and the spec auditor are only about 16% but determine the quality of everything else, so an upgrade there buys the most per unit of usage. Higher models consume the plan limit faster; check with `/usage` in Claude Code.

Other knobs in `config.env`: `MAX_PARALLEL`, `MIN_FREE_MEM_MB`, `AUTO_MERGE`, `GITHUB_MODE`, `OWNER_LANGUAGE`, `PERMISSION_MODE`, `FALLBACK_MODEL`, and the wait times.

## 10. Troubleshooting

| Symptom | What the factory does | What you do |
| --- | --- | --- |
| Max plan usage limit reached | Waits 5, 15, 30, then 60 minutes and retries. `status` shows consecutive failures | Nothing. If it happens constantly, lower `MAX_PARALLEL` |
| Three cycles in a row without progress | Creates a "stalled" question and pauses | Read `scripts/run.sh log -n 200`, then answer in `status` |
| Agents heading the wrong way | | `scripts/run.sh stop`, add guidance to `docs/spec/00-final-decisions.md` or answer a question, then `scripts/run.sh run` |
| Emergency stop | | `scripts/run.sh stop --now` |
| Start over | | Stop, delete `factory`, `factory`, `factory`, then `run` |

## 11. What is in the kit

| Path | What it is |
| --- | --- |
| `FACTORY.md` | This guide |
| `HUONG-DAN.vi.md` | The same guide in Vietnamese for the owner. Git-ignored; not part of the codebase |
| `CLAUDE.md` | Rules for every agent: language policy, product principles, architecture, engineering and Git conventions |
| `docs/spec/00-final-decisions.md` | Final decisions and the glossary. Wins over every other file |
| `docs/spec/01-budget-details.md` | Budget details: transfer codes, reconciliation results, formulas |
| `docs/source/brainstorm-vi.md` | The full original brainstorm in Vietnamese, archived as source material |
| `docs/decisions.md` | The decision log agents append to |
| `factory/INTAKE.example.env` | The intake form template |
| `factory/config.env` | Model per agent, handoff milestones, pace |
| `scripts/run.sh` | The single entry point: `test`, `run`, `stop`, `status`, `log` |
| `factory/factory.mjs` | The controller behind `scripts/run.sh` |
| `factory/prompts/lead.md` | Instructions for the lead orchestrator: what one cycle does and when to ask you |
| `factory/prompts/milestones.md` | Content and exit criteria of each milestone |
| `factory` | Roles and rules of the ten specialized agents |
| `factory/fixtures/emails` | Where you put real, redacted receipt emails |

You can edit every instruction file (`CLAUDE.md`, `docs`, `factory`, `factory`) to change how agents work. Changes apply from the next cycle.

## 12. What was tested and what was not

**Tested:** the controller script `factory.mjs`, against a stand-in program replacing Claude Code. Cases that passed: the self-test passing, failing on a missing subagent and on a non-conventional commit, and printing fixes; `run` refusing to start before the self-test passes or after the setup changed; an incomplete form is reported and stops the run; git is initialized with a first commit; models from `config.env` are applied; background run; waiting and retrying on errors and on the usage limit; pausing on a question; answering in the terminal and by editing the file; resuming after an answer; stall detection; `stop` and `stop --now`; the finished state.

**Checked against the documentation and Claude Code 2.1.332:** the flags `-p`, `--model`, `--permission-mode`, `--permission-prompts`, `--fallback-model`, `--max-turns`, and the `model`, `isolation` and `disallowedTools` fields of agent definition files. Every agent file's frontmatter parses as valid YAML.

**Not tested:** anything with a signed-in Claude Code, including Part B of the self-test, which so far has only run against the stand-in. Your first `scripts/run.sh test` is the first real run of those checks; if one of them fails for a reason that looks like a defect in the test itself rather than in your setup, the report file shows the model's actual output.

Also not tested: a real cycle. The instruction files in `factory/prompts` and `factory` have not been run by real agents. This is why the first run should use `--fg` and why you should read the log of the first few cycles. If the lead behaves differently from what you want, the file to edit is `factory`.

The workload shares and time estimates are estimates. The only reliable numbers are the issues merged per day and the share of the plan limit used after the first few days.
