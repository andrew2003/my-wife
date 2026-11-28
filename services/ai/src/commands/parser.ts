import { COMMAND_NAME_PATTERN } from "@my-wife/contracts";

export interface ParsedCommand {
  name: string;
  args: string[];
}

/**
 * Parses a message that starts with `/`. Returns null for anything else, so ordinary text and
 * text inside forwarded content is never treated as a command. A Telegram `@bot` suffix is
 * dropped and the name is lowercased.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [head = "", ...args] = trimmed.slice(1).split(/\s+/);
  const name = head.split("@")[0]!.toLowerCase();
  if (!COMMAND_NAME_PATTERN.test(name)) return null;
  return { name, args };
}
