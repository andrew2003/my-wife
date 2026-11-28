import type { CommandSettings, CustomCommandInput } from "@my-wife/contracts";
import {
  buildRegistry,
  CommandRegistryError,
  CUSTOM_ID_PREFIX,
  type CommandRegistry,
} from "./registry";

export interface CustomCommandStore {
  load(userId: string): Promise<CommandSettings>;
  save(userId: string, settings: CommandSettings): Promise<void>;
  /** The `chat.max_custom_commands` value for this user. */
  maxCustom(userId: string): Promise<number>;
}

/**
 * Creates, tries and deletes a user's custom commands. Every change is checked by building the
 * registry first (duplicate names and aliases, shortcut loops, unknown targets, the custom
 * command limit), so an invalid change throws a `CommandRegistryError` and nothing is saved.
 */
export class CustomCommandManager {
  constructor(private readonly store: CustomCommandStore) {}

  async registry(userId: string): Promise<CommandRegistry> {
    return buildRegistry(await this.store.load(userId), await this.store.maxCustom(userId));
  }

  /** Validates a new command against the user's registry without saving it. */
  async tryOut(userId: string, input: CustomCommandInput): Promise<CommandRegistry> {
    const next = await this.withInput(userId, input);
    return buildRegistry(next, await this.store.maxCustom(userId));
  }

  async create(userId: string, input: CustomCommandInput): Promise<CommandRegistry> {
    const next = await this.withInput(userId, input);
    const registry = buildRegistry(next, await this.store.maxCustom(userId));
    await this.store.save(userId, next);
    return registry;
  }

  /** Deletes by name; refused when a shortcut still points at the command. */
  async remove(userId: string, name: string): Promise<CommandRegistry> {
    const settings = await this.store.load(userId);
    if (!settings.custom.some((c) => c.name === name))
      throw new CommandRegistryError("unknown_command", `${CUSTOM_ID_PREFIX}${name}`);
    const next = { ...settings, custom: settings.custom.filter((c) => c.name !== name) };
    const registry = buildRegistry(next, await this.store.maxCustom(userId));
    await this.store.save(userId, next);
    return registry;
  }

  private async withInput(userId: string, input: CustomCommandInput): Promise<CommandSettings> {
    const settings = await this.store.load(userId);
    return { ...settings, custom: [...settings.custom, input] };
  }
}
