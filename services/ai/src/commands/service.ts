import {
  CommandSettingsSchema,
  MoodTagSchema,
  commandEvents,
  SETTINGS,
  type CommandChannel,
  type CommandResult,
  type CommandResultStatus,
  type CommandSettings,
  type Locale,
  type MoodTag,
  type MessageRef,
} from "@my-wife/contracts";
import { renderMessage } from "../i18n";
import { CAPTURE_HANDLERS, type CapturePorts } from "./capture";
import { parseCommand } from "./parser";
import { RULES_HANDLERS, type RulesPorts } from "./rules";
import { runSummary, SUMMARY_SCOPES, type SummaryPorts, type SummaryScope } from "./summary";
import { buildRegistry, type CommandRegistry, type RegistryEntry } from "./registry";

const STRICT_MIN = 1;
const STRICT_MAX = 5;
const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface StatusFacts {
  cycleSequence: number;
  weekIndex: number;
  tasksDone: number;
  tasksTotal: number;
  faultPoints: number;
  syncLinks: { link: string; state: string }[];
  degraded: boolean;
}

export interface UsageFacts {
  usedToday: number;
  cap: number;
  /** Provider quota text when the provider reports it. */
  quota?: string;
}

/** What the control commands act on. Each port is a thin wrapper over another service. */
export interface ControlPorts {
  setLocale(userId: string, locale: Locale): Promise<void>;
  setStrictness(userId: string, level: number): Promise<void>;
  /** `until` is an `HH:MM` clock time; null clears quiet mode. */
  setQuiet(userId: string, until: string | null): Promise<void>;
  resetConversation(userId: string): Promise<void>;
  stop(userId: string): Promise<void>;
  skins(userId: string): Promise<{ current: string; available: string[] }>;
  setSkin(userId: string, skin: string): Promise<void>;
  currentModel(userId: string): Promise<string>;
  usage(userId: string): Promise<UsageFacts>;
  status(userId: string): Promise<StatusFacts>;
}

type PublishedEvent = { name: "command.executed" | "command.refused"; payload: unknown };

/** What a custom prompt command sends to the model. */
export interface PromptRequest {
  command: { name: string; description: string };
  /** The template with `{text}` filled from the typed arguments. */
  text: string;
  locale: Locale;
  /** Set by a mood tag: stored with the message and shapes the reply only. */
  mood?: MoodTag;
}

export interface CommandServiceDeps {
  /** Runs a custom prompt command through the chat model; the reply is text or a message ref. */
  runPrompt?: (userId: string, req: PromptRequest) => Promise<MessageRef | { text: string }>;
  ports: ControlPorts;
  /** Backs `/task`, `/spend`, `/remember` and `/forget`; without it they answer not available. */
  capture?: CapturePorts;
  /** Backs `/summary`, `/today`, `/week` and `/budget` with read routes. */
  summary?: SummaryPorts;
  /** Backs `/appeal` and `/reason` with the rules routes. */
  rules?: RulesPorts;
  /** The clock, a parameter so tests can simulate time. */
  now?: () => Date;
  /** The user's overrides and custom commands. */
  loadCommandSettings: (userId: string) => Promise<CommandSettings>;
  readSettings: (userId: string) => Promise<Record<string, unknown>>;
  publish: (event: PublishedEvent) => Promise<void>;
}

export interface CommandRequest {
  channel: CommandChannel;
  userId: string;
  /** Untrusted message text; only its first token is ever read as a command. */
  text: string;
  locale: Locale;
}

type RefusalReason = "disabled" | "invalid_args" | "needs_confirmation" | "not_allowed";
interface Outcome {
  status: CommandResultStatus;
  reply: MessageRef;
  reason?: RefusalReason;
}

const ok = (key: string, params: MessageRef["params"] = {}): Outcome => ({
  status: "ok",
  reply: { key, params },
});
const invalid = (key: string, params: MessageRef["params"] = {}): Outcome => ({
  status: "refused",
  reply: { key, params },
  reason: "invalid_args",
});

interface Context {
  userId: string;
  locale: Locale;
  args: string[];
  registry: CommandRegistry;
  ports: ControlPorts;
}

type Handler = (ctx: Context) => Promise<Outcome>;

function describe(entry: RegistryEntry, locale: Locale): string {
  const { def } = entry;
  if (def.description) return def.description[locale];
  return renderMessage({ key: def.descriptionKey ?? "", params: {} }, locale);
}

const HANDLERS: Record<string, Handler> = {
  async help({ registry, locale }) {
    const list = registry
      .list()
      .filter((e) => e.def.enabled)
      .map((e) => `/${e.def.name} - ${describe(e, locale)}`)
      .join("\n");
    return ok("commands.help", { list });
  },
  async status({ ports, userId }) {
    const s = await ports.status(userId);
    return ok("commands.status", {
      cycle: s.cycleSequence,
      week: s.weekIndex,
      tasks: `${s.tasksDone}/${s.tasksTotal}`,
      faultPoints: s.faultPoints,
      sync: s.syncLinks.map((l) => `${l.link}: ${l.state}`).join(", ") || "-",
      degraded: s.degraded,
    });
  },
  async usage({ ports, userId }) {
    const u = await ports.usage(userId);
    return ok(u.quota ? "commands.usage_quota" : "commands.usage", {
      used: u.usedToday,
      cap: u.cap,
      quota: u.quota ?? "",
    });
  },
  async new({ ports, userId }) {
    await ports.resetConversation(userId);
    return ok("commands.new");
  },
  async stop({ ports, userId }) {
    await ports.stop(userId);
    return ok("commands.stop");
  },
  async lang({ ports, userId, args }) {
    const [choice] = args;
    if (args.length !== 1 || (choice !== "vi" && choice !== "en"))
      return invalid("commands.lang.usage");
    await ports.setLocale(userId, choice);
    return ok("commands.lang.changed", { language: choice });
  },
  async strict({ ports, userId, args }) {
    const level = Number(args[0]);
    if (args.length !== 1 || !Number.isInteger(level) || level < STRICT_MIN || level > STRICT_MAX)
      return invalid("commands.strict.usage", { min: STRICT_MIN, max: STRICT_MAX });
    await ports.setStrictness(userId, level);
    return ok("commands.strict.changed", { level });
  },
  async quiet({ ports, userId, args }) {
    if (args.length === 1 && args[0] === "off") {
      await ports.setQuiet(userId, null);
      return ok("commands.quiet.off");
    }
    const until = args[1];
    if (args.length === 2 && args[0] === "until" && until && CLOCK_PATTERN.test(until)) {
      await ports.setQuiet(userId, until);
      return ok("commands.quiet.until", { until });
    }
    return invalid("commands.quiet.usage");
  },
  async skin({ ports, userId, args }) {
    const skins = await ports.skins(userId);
    if (args.length === 0)
      return ok("commands.skin.list", {
        current: skins.current,
        available: skins.available.join(", "),
      });
    const [choice] = args;
    if (args.length !== 1 || !choice || !skins.available.includes(choice))
      return invalid("commands.skin.unknown", { available: skins.available.join(", ") });
    await ports.setSkin(userId, choice);
    return ok("commands.skin.changed", { skin: choice });
  },
  async model({ ports, userId, args }) {
    if (args.length === 0)
      return ok("commands.model.current", { model: await ports.currentModel(userId) });
    const [model] = args;
    if (args.length !== 1 || !model) return invalid("commands.model.usage");
    // The switch runs the handover test and needs the user's confirmation first.
    return {
      status: "needs_confirmation",
      reply: { key: "commands.model.confirm", params: { model } },
      reason: "needs_confirmation",
    };
  },
};

/**
 * Parses and runs chat commands for every channel. Code decides everything here: the model is
 * never involved in the control commands, and a command arriving as forwarded content is never
 * parsed because adapters only pass the user's own messages.
 */
export class CommandService {
  constructor(private readonly deps: CommandServiceDeps) {}

  private async maxCustom(userId: string): Promise<number> {
    const def = SETTINGS["chat.max_custom_commands"];
    try {
      const values = await this.deps.readSettings(userId);
      const parsed = def.schema.safeParse(values["chat.max_custom_commands"]);
      return parsed.success ? parsed.data : def.default;
    } catch {
      return def.default;
    }
  }

  /** Returns null when the text is not a command, so the caller treats it as chat. */
  async handle(req: CommandRequest): Promise<CommandResult | null> {
    const parsed = parseCommand(req.text);
    if (!parsed) return null;
    let registry: CommandRegistry;
    try {
      const settings = CommandSettingsSchema.parse(await this.deps.loadCommandSettings(req.userId));
      registry = buildRegistry(settings, await this.maxCustom(req.userId));
    } catch {
      return { status: "refused", reply: { key: "commands.registry_invalid", params: {} } };
    }
    const entry = registry.resolve(parsed.name);
    if (!entry) return { status: "unknown", reply: { key: "commands.unknown", params: {} } };

    // A shortcut runs its target with the preset arguments in front of the typed ones.
    let target = entry;
    let args = parsed.args;
    while (target.custom?.kind === "shortcut") {
      args = [...target.custom.presetArgs, ...args];
      const next = registry.get(target.custom.targetCommandId);
      if (!next) break;
      target = next;
    }
    const commandId = entry.def.id;
    if (!entry.def.enabled || !target.def.enabled) {
      await this.announce(req, commandId, entry.def.ai, "disabled", "disabled");
      return { status: "disabled", reply: { key: "commands.disabled", params: {} } };
    }
    const handler = target.def.builtin ? HANDLERS[target.def.id] : undefined;
    const capture = target.def.builtin ? CAPTURE_HANDLERS[target.def.id] : undefined;
    const scope = SUMMARY_SCOPES.find((s) => s === target.def.id);
    const rulesHandler = target.def.builtin ? RULES_HANDLERS[target.def.id] : undefined;
    const now = (this.deps.now ?? (() => new Date()))();
    const mood = target.def.builtin ? MoodTagSchema.safeParse(target.def.id) : null;
    const outcome: Outcome = target.custom
      ? await this.runCustom(target, args, req)
      : mood?.success
        ? await this.runMood(mood.data, target, args, req)
        : capture
          ? await capture({ userId: req.userId, args, capture: this.deps.capture, now })
          : scope && target.def.builtin
            ? await this.runSummaryCommand(scope, target, req, now)
            : rulesHandler
              ? await rulesHandler({ userId: req.userId, args, rules: this.deps.rules })
              : handler
                ? await handler({
                    userId: req.userId,
                    locale: req.locale,
                    args,
                    registry,
                    ports: this.deps.ports,
                  })
                : {
                    status: "refused",
                    reply: { key: "commands.not_available", params: {} },
                    reason: "not_allowed",
                  };
    await this.announce(req, commandId, entry.def.ai, outcome.status, outcome.reason);
    return { status: outcome.status, reply: outcome.reply };
  }

  private runSummaryCommand(
    scope: SummaryScope,
    target: RegistryEntry,
    req: CommandRequest,
    now: Date,
  ): Promise<Outcome> {
    const { runPrompt } = this.deps;
    const command = { name: target.def.name, description: describe(target, req.locale) };
    return runSummary({
      userId: req.userId,
      locale: req.locale,
      scope,
      summary: this.deps.summary,
      now,
      command,
      ...(runPrompt
        ? {
            runPrompt: (text: string) =>
              runPrompt(req.userId, { command, text, locale: req.locale }),
          }
        : {}),
    });
  }

  /** `/angry <message>`: the message goes to the model with the mood; nothing else is touched. */
  private async runMood(
    mood: MoodTag,
    target: RegistryEntry,
    args: string[],
    req: CommandRequest,
  ): Promise<Outcome> {
    const { runPrompt } = this.deps;
    if (!runPrompt)
      return {
        status: "refused",
        reply: { key: "commands.not_available", params: {} },
        reason: "not_allowed",
      };
    const typed = args.join(" ");
    if (typed.length === 0) return invalid("commands.mood.usage", { name: target.def.name });
    const reply = await runPrompt(req.userId, {
      command: { name: target.def.name, description: describe(target, req.locale) },
      text: typed,
      locale: req.locale,
      mood,
    });
    if ("text" in reply) return ok("commands.prompt_reply", { text: reply.text });
    return { status: "refused", reply, reason: "not_allowed" };
  }

  private async runCustom(
    target: RegistryEntry,
    args: string[],
    req: CommandRequest,
  ): Promise<Outcome> {
    const custom = target.custom;
    if (custom?.kind === "mood")
      return ok("commands.mood.noted", { expression: custom.expressionKey });
    if (custom?.kind !== "prompt" || !this.deps.runPrompt)
      return {
        status: "refused",
        reply: { key: "commands.not_available", params: {} },
        reason: "not_allowed",
      };
    const typed = args.join(" ");
    if (typed.length === 0) return invalid("commands.prompt.usage", { name: target.def.name });
    const reply = await this.deps.runPrompt(req.userId, {
      command: { name: target.def.name, description: describe(target, req.locale) },
      text: custom.template.split("{text}").join(typed),
      locale: req.locale,
    });
    if ("text" in reply) return ok("commands.prompt_reply", { text: reply.text });
    return { status: "refused", reply, reason: "not_allowed" };
  }

  /** Events carry ids and statuses only, never the message text. */
  private async announce(
    req: CommandRequest,
    commandId: string,
    ai: boolean,
    status: CommandResultStatus,
    reason?: RefusalReason,
  ): Promise<void> {
    try {
      if (status === "ok" || status === "needs_confirmation") {
        await this.deps.publish({
          name: "command.executed",
          payload: commandEvents["command.executed"].parse({
            commandId,
            channel: req.channel,
            status,
            ai,
          }),
        });
      } else if (reason) {
        await this.deps.publish({
          name: "command.refused",
          payload: commandEvents["command.refused"].parse({
            commandId,
            channel: req.channel,
            reason,
          }),
        });
      }
    } catch {
      // An event failure must never cost the user a reply.
    }
  }
}
