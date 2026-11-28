# ADR 0016: Chat command contracts

Status: accepted (2026-11-28). Schemas land in `packages/contracts/src/commands` (issue #532).

## Context

The bot has no chat commands today. The owner approved a default command set, user editing of names and descriptions, and custom commands, across Telegram, Discord and the in-app chat.

## Decision

1. **What a command is.** A message from the linked user that starts with `/`. Code parses and executes it; only commands marked AI pass text to the model. Text inside forwarded emails, receipts or sheet cells is never a command. Replies use the persona voice.
2. **Defaults.** Each default has an English name and a Vietnamese alias.
   - Control: `/help`, `/model [name]` (the switch runs the existing handover test and asks for confirmation), `/usage` (tokens used today, the daily cap `ai.daily_token_cap`, provider quota when the provider reports it), `/status` (cycle sequence and week index, tasks done and total today, fault points this week, sync state per link, degraded mode flag), `/new`, `/stop`, `/lang vi|en`, `/strict 1-5`, `/quiet [until HH:MM|off]`, `/skin [name]`.
   - Capture: `/task`, `/spend <amount> <category or note>`, `/remember`, `/forget` (with confirmation).
   - Summaries (AI, facts supplied by code): `/summary`, `/today`, `/week`, `/budget`.
   - Mood tags: `/happy`, `/sad`, `/tired`, `/stressed`, `/angry` plus a message. The mood is stored with the message and shapes the reply and expression only; it never changes money, fault points or penalties.
   - Rules: `/appeal [fault]`, `/reason <text>`.
3. **Descriptions.** Every command has an editable description of one or two sentences. It is added to the model context when the command is used, shown in `/help` and in the Telegram and Discord menus, and is user context that never bypasses code rules. Built-ins ship default descriptions in both locales and can be reset.
4. **Customisation.** Per command: enabled, name, aliases, description. Custom kinds: `prompt` (template with `{text}`), `mood` (with an expression key), `shortcut` (an existing command with preset arguments). A custom command reaches only what built-ins and tools reach. Names match `^[a-z0-9_]{1,32}$` and are unique per user across names and aliases. The enabled list is registered with Telegram and Discord.
5. **Schemas (contracts).** `CommandDefinition` (id, kind, name, aliases, descriptionKey or description text per locale, enabled, ai flag, builtin flag, argument spec), `CommandInvocation` (channel, user id, raw text, resolved command id, arguments, locale), `CommandResult` (status `ok`, `refused`, `needs_confirmation`, `unknown`, `disabled`; reply key and parameters), `CustomCommandInput`, `MoodTag` enum (`happy`, `sad`, `tired`, `stressed`, `angry`), and events `command.executed` and `command.refused` (no message text in the payload).
6. **Execution rules.** `/spend` and `/task` go through the same services and validation as the web. `/spend` records a spend fact the user reports; it never moves money. `/forget` and `/model` need confirmation. All inputs are validated with the schemas at the edge.

## Consequences

- A parser and registry live in one place and are used by all channels, so adapters stay thin.
- Command text is audited without storing message bodies in events.
- Tests cover parsing, aliases, a disabled command, a custom prompt command, a mood tag, descriptions reaching the model context, the untrusted-text rule and both locales.

## Contract details (issue #532)

- Schemas: `CommandDefinition`, `CustomCommandInput` (discriminated by `kind`: `prompt` needs `{text}` in its template, `mood` needs `expressionKey`, `shortcut` needs `targetCommandId` and `presetArgs`), `CommandInvocation`, `CommandResult`, `CommandSettings` (per-user overrides of built-ins plus custom commands), `CommandMenuEntry` (description at most 256 characters, the Telegram limit), `MoodTag`.
- `CommandChannel` is `telegram`, `discord` or `web` (the in-app chat).
- Events `command.executed` and `command.refused` are published by `notify`, whose adapters parse commands. Payloads are strict and hold no message text.
- New setting `chat.max_custom_commands` (default 20, owner `notify`) caps custom commands per user.
