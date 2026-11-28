import type { CommandDefinition, CommandSettings, CustomCommandInput } from "@my-wife/contracts";
import { BUILTIN_COMMANDS } from "./builtins";

export type CommandRegistryErrorCode =
  "duplicate_name" | "shortcut_loop" | "unknown_target" | "unknown_command" | "too_many_custom";

export class CommandRegistryError extends Error {
  constructor(
    readonly code: CommandRegistryErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "CommandRegistryError";
  }
}

export interface RegistryEntry {
  def: CommandDefinition;
  /** Present for custom commands; carries the template, expression key or shortcut target. */
  custom?: CustomCommandInput;
}

export const CUSTOM_ID_PREFIX = "custom:";

export class CommandRegistry {
  constructor(
    private readonly byName: ReadonlyMap<string, RegistryEntry>,
    private readonly byId: ReadonlyMap<string, RegistryEntry>,
  ) {}

  /** Looks up a name or alias. */
  resolve(name: string): RegistryEntry | undefined {
    return this.byName.get(name);
  }

  get(id: string): RegistryEntry | undefined {
    return this.byId.get(id);
  }

  list(): RegistryEntry[] {
    return [...this.byId.values()];
  }
}

/**
 * Builds the per-user registry from the shipped built-ins and the user's settings. Throws a
 * `CommandRegistryError` for duplicate names or aliases, shortcut loops, unknown targets and
 * more custom commands than `maxCustom` (`chat.max_custom_commands`).
 */
export function buildRegistry(settings: CommandSettings, maxCustom: number): CommandRegistry {
  if (settings.custom.length > maxCustom)
    throw new CommandRegistryError("too_many_custom", `${settings.custom.length} > ${maxCustom}`);

  const byId = new Map<string, RegistryEntry>();
  for (const base of BUILTIN_COMMANDS) byId.set(base.id, { def: { ...base } });

  for (const o of settings.overrides) {
    const entry = byId.get(o.commandId);
    if (!entry) throw new CommandRegistryError("unknown_command", o.commandId);
    entry.def = {
      ...entry.def,
      ...(o.enabled !== undefined && { enabled: o.enabled }),
      ...(o.name !== undefined && { name: o.name }),
      ...(o.aliases !== undefined && { aliases: o.aliases }),
      ...(o.description !== undefined && { description: o.description }),
    };
  }

  for (const c of settings.custom) {
    const id = `${CUSTOM_ID_PREFIX}${c.name}`;
    if (byId.has(id)) throw new CommandRegistryError("duplicate_name", c.name);
    byId.set(id, {
      custom: c,
      def: {
        id,
        kind: c.kind,
        name: c.name,
        aliases: c.aliases,
        description: c.description,
        enabled: c.enabled,
        ai: c.kind === "prompt",
        builtin: false,
        args: [],
      },
    });
  }

  const byName = new Map<string, RegistryEntry>();
  for (const entry of byId.values()) {
    const names = [entry.def.name, ...entry.def.aliases];
    if (new Set(names).size !== names.length)
      throw new CommandRegistryError("duplicate_name", entry.def.id);
    for (const name of names) {
      if (byName.has(name)) throw new CommandRegistryError("duplicate_name", name);
      byName.set(name, entry);
    }
  }

  for (const entry of byId.values()) {
    const seen = new Set<string>([entry.def.id]);
    let at: RegistryEntry = entry;
    while (at.custom?.kind === "shortcut") {
      const next = byId.get(at.custom.targetCommandId);
      if (!next) throw new CommandRegistryError("unknown_target", at.custom.targetCommandId);
      if (seen.has(next.def.id)) throw new CommandRegistryError("shortcut_loop", entry.def.id);
      seen.add(next.def.id);
      at = next;
    }
  }
  return new CommandRegistry(byName, byId);
}
