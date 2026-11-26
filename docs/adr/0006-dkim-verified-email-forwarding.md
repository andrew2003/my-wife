# ADR 0006: Bank emails by forwarding, verified with DKIM

- Status: accepted
- Date: 2026-11-26

## Context

Receipts prove that money moved and can clear a penalty, so a forged email must never count. Gmail OAuth would give broad mailbox access that the product does not need.

## Decision

- Each user has a private address `u-<token>@in.<domain>`; the user forwards bank mail to it. No Gmail OAuth.
- Cloudflare Email Routing delivers raw mail to the ingest webhook, authenticated with a shared secret.
- Ingest accepts only senders in the admin-curated map `bank sender -> DKIM domain`, with a valid signature of that domain (verified with `mailauth`). Unsigned or forged mail is rejected.
- Email content is untrusted data. The LLM that reads a receipt has no tools and returns structured fields only.
- Weekly balance reconciliation is the backstop for money without a receipt.

## Consequences

- Fixtures are synthetic mails signed with a test key; no real emails are committed.
