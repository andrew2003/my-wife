import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TelegramFake } from "../src/fakes/telegram";

let tg: TelegramFake;
beforeEach(async () => {
  tg = new TelegramFake({ token: "TESTTOKEN" });
  await tg.start();
});
afterEach(() => tg.stop());

const call = async (method: string, body?: unknown) => {
  const res = await fetch(`${tg.url}/botTESTTOKEN/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: (await res.json()) as any };
};

describe("TelegramFake bot API", () => {
  it("answers getMe for health checks and rejects a wrong token", async () => {
    expect((await call("getMe")).json.ok).toBe(true);
    const bad = await fetch(`${tg.url}/botWRONG/getMe`, { method: "POST" });
    expect(bad.status).toBe(401);
  });

  it("records sendMessage with its inline keyboard", async () => {
    const res = await call("sendMessage", {
      chat_id: 42,
      text: "budget.question",
      reply_markup: { inline_keyboard: [[{ text: "a", callback_data: "q1:a" }]] },
    });
    expect(res.json.ok).toBe(true);
    expect(res.json.result.message_id).toBe(1);
    expect(tg.botMessages()).toHaveLength(1);
    expect(tg.lastBotMessage("42")).toMatchObject({
      chatId: "42",
      text: "budget.question",
      buttons: [{ label: "a", value: "q1:a" }],
    });
  });

  it("delivers injected user messages and button taps through getUpdates with offsets", async () => {
    tg.injectText(42, "hello");
    const sent = await call("sendMessage", { chat_id: 42, text: "q" });
    tg.tapButton(42, sent.json.result.message_id, "q1:a");
    const first = await call("getUpdates", {});
    expect(first.json.result).toHaveLength(2);
    expect(first.json.result[0].message.text).toBe("hello");
    expect(first.json.result[1].callback_query.data).toBe("q1:a");
    const lastId = first.json.result[1].update_id;
    const second = await call("getUpdates", { offset: lastId + 1 });
    expect(second.json.result).toEqual([]);
  });

  it("serves injected photos by file id", async () => {
    tg.injectPhoto(42, new Uint8Array([1, 2, 3]));
    const upd = (await call("getUpdates")).json.result[0];
    const fileId = upd.message.photo.at(-1).file_id;
    const file = (await call("getFile", { file_id: fileId })).json.result;
    const bytes = await (
      await fetch(`${tg.url}/file/botTESTTOKEN/${file.file_path}`)
    ).arrayBuffer();
    expect([...new Uint8Array(bytes)]).toEqual([1, 2, 3]);
  });

  it("can simulate an outage and recover", async () => {
    tg.setDown(true);
    expect((await call("sendMessage", { chat_id: 1, text: "x" })).status).toBe(502);
    expect(tg.botMessages()).toHaveLength(0);
    tg.setDown(false);
    expect((await call("sendMessage", { chat_id: 1, text: "x" })).status).toBe(200);
  });

  it("can fail the next N sends", async () => {
    tg.failNext(2);
    expect((await call("sendMessage", { chat_id: 1, text: "x" })).status).toBe(502);
    expect((await call("sendMessage", { chat_id: 1, text: "x" })).status).toBe(502);
    expect((await call("sendMessage", { chat_id: 1, text: "x" })).status).toBe(200);
  });

  it("waitForBotMessage resolves when a matching message arrives", async () => {
    const waiting = tg.waitForBotMessage((m) => m.text === "later", 1000);
    setTimeout(() => void call("sendMessage", { chat_id: 1, text: "later" }), 10);
    expect((await waiting).text).toBe("later");
    await expect(tg.waitForBotMessage(() => false, 30)).rejects.toThrow(/timed out/);
  });

  it("reset clears messages and updates", async () => {
    tg.injectText(1, "x");
    await call("sendMessage", { chat_id: 1, text: "y" });
    tg.reset();
    expect(tg.botMessages()).toEqual([]);
    expect((await call("getUpdates")).json.result).toEqual([]);
  });
});
