# Notify service

Owner: `notify`. Delivery of every message to the user over Telegram, Discord and web push; the in-app inbox; quiet hours; digests; questions with quick-reply buttons. Telegram and Discord sit behind one shared adapter interface (grammY, discord.js).

## 1. Message classes

| Class | Examples | Delivery |
| --- | --- | --- |
| `urgent` | "you lost focus", penalty due, wake-up message | Immediately, including quiet hours |
| `timed` | Reminder at an exact time (bedtime, task end) | At the time; during quiet hours only the wake-up message passes |
| `question` | Any message with quick-reply buttons | Immediately unless quiet hours; expires after `notify.question_expiry_hours` |
| `digest` | Everything non-urgent | Batched into the morning digest (`notify.morning_digest_time`: today's schedule, remaining limits, debts due) and the evening digest (`notify.evening_digest_time`) |

Quiet hours (`notify.quiet_hours`): only wake-up and urgent messages are sent. All others wait for the morning digest. Single messages are reserved for time-critical events or questions. Every message, in every class, also appears in the in-app **inbox**, even if chat delivery failed. Urgent messages are rate-limited to one per `monitor.urgent_min_gap_minutes` (enforced here as well as in monitor).

## 2. Channel adapter interface

`ChatChannel` (contract in `packages/contracts`): `send(message)`, `sendQuestion(message, buttons)`, `parseReply(update)`, `sendPhotoRequest`, `receivePhoto`, `link(userToken)`, `health()`. Implementations: Telegram, Discord. The user picks the channel; the link flow sends a test message and records a `channel_link`. Zalo is out of scope.

## 3. Questions and replies

Every question from the bot has quick-reply buttons. A question has `id`, `source_service`, `kind` (for example `budget_category`, `routine_checkin`, `carry_over`, `supervision_taper`), options with stable values, and `expires_at`.

State machine:

`created` -> `delivered` -> `answered` | `expired` | `cancelled`.

| From | Trigger | To |
| --- | --- | --- |
| `created` | adapter accepted | `delivered`, retried `notify.delivery_retries` times with backoff, otherwise `delivered_inbox_only` |
| `delivered` | user taps a button (chat or web) | `answered` (emit `notify.reply_received`) |
| `delivered` | `expires_at` | `expired` (the owning service applies its deadline rule) |
| `created`/`delivered` | owning service cancels | `cancelled` |

A reply is idempotent: the second tap on a button of an answered question changes nothing. A reply from a chat identity not linked to the user is ignored. Replies from chat are data; free text is passed to `ai` as a user message.

## 4. Inbox

A list of every bot message and pending question, filterable by service and state, with the buttons usable from the web. Retention `notify.inbox_retention_days`. Anomaly questions from `budget` show here with the same buttons.

## 5. Web push

PWA web push for urgent messages and the wake-up message; subscriptions stored per device; stale subscriptions are removed when the push service reports them gone.

## 6. Data

`channel_link`, `message` (class, body key and params, locale, delivery per channel), `question`, `digest_batch`, `push_subscription`, `delivery_attempt`.

Messages carry a locale key and parameters, never a prebuilt string; text is rendered from the `vi` or `en` locale files at delivery.

## 7. Events

Published: `notify.sent`, `notify.delivery_failed`, `notify.reply_received`, `notify.question_expired`, `channel.linked`, `channel.unhealthy`, `digest.sent`.

Consumed: `ask.*` (questions), `penalty.issued`, `penalty.due`, `urgent.sent`, `routine.reminder_due`, `routine.wake_challenge_sent`, `rhythm.*_due`, `anomaly.opened`, `debt.overdue`, `review.ready`, `cycle.*`, `user.updated`.

## 8. Acceptance

1. Given quiet hours 23:00-06:30 and a non-urgent message at 02:00, Then it is not sent and appears in the morning digest and the inbox.
2. Given a wake-up message at 06:00 with quiet hours until 06:30, Then it is sent immediately.
3. Given a question with three buttons, When the user taps one in Telegram and later another in the web, Then only the first reply counts.
4. Given the chat adapter is down, Then the message is in the inbox, a retry follows the backoff, and `notify.delivery_failed` is emitted after retries.
5. Given two urgent messages within 5 minutes, Then one is sent.
6. Given a question that expires, Then `notify.question_expired` triggers the owning service's deadline rule.
