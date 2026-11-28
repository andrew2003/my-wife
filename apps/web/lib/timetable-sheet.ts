import { CellRejectReasonSchema } from "@my-wife/contracts";
import { z } from "zod";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// The sheet read has no contract schema yet, so this local shape mirrors `buildSheet` in the
// schedule service. Which cells are editable is decided there; the screen only follows it.
const CellSchema = z.object({
  field: z.string(),
  value: z.union([z.string(), z.number(), z.null()]),
  editable: z.boolean(),
});
const SheetSchema = z.object({
  week: z.object({ id: z.string(), firstDay: z.string(), state: z.string() }),
  readOnly: z.boolean(),
  rows: z.array(z.object({ entityId: z.string(), cells: z.array(CellSchema) })),
  computed: z.object({ plannedMinutes: z.number().int() }),
});
export type Sheet = z.infer<typeof SheetSchema>;
export type SheetCell = z.infer<typeof CellSchema>;

const SheetEnvelope = z.object({ ok: z.literal(true), data: SheetSchema });
const EditEnvelope = z.object({
  ok: z.literal(true),
  data: z.object({
    status: z.enum(["applied", "rejected"]),
    reason: CellRejectReasonSchema.optional(),
  }),
});

export type SheetResult =
  { status: "ready"; sheet: Sheet } | { status: "empty" } | { status: "error" };

export type SaveResult = { ok: true } | { ok: false; errorKey: string };

/** Reads the timetable sheet of a week (the latest week when no id is given). */
export async function loadSheet(
  weekId: string | undefined,
  doFetch: FetchLike = fetch,
): Promise<SheetResult> {
  try {
    const query = weekId ? `?weekId=${encodeURIComponent(weekId)}` : "";
    const res = await doFetch(`/api/timetable-sheet${query}`, { cache: "no-store" });
    if (res.status === 404) return { status: "empty" };
    if (!res.ok) return { status: "error" };
    const parsed = SheetEnvelope.safeParse(await res.json());
    if (!parsed.success) return { status: "error" };
    return parsed.data.data.rows.length === 0
      ? { status: "empty" }
      : { status: "ready", sheet: parsed.data.data };
  } catch {
    return { status: "error" };
  }
}

/** Turns the typed text into the value type of the field. */
export function cellValue(field: string, text: string): string | number {
  return field === "estimatedMinutes" ? (text.trim() === "" ? NaN : Number(text)) : text;
}

/** Writes one editable cell; the service validates it and may reject it. */
export async function saveCell(
  entityId: string,
  field: string,
  value: string | number,
  doFetch: FetchLike = fetch,
): Promise<SaveResult> {
  try {
    const res = await doFetch("/api/timetable-sheet/cells", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // NaN serialises to null, which the service rejects as invalid.
      body: JSON.stringify({
        sheet: "timetable",
        tab: "tasks",
        cellRef: field,
        entityId,
        field,
        value,
      }),
    });
    if (!res.ok) return { ok: false, errorKey: "sheet.error.save" };
    const parsed = EditEnvelope.safeParse(await res.json());
    if (!parsed.success) return { ok: false, errorKey: "sheet.error.save" };
    if (parsed.data.data.status === "applied") return { ok: true };
    return {
      ok: false,
      errorKey: `sheet.reject.${parsed.data.data.reason ?? "validation_failed"}`,
    };
  } catch {
    return { ok: false, errorKey: "sheet.error.save" };
  }
}
