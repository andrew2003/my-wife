# My Wife

A personal productivity assistant: a web app with a chat bot, built for one person first and then a
group of fewer than 100 friends. Two core features: budget management, and schedule management with
focus monitoring. The users speak Vietnamese.

## Layout

| Path                 | Contents                                                                      |
| -------------------- | ----------------------------------------------------------------------------- |
| `apps/web`           | Next.js PWA                                                                   |
| `apps/dev-runner`    | One Node process that mounts all ten services for development and e2e tests   |
| `apps/e2e`           | Playwright suite (Chromium only, headless)                                    |
| `services/<name>`    | gateway, identity, budget, ingest, schedule, monitor, rules, ai, notify, sync |
| `packages/contracts` | zod schemas for every API, event and enum                                     |
| `packages/*`         | config, service-kit, test-kit                                                 |
| `infra`              | Docker Compose stack (PostgreSQL + pgvector, Redis, NATS JetStream)           |
| `docs`               | Specs (`docs/spec`), ADRs, and the decision log                               |

Start with `CLAUDE.md` (conventions and product principles) and `docs/spec/00-final-decisions.md`
(final decisions and glossary).

## Requirements

Node 22 or newer and pnpm 10. Docker for the shared infrastructure stack.

## Common commands

```sh
pnpm install
pnpm --filter <package> test        # package-scoped test run
pnpm --filter <package> typecheck
pnpm --filter <package> lint
pnpm format:check                   # Prettier is the formatting authority
pnpm dev                            # all services in one process
pnpm generate:service <name>        # new service from templates/service
```

Prefer package-scoped commands. Repository-wide runs use `turbo run <task> --concurrency=2`.

## Manual demo

Click through the web app by hand as the demo account. Not for production: `DEMO_LOGIN=1` makes
the dev runner throw at startup when `NODE_ENV=production`. Run each step in its own terminal from
the repository root, in this order:

```sh
pnpm install
pnpm demo:reset                                       # 1. build and print the demo state
pnpm --filter @my-wife/web build                      # 2. production build of the web app (once)
DEMO_LOGIN=1 DEV_RUNNER_NO_NATS=1 pnpm dev            # 3. run all services (ports 4000-4009, sign-in helper on 4100)
pnpm --filter @my-wife/web start                      # 4. run the web app on http://localhost:3000
xdg-open http://localhost:4100/demo-login             # 5. sign in as the demo account and land on the web app
```

Use `localhost`, not `127.0.0.1`, in the browser: the session cookie is set for the host you open.
The runner resets the demo user in its own in-memory store at startup, so step 1 only previews the
state (and writes it to the identity schema when `DATABASE_URL` is set). Stop steps 3 and 4 with
Ctrl+C. Set `WEB_URL` if the web app runs on another origin.

Known gap: the budget and schedule read routes the screens call are not all in place yet, so some
screens show empty states (see issues #244, #247, #271, #273).

Step-by-step verification of the four demo scenarios: `docs/acceptance-guide.md`.

## Contributing

See `CONTRIBUTING.md`.

## License

Not chosen yet; see `LICENSE`.
