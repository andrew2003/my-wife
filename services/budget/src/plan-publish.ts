import { randomUUID } from "node:crypto";
import type { EventEnvelope, PlannedItem } from "@my-wife/contracts";
import type { SampleBudgetStore } from "./onboarding";
import { weekIndexOf } from "./overspend";
import { issuePlannedCode } from "./transfer-codes";

/** Body of `POST /budget/weekly-plan`; contracts have no request schema for it yet. */
export interface PublishWeeklyPlanRequest {
  weekIndex: number;
  items: { categoryId: string; amountVnd: number }[];
}

/** Validates an untrusted body; money must be a non-negative safe integer (VND). */
export function parsePublishWeeklyPlanRequest(body: unknown): PublishWeeklyPlanRequest | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { weekIndex, items } = body as Record<string, unknown>;
  if (typeof weekIndex !== "number" || !Number.isSafeInteger(weekIndex) || weekIndex < 1) {
    return undefined;
  }
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const out: PublishWeeklyPlanRequest["items"] = [];
  for (const item of items as unknown[]) {
    if (typeof item !== "object" || item === null) return undefined;
    const { categoryId, amountVnd } = item as Record<string, unknown>;
    if (typeof categoryId !== "string" || categoryId === "") return undefined;
    if (typeof amountVnd !== "number" || !Number.isSafeInteger(amountVnd) || amountVnd < 0) {
      return undefined;
    }
    out.push({ categoryId, amountVnd });
  }
  return { weekIndex, items: out };
}

export type PublishPlanErrorCode =
  | "invalid_request"
  | "budget.cycle_not_found"
  | "budget.cycle_not_running"
  | "budget.category_not_found"
  | "budget.week_already_published";

export type PublishPlanResult =
  | { ok: true; data: { cycleId: string; weekIndex: number; items: PlannedItem[] } }
  | { ok: false; error: { code: PublishPlanErrorCode } };

export interface PlanPublishDeps {
  store: SampleBudgetStore;
  now: () => Date;
  publish: (event: EventEnvelope) => void | Promise<void>;
  newId?: () => string;
}

/**
 * Publishes the planned items of one week into the budget record. Budget issues the item
 * numbers and transfer codes (`MW-C<seq>W<week>-<category>-<nn>`) so a receipt can reconcile
 * against them; a week is published once. Announces `plan.week_published` afterwards.
 */
export function createPlanPublisher(deps: PlanPublishDeps) {
  const newId = deps.newId ?? randomUUID;
  return async function publishWeeklyPlan(
    input: { userId: string } & PublishWeeklyPlanRequest,
  ): Promise<PublishPlanResult> {
    const parsed = parsePublishWeeklyPlanRequest(input);
    if (!parsed) return { ok: false, error: { code: "invalid_request" } };
    const { weekIndex, items } = parsed;
    const record = await deps.store.find(input.userId);
    if (!record) return { ok: false, error: { code: "budget.cycle_not_found" } };
    if (record.cycle.state !== "running") {
      return { ok: false, error: { code: "budget.cycle_not_running" } };
    }
    if (record.publishedPlanWeeks.includes(weekIndex)) {
      return { ok: false, error: { code: "budget.week_already_published" } };
    }

    const codes = record.plannedItems.map((i) => i.transferCode);
    const built: PlannedItem[] = [];
    for (const item of items) {
      const category = record.categories.find((c) => c.id === item.categoryId);
      if (!category || category.priority === "fund") {
        return { ok: false, error: { code: "budget.category_not_found" } };
      }
      const transferCode = issuePlannedCode(
        {
          cycleSequence: record.cycle.sequence,
          weekIndex,
          categoryShortCode: category.shortCode,
          priority: category.priority,
        },
        codes,
      );
      codes.push(transferCode);
      built.push({
        id: newId(),
        categoryId: category.id,
        number: Number(transferCode.slice(transferCode.lastIndexOf("-") + 1)),
        amountVnd: item.amountVnd,
        transferCode,
        status: "planned",
      });
    }

    const at = deps.now();
    const stored = await deps.store.publishWeeklyPlan(
      input.userId,
      record.cycle.id,
      weekIndex,
      built,
      at,
    );
    if (stored === "already_published") {
      return { ok: false, error: { code: "budget.week_already_published" } };
    }
    if (stored === "not_running") {
      return { ok: false, error: { code: "budget.cycle_not_running" } };
    }
    await deps.publish({
      id: `plan-week-published-${record.cycle.id}-${weekIndex}`,
      type: "plan.week_published",
      occurredAt: at.toISOString(),
      userId: input.userId,
      schemaVersion: 1,
      payload: { cycleId: record.cycle.id, weekIndex },
    } as EventEnvelope);
    return { ok: true, data: { cycleId: record.cycle.id, weekIndex, items: built } };
  };
}

/**
 * Handles `week.planned` (ADR 0013): publishes the items the user approved with the week.
 * The week index comes from the cycle's first day; anything that does not fit (no items,
 * no running cycle, a week outside the cycle, an invalid item, a repeated week) is ignored,
 * so redelivery is safe and a bad payload never blocks the consumer.
 */
export function createWeekPlannedHandler(deps: PlanPublishDeps) {
  const publishPlan = createPlanPublisher(deps);
  return async function onWeekPlanned(event: EventEnvelope): Promise<void> {
    if (event.type !== "week.planned") return;
    const { firstDay, plannedItems } = (event as EventEnvelope<"week.planned">).payload;
    if (!plannedItems || plannedItems.length === 0) return;
    const record = await deps.store.find(event.userId);
    if (!record || record.cycle.state !== "running") return;
    const weekIndex = weekIndexOf(record.cycle.firstDay, firstDay);
    if (weekIndex === undefined || weekIndex > record.cycle.weeks) return;
    // Business refusals (unknown category, repeated week, ...) are dropped on purpose.
    await publishPlan({ userId: event.userId, weekIndex, items: plannedItems });
  };
}
