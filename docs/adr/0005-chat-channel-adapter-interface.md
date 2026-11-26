# ADR 0005: One chat adapter interface for Telegram and Discord

- Status: accepted
- Date: 2026-11-26

## Context

Users choose Telegram or Discord. Zalo may follow after the demo.

## Decision

- `notify` talks to chats only through the `ChatChannel` interface defined in `packages/contracts`: `send`, `sendQuestion`, `parseReply`, `sendPhotoRequest`, `receivePhoto`, `link`, `health`.
- Implementations: grammY for Telegram, discord.js for Discord. Business code never imports either library.
- Messages carry a locale key and parameters, never a prebuilt string. Replies and photos are untrusted data.

## Consequences

- Adding a channel means one new implementation and a new `ChannelKind` value (ADR required).
