import type { ChatChannel, CommandDefinition, CommandMenuEntry, Locale } from "@my-wife/contracts";
import { renderMessage } from "../i18n";

/** Telegram allows 256 characters per menu description (the contract limit). */
const MENU_DESCRIPTION_MAX = 256;

/** A chat channel that can publish a command menu (ADR 0016). */
export interface MenuChannel extends ChatChannel {
  /** Replaces the menu shown in the chat identified by `target`. */
  registerMenu(target: string, entries: CommandMenuEntry[]): Promise<void>;
}

export function supportsMenu(channel: ChatChannel): channel is MenuChannel {
  return typeof (channel as Partial<MenuChannel>).registerMenu === "function";
}

/** The description text of a command in a locale: user text wins over the shipped key. */
export function describeCommand(def: CommandDefinition, locale: Locale): string {
  if (def.description) return def.description[locale];
  return renderMessage({ key: def.descriptionKey ?? "", params: {} }, locale);
}

/** Enabled commands only; a disabled command never reaches a menu. */
export function menuEntries(
  defs: readonly CommandDefinition[],
  locale: Locale,
): CommandMenuEntry[] {
  return defs
    .filter((d) => d.enabled)
    .map((d) => ({
      command: d.name,
      description: describeCommand(d, locale).slice(0, MENU_DESCRIPTION_MAX),
    }))
    .filter((e) => e.description.length > 0);
}

export interface MenuTarget {
  channel: ChatChannel;
  /** The external chat id of the linked user on that channel. */
  target: string;
}

/** Registers the user's enabled commands with each channel that supports menus. */
export async function registerCommandMenus(
  targets: readonly MenuTarget[],
  defs: readonly CommandDefinition[],
  locale: Locale,
): Promise<void> {
  const entries = menuEntries(defs, locale);
  for (const { channel, target } of targets) {
    if (supportsMenu(channel)) await channel.registerMenu(target, entries);
  }
}

export interface CommandSuggestion {
  name: string;
  /** The alias the typed prefix matched, when it was not the primary name. */
  matchedAs?: string;
  description: string;
}

/**
 * Suggestions for the in-app chat input. Only a bare `/prefix` (no space yet) suggests; names and
 * aliases of enabled commands match by prefix, in registry order.
 */
export function suggestCommands(
  input: string,
  defs: readonly CommandDefinition[],
  locale: Locale,
): CommandSuggestion[] {
  const m = /^\/([a-z0-9_]*)$/i.exec(input);
  if (!m) return [];
  const prefix = m[1]!.toLowerCase();
  const out: CommandSuggestion[] = [];
  for (const d of defs) {
    if (!d.enabled) continue;
    const hit = [d.name, ...d.aliases].find((n) => n.startsWith(prefix));
    if (hit === undefined) continue;
    out.push({
      name: d.name,
      ...(hit !== d.name && { matchedAs: hit }),
      description: describeCommand(d, locale),
    });
  }
  return out;
}
