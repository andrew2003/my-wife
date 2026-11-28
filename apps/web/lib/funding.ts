import { BudgetCycleSchema } from "@my-wife/contracts";
import qrcode from "qrcode-generator";
import { z } from "zod";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * One bank account of the cycle funding list. `memo` is the transfer code budget issued
 * (`cycle.funds_requested`); `funded` turns true once a verified receipt covers `requiredVnd`.
 */
export const FundingAccountSchema = z.object({
  bankAccountId: z.string().min(1),
  name: z.string().min(1),
  code: z.string().min(1),
  requiredVnd: z.number().int().nonnegative(),
  memo: z.string().min(1),
  funded: z.boolean(),
});
export type FundingAccount = z.infer<typeof FundingAccountSchema>;

const FundingResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ cycle: BudgetCycleSchema, accounts: z.array(FundingAccountSchema) }),
});

export type FundingResult =
  { status: "ready"; accounts: FundingAccount[] } | { status: "empty" } | { status: "error" };

/** Reads the funding list of the cycle that waits for money through the gateway. */
export async function loadFunding(doFetch: FetchLike = fetch): Promise<FundingResult> {
  try {
    const res = await doFetch("/api/budget/funding", { cache: "no-store" });
    // No cycle is waiting for funds.
    if (res.status === 404) return { status: "empty" };
    if (!res.ok) return { status: "error" };
    const parsed = FundingResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { status: "error" };
    if (parsed.data.data.cycle.state !== "awaiting_funds") return { status: "empty" };
    return { status: "ready", accounts: parsed.data.data.accounts };
  } catch {
    return { status: "error" };
  }
}

/** Reads the transfer list of the current cycle in any state (the budget page shows it too). */
export async function loadTransferList(doFetch: FetchLike = fetch): Promise<FundingResult> {
  try {
    const res = await doFetch("/api/budget/funding", { cache: "no-store" });
    if (res.status === 404) return { status: "empty" };
    if (!res.ok) return { status: "error" };
    const parsed = FundingResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { status: "error" };
    if (parsed.data.data.accounts.length === 0) return { status: "empty" };
    return { status: "ready", accounts: parsed.data.data.accounts };
  } catch {
    return { status: "error" };
  }
}

/**
 * Text the QR image carries. Bank account numbers are not part of the contracts, so this is
 * the plain transfer request (account code, amount, memo), not a bank-specific QR standard.
 */
export function buildTransferQrPayload(account: FundingAccount): string {
  return [`account:${account.code}`, `amount:${account.requiredVnd}`, `memo:${account.memo}`].join(
    "\n",
  );
}

/** Renders a payload as a QR image data URL (generated in the browser, nothing is sent out). */
export function qrDataUrl(payload: string): string {
  const qr = qrcode(0, "M");
  qr.addData(payload);
  qr.make();
  return qr.createDataURL(6, 8);
}
