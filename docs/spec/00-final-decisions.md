# Final decisions

This file records the project owner's final decisions. When it conflicts with `docs/source/brainstorm-vi.md` or any other file, **this file wins**. The mechanics of each feature are described in the source document; this file states the conclusions, the glossary, and the places where the source still contains superseded text.

## Scope

- The demo includes **everything** the spec describes: both Telegram and Discord, self-learning receipt templates, Sheets and Calendar sync, the lunar calendar, onboarding, and the admin page.
- After the demo: Zalo, accountability partner, camera spoofing countermeasures, importing existing Google Calendar events, bill and subscription reminders, the "bad day" button, cycle report, voice messages, general email management.
- The work is organized as milestones M0–M4 in `factory/prompts/milestones.md`. The P0–P4 roadmap and the manual workflow tips in the source document are superseded.

## Language and Git

- The whole codebase is in English: code, comments, identifiers, documentation, issues, PRs, commit messages, branch names.
- UI text and bot messages live in locale files (`vi` and `en`); the default locale is Vietnamese.
- Commits follow Conventional Commits 1.0.0 and are enforced by commitlint locally and in CI. Details are in `CLAUDE.md`.

## Glossary

Use these English terms in identifiers, contracts and documentation.

| Vietnamese | English term | Meaning |
| --- | --- | --- |
| vòng (ngân sách) | budget cycle | A budget period of N weeks, N set by the user |
| mục | budget category | One line of the budget (food, transport, …) |
| nhãn Cần / Nên / Muốn / Quỹ | priority: `need` / `should` / `want` / `fund` | Label of a budget category |
| mục cố định / biến động | fixed / variable category | Fixed categories never produce surplus |
| phần dư | surplus | Money left at the end of a cycle in categories flagged to count |
| quỹ dự phòng | contingency fund | Source for allowed exceptions |
| mua sắm tương lai | future purchases | Category funded from a share of the surplus |
| danh sách mong muốn | wishlist | Items the user is saving for |
| ngân hàng | bank account | An account that holds a group of categories |
| mã chuyển khoản | transfer code | The memo code that links a transfer to a planned item |
| đối chiếu | reconciliation | Matching receipts against the weekly plan |
| bất thường | anomaly | A transaction the bot cannot classify; goes to the anomaly inbox |
| biên lai lạ | unknown receipt | A receipt whose template has not been learned yet |
| mẫu biên lai | receipt template | A learned parser for one sender and layout; `learning` or `trusted` |
| đối soát số dư | balance reconciliation | Weekly comparison of expected and actual account balances |
| điều chuyển | internal transfer | Money moved between the user's own accounts |
| sổ nợ | debt ledger | Receivables and payables with friends |
| quỹ thu | income pool | Income waiting to be allocated to the next cycle |
| phạt | penalty | Money moved to penalty savings because of a rule violation |
| phạt treo | suspended penalty | A penalty accrued during trial mode, collected when the trial ends |
| tiết kiệm phạt | penalty savings | The locked account that receives penalties |
| trần phạt | penalty cap | Maximum penalty per week; the excess carries over |
| chế độ thử | trial mode | Initial period in which penalties are suspended |
| bản cam kết | commitment contract | The per-cycle summary of rules the user signs |
| khoá nới lỏng | loosening lock | Loosening a rule takes effect only from the next week or cycle |
| TKB | schedule | The weekly timetable of tasks |
| nhịp ngày | daily rhythm | Morning top-three pick and evening reflection |
| luật dồn việc | carry-over rule | What happens to an unfinished task |
| giám sát | focus monitoring | Required web presence and camera checks during work windows |
| tín hiệu cứng / mềm | hard / soft signal | Hard signals can add fault points; soft signals only nudge |
| tin khẩn | urgent message | The escalating "you lost focus" message asking for a reason |
| lý do | reason | The user's explanation, with per-type quotas |
| điểm lỗi / sổ lỗi | fault points / fault ledger | Accumulated hard faults |
| mốc phạt | penalty threshold | Fault-point level that triggers a penalty |
| thẻ miễn | waiver | A limited number of forgiven faults per week |
| kháng cáo | appeal | The user's request to review a fault or a classification |
| giám sát giảm dần | tapering supervision | Levels from full monitoring down to "graduated" |
| nhịp sinh hoạt | routines | Sleep, meals and rest, managed separately from work tasks |
| mức: tắt / chỉ nhắc / nhắc + ghi nhận / cam kết | level: `off` / `remind` / `track` / `commit` | Routine management level |
| ảnh dậy | wake-up photo | The check-in photo sent in chat with a random challenge |
| giờ yên lặng | quiet hours | Hours in which only wake-up and urgent messages are sent |
| bản tin sáng / tối | morning / evening digest | Batched non-urgent messages |
| hộp thư | inbox | In-app list of every bot message and pending question |
| ghi nhanh | quick capture | Logging a cash expense or a task by chatting |
| khởi tạo | onboarding | First-run tour, setup checklist and generated templates |
| người vợ (persona) | persona | The bot's voice, strictness and memory, independent of the model |
| bài kiểm tra bàn giao | handover test | Fixed questions a new model must pass before it is enabled |

## Principles

- Every setting is user-configurable; every number in the spec is a default.
- The web app is where users view and edit, including in-app sheet views. The Google Sheet is kept in sync both ways for plan data only (see `41-sync.md` and ADR 0015); calendars (Google or Apple) are one-way mirrors.
- The bot never moves money.
- Money rules, fault points and penalties are decided by code; the LLM only proposes.
- The end goal is habit: supervision tapers until the user "graduates".

## Budget

- The budget runs in cycles of N weeks. The budget week and the schedule week share the same first day.
- Opening a cycle: ask "anything new?", the user transfers money into the right accounts, the bot verifies by receipt and only then opens the cycle. If money is short, wait or let the user lower the amounts.
- Bank emails arrive by **forwarding** to a per-user address, verified with the bank domain's DKIM signature. **No Gmail OAuth.** Any mention in the source of an "email reading job" or Gmail read permission is superseded.
- No receipt samples are needed up front. The bot reads a new template with an LLM, verifies it, generates a parser, promotes the template after N matches and demotes it when the bank changes the layout.
- International cards, internal transfers, refunds, cash withdrawals, bank fees, debts, shared group expenses and income follow the tables in the source document.
- An overdue receivable automatically becomes an expense.
- Weekly balance reconciliation is the backstop that catches spending without receipts.

## Penalties

- Overspending penalty: 100% of the excess, deducted from next week's limit of the same category.
- Monitoring and routine penalties: deducted from `want` categories in the order the user sets, never from `need` categories.
- Penalties go to a separate **penalty savings** account. They do not count toward the fixed savings contribution or the surplus share. The money may not be spent; withdrawing it is a serious violation that must be repaid with an extra penalty. It unlocks only under the condition written in the commitment contract.
- There is a weekly penalty cap; the excess carries over to the next week.
- Trial mode with suspended penalties: computed as if real, faults caused by the system are waived automatically, an appeal window follows the trial, then the total becomes a real penalty paid at once or over K weeks. Leaving trial mode or deleting the account does not erase suspended penalties.
- The user signs a commitment contract per cycle. Tightening a rule applies immediately; loosening applies only from the next week or cycle.

## Schedule and monitoring

- The user must keep the web app open during self-defined work windows. No device blocking.
- The user ticks tasks off themselves. The bot never sends "task completed" messages.
- Camera analysis runs in the browser. A single frame is sent to a vision model only on appeal or when the result is ambiguous.
- Only hard signals add fault points. Soft signals only nudge.
- Camera monitoring requires a computer. Phones use the checklist, the countdown and chat.
- Routines are a separate layer with four levels; by default no camera and no penalty.
- Waking up is proven by a photo sent in chat with a random challenge, graded by a vision model. That photo passes through the chat channel and the LLM provider, so it needs separate consent and is deleted after grading.

## Messaging

- Channels: Telegram and Discord. The user picks the channel and quiet hours.
- Only wake-up and urgent messages are sent during quiet hours.
- Ordinary messages are batched into a morning and an evening digest. Every message also appears in the in-app inbox.
- Every question from the bot has quick-reply buttons.

## AI inside the product

- Each user brings their own API key and picks the provider and model.
- Persona, memory, history and the tool set live on the My Wife side, so switching models never creates a "new wife". A switch must pass the handover test.
- When the LLM fails or runs out of credit: the countdown, the rules, the penalties, trusted receipt templates and the buttons keep working.

## Technical

- Microservices, TypeScript for both front end and back end. Details in `CLAUDE.md` and the source document.
- Demo infrastructure: one domain, Cloudflare Tunnel for HTTPS, Cloudflare Email Routing for inbound mail.
- Full GitHub workflow: PRs, required CI, Conventional Commits, protected `main`.
- Web sign-in follows `LOGIN_METHOD` in the intake form (default Google); sign-up is by invitation.

## Target machine

- Development and the demo run on one machine with 16 GB RAM and a 6-core CPU without integrated graphics. The resource budget in `CLAUDE.md` is binding: at most two builders in parallel, one shared infrastructure stack, all services in one process for development and end-to-end tests.
- Camera analysis must work without a GPU (CPU delegate fallback).

## How the factory asks the owner

- The owner drives the factory with `scripts/run.sh test|run|stop|status|log`. The self-test (`test`) must pass 100% before `run` starts.
- Questions are stored in `factory/questions/` and shown by `scripts/run.sh status`. Questions are not sent over Telegram. Mentions in the source of "asking via Telegram" or a `factory start` command are superseded.
- Every agent defaults to Sonnet; the model per agent is set in `factory/config.env`.
