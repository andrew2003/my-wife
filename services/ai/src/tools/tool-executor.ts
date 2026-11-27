import {
  AI_TOOL_NAMES,
  AI_TOOLS_REQUIRING_CONFIRM,
  AiToolCallSchema,
  type AiToolCall,
} from "@my-wife/contracts";
import type { AuditLog, ToolOutcome } from "./audit-log";

type Args<T extends AiToolCall["tool"]> = Extract<AiToolCall, { tool: T }>["args"];

/**
 * Thin wrappers over other services' REST APIs. A missing backend means the tool is not wired
 * yet; the call fails and is audited. There is deliberately no backend for penalties or money
 * movement: the tool set is closed by the contracts enum.
 */
export interface ToolBackends {
  recordCashExpense?: (userId: string, args: Args<"record_cash_expense">) => Promise<unknown>;
  createTask?: (userId: string, args: Args<"create_task">) => Promise<unknown>;
  answerQuestion?: (userId: string, args: Args<"answer_question">) => Promise<unknown>;
  askReason?: (userId: string, args: Args<"ask_reason">) => Promise<unknown>;
  readStatus?: (userId: string, args: Args<"read_status">) => Promise<unknown>;
}

export type ToolResult =
  | { status: "ok"; data: unknown }
  | { status: "needs_confirmation"; tool: AiToolCall["tool"]; args: unknown }
  | { status: "rejected" }
  | { status: "error" };

export interface ToolExecutorDeps {
  audit: AuditLog;
  backends: ToolBackends;
  now: () => Date;
}

export function listToolNames(): readonly string[] {
  return AI_TOOL_NAMES;
}

const CONFIRM = new Set<string>(AI_TOOLS_REQUIRING_CONFIRM);

export class ToolExecutor {
  constructor(private readonly deps: ToolExecutorDeps) {}

  /** Validates a model-proposed call against the contracts, runs it, and always audits it. */
  async execute(userId: string, raw: { tool: string; args: unknown }): Promise<ToolResult> {
    const parsed = AiToolCallSchema.safeParse(raw);
    if (!parsed.success) {
      await this.log(userId, String(raw.tool), "rejected");
      return { status: "rejected" };
    }
    const call = parsed.data;
    if (CONFIRM.has(call.tool)) {
      await this.log(userId, call.tool, "proposed", call.args);
      return { status: "needs_confirmation", tool: call.tool, args: call.args };
    }
    try {
      const data = await this.dispatch(userId, call);
      await this.log(userId, call.tool, "executed", call.args);
      return { status: "ok", data };
    } catch {
      await this.log(userId, call.tool, "failed", call.args);
      return { status: "error" };
    }
  }

  private dispatch(userId: string, call: AiToolCall): Promise<unknown> {
    const b = this.deps.backends;
    const missing = () => Promise.reject(new Error("tool backend not wired"));
    switch (call.tool) {
      case "record_cash_expense":
        return b.recordCashExpense?.(userId, call.args) ?? missing();
      case "create_task":
        return b.createTask?.(userId, call.args) ?? missing();
      case "answer_question":
        return b.answerQuestion?.(userId, call.args) ?? missing();
      case "ask_reason":
        return b.askReason?.(userId, call.args) ?? missing();
      case "read_status":
        return b.readStatus?.(userId, call.args) ?? missing();
      default:
        return missing();
    }
  }

  private async log(userId: string, tool: string, outcome: ToolOutcome, args?: unknown) {
    await this.deps.audit.append({ userId, tool, outcome, args, at: this.deps.now() });
  }
}
