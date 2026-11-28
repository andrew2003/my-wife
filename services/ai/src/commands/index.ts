export { BUILTIN_COMMANDS } from "./builtins";
export { parseCommand, type ParsedCommand } from "./parser";
export {
  buildRegistry,
  CommandRegistry,
  CommandRegistryError,
  type CommandRegistryErrorCode,
  type RegistryEntry,
} from "./registry";
export { CustomCommandManager, type CustomCommandStore } from "./custom";
export {
  CommandService,
  type PromptRequest,
  type CommandRequest,
  type CommandServiceDeps,
  type ControlPorts,
  type StatusFacts,
  type UsageFacts,
} from "./service";
