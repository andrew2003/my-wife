import { describe, expect, it } from "vitest";
import { buildTransferQr, crc16Ccitt, parseTlv } from "../src/transfer-qr";

const base = { bankBin: "970436", accountNumber: "0011001234567", memo: "MW-C07W2-AN-02" };

describe("crc16Ccitt", () => {
  it("matches the CCITT-FALSE check value", () => {
    expect(crc16Ccitt("123456789")).toBe("29B1");
  });
});

describe("buildTransferQr", () => {
  it.each([
    [1, "1"],
    [50_000, "50000"],
    [12_500_000, "12500000"],
  ])("encodes %d VND as tag 54 %s", (amountVnd, text) => {
    const tags = parseTlv(buildTransferQr({ ...base, amountVnd }));
    expect(tags["54"]).toBe(text);
    expect(tags["53"]).toBe("704");
    expect(tags["58"]).toBe("VN");
    expect(tags["01"]).toBe("12");
  });

  it("encodes account, bank and transfer code", () => {
    const payload = buildTransferQr({ ...base, amountVnd: 300_000 });
    const tags = parseTlv(payload);
    const info = parseTlv(tags["38"]!);
    expect(info["00"]).toBe("A000000727");
    expect(parseTlv(info["01"]!)).toEqual({ "00": "970436", "01": "0011001234567" });
    expect(info["02"]).toBe("QRIBFTTA");
    expect(parseTlv(tags["62"]!)["08"]).toBe("MW-C07W2-AN-02");
  });

  it("ends with a valid CRC over everything before it", () => {
    const payload = buildTransferQr({ ...base, amountVnd: 300_000 });
    expect(payload.slice(-8, -4)).toBe("6304");
    expect(payload.slice(-4)).toBe(crc16Ccitt(payload.slice(0, -4)));
  });

  it("lets options change the memo limit and the service code", () => {
    const long = { ...base, amountVnd: 1, memo: "X".repeat(30) };
    expect(() => buildTransferQr(long)).toThrow(RangeError);
    const tags = parseTlv(buildTransferQr(long, { maxMemoLength: 50, serviceCode: "QRIBFTTC" }));
    expect(parseTlv(tags["38"]!)["02"]).toBe("QRIBFTTC");
  });

  it.each([
    ["zero amount", { amountVnd: 0 }],
    ["negative amount", { amountVnd: -5 }],
    ["fractional amount", { amountVnd: 10.5 }],
    ["unsafe amount", { amountVnd: Number.MAX_SAFE_INTEGER + 1 }],
    ["short bin", { amountVnd: 1, bankBin: "9704" }],
    ["alpha account", { amountVnd: 1, accountNumber: "12AB" }],
    ["empty memo", { amountVnd: 1, memo: "" }],
    ["non-ascii memo", { amountVnd: 1, memo: "Ăn" }],
  ])("rejects %s", (_name, override) => {
    expect(() => buildTransferQr({ ...base, ...override })).toThrow(RangeError);
  });
});
