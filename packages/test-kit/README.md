# @my-wife/test-kit

Test tooling for milestone M0. Test-only: no service imports it in production code.

| Tool | Entry | Purpose |
| --- | --- | --- |
| Time simulator | `SimClock` (`src/clock.ts`) | Injectable clock; `advanceDays/Weeks/Cycles` fire due timers deterministically |
| Seed data | `pnpm --filter @my-wife/test-kit seed [--file .demo/seed.json] [--now ISO]` | Idempotent demo user, invitation, categories, cycle, schedule week and tasks |
| Chat fakes | `TelegramFake`, `DiscordFake` (`src/fakes`) | In-process HTTP (and Discord gateway WS) servers with `injectText`, `tapButton`, `injectPhoto`, `botMessages`, `waitForBotMessage`, `setDown`, `failNext` |
| Reference channels | `createFakeTelegramChannel`, `createFakeDiscordChannel` | `ChatChannel` implementations over the fakes, for notify tests |
| Email fixtures | `buildEmailFixtures`, `signEmail`, `dkimDnsResolver` | Synthetic bank mails signed with generated test DKIM keys |
| Email injection | `pnpm --filter @my-wife/test-kit inject-emails [--list] [--only name] [--url ...]` | POSTs fixtures to the ingest webhook with the shared secret |

Environment for `inject-emails`: `INGEST_WEBHOOK_URL`, `INGEST_WEBHOOK_SECRET`, `DEMO_FORWARD_ADDRESS`, `DKIM_KEY_FILE`.
Keys and seed output live in `.demo/` (git-ignored). `--list` prints the DNS TXT record to publish for the test key.
