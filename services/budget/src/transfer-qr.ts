/**
 * Transfer QR payloads (spec 10-budget.md section 3 and 5). Pure, no I/O.
 *
 * Builds a dynamic VietQR (NAPAS, EMVCo merchant-presented) string that encodes the receiving
 * bank, the account, the amount in integer VND and the transfer code as the transfer memo.
 * The bot never moves money; the user scans the QR in the banking app.
 */

export interface TransferQrInput {
  /** NAPAS bank identification number, six digits. */
  bankBin: string;
  accountNumber: string;
  amountVnd: number;
  /** The transfer code, for example `MW-C07W2-AN-02`. */
  memo: string;
}

export interface TransferQrOptions {
  /** Longest memo accepted; banks truncate longer ones. Default 25. */
  maxMemoLength?: number;
  /** VietQR service code: `QRIBFTTA` transfers to an account, `QRIBFTTC` to a card. */
  serviceCode?: string;
}

export const DEFAULT_QR_MAX_MEMO_LENGTH = 25;
export const DEFAULT_QR_SERVICE_CODE = "QRIBFTTA";
const NAPAS_GUID = "A000000727";
const VND_CURRENCY_CODE = "704";

function tlv(tag: string, value: string): string {
  if (value.length > 99) throw new RangeError(`tag ${tag} value is too long`);
  return `${tag}${String(value.length).padStart(2, "0")}${value}`;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) as four uppercase hex digits. */
export function crc16Ccitt(text: string): string {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i += 1) {
    crc ^= text.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** Splits one TLV level into a tag to value map (used by tests and readers). */
export function parseTlv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < text.length) {
    const tag = text.slice(i, i + 2);
    const length = Number(text.slice(i + 2, i + 4));
    if (!Number.isInteger(length)) throw new RangeError("malformed TLV");
    out[tag] = text.slice(i + 4, i + 4 + length);
    i += 4 + length;
  }
  return out;
}

export function buildTransferQr(input: TransferQrInput, options: TransferQrOptions = {}): string {
  const maxMemo = options.maxMemoLength ?? DEFAULT_QR_MAX_MEMO_LENGTH;
  if (!Number.isSafeInteger(input.amountVnd) || input.amountVnd < 1) {
    throw new RangeError("amountVnd must be a positive integer");
  }
  if (!/^\d{6}$/.test(input.bankBin)) throw new RangeError("bankBin must be six digits");
  if (!/^\d{1,19}$/.test(input.accountNumber)) {
    throw new RangeError("accountNumber must be 1 to 19 digits");
  }
  if (!/^[\x20-\x7e]+$/.test(input.memo) || input.memo.length > maxMemo) {
    throw new RangeError(`memo must be printable ASCII of at most ${maxMemo} characters`);
  }
  const beneficiary = tlv("00", input.bankBin) + tlv("01", input.accountNumber);
  const account =
    tlv("00", NAPAS_GUID) +
    tlv("01", beneficiary) +
    tlv("02", options.serviceCode ?? DEFAULT_QR_SERVICE_CODE);
  const body =
    tlv("00", "01") +
    tlv("01", "12") +
    tlv("38", account) +
    tlv("53", VND_CURRENCY_CODE) +
    tlv("54", String(input.amountVnd)) +
    tlv("58", "VN") +
    tlv("62", tlv("08", input.memo)) +
    "6304";
  return body + crc16Ccitt(body);
}
