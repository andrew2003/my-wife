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

## Contributing

See `CONTRIBUTING.md`.

## License

Not chosen yet; see `LICENSE`.
