import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { DiscordFake } from "../src/fakes/discord";

let dc: DiscordFake;
beforeEach(async () => {
  dc = new DiscordFake({ token: "DCTOKEN" });
  await dc.start();
});
afterEach(() => dc.stop());

const rest = (path: string, body?: unknown, token = "DCTOKEN") =>
  fetch(`${dc.url}/api/v10${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Connects a gateway client, identifies, and collects dispatched events. */
async function connect() {
  const gw = (await (await rest("/gateway")).json()) as { url: string };
  const ws = new WebSocket(gw.url);
  const events: any[] = [];
  const ready = new Promise<void>((resolve) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.op === 10) ws.send(JSON.stringify({ op: 2, d: { token: "DCTOKEN", intents: 0 } }));
      if (msg.op === 0 && msg.t === "READY") resolve();
      else if (msg.op === 0) events.push(msg);
    });
  });
  await ready;
  return { ws, events };
}
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(fn()).toBe(true);
};

describe("DiscordFake REST", () => {
  it("rejects a wrong token and serves users/@me for health", async () => {
    expect((await rest("/users/@me")).status).toBe(200);
    expect((await rest("/users/@me", undefined, "bad")).status).toBe(401);
  });

  it("records channel messages with button components", async () => {
    const res = await rest("/channels/c1/messages", {
      content: "budget.question",
      components: [{ type: 1, components: [{ type: 2, label: "a", custom_id: "q1:a", style: 1 }] }],
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).id).toBe("1");
    expect(dc.lastBotMessage("c1")).toMatchObject({
      chatId: "c1",
      text: "budget.question",
      buttons: [{ label: "a", value: "q1:a" }],
    });
  });

  it("supports outage simulation and failNext", async () => {
    dc.setDown(true);
    expect((await rest("/channels/c1/messages", { content: "x" })).status).toBe(502);
    dc.setDown(false);
    dc.failNext(1);
    expect((await rest("/channels/c1/messages", { content: "x" })).status).toBe(502);
    expect((await rest("/channels/c1/messages", { content: "x" })).status).toBe(200);
  });

  it("serves injected attachments", async () => {
    const att = dc.injectPhoto("c1", "u1", new Uint8Array([9, 8]));
    const bytes = await (await fetch(att.url)).arrayBuffer();
    expect([...new Uint8Array(bytes)]).toEqual([9, 8]);
  });
});

describe("DiscordFake gateway", () => {
  it("dispatches injected user messages and button interactions to a connected client", async () => {
    const { ws, events } = await connect();
    dc.injectText("c1", "u1", "hello");
    const sent = await (await rest("/channels/c1/messages", { content: "q" })).json();
    dc.tapButton("c1", "u1", (sent as any).id, "q1:a");
    await until(() => events.length === 2);
    expect(events[0]).toMatchObject({
      t: "MESSAGE_CREATE",
      d: { channel_id: "c1", content: "hello" },
    });
    expect(events[0].d.author.id).toBe("u1");
    expect(events[1]).toMatchObject({
      t: "INTERACTION_CREATE",
      d: { data: { custom_id: "q1:a" } },
    });
    ws.close();
  });

  it("queues events injected before a client connects", async () => {
    dc.injectText("c1", "u1", "early");
    const { ws, events } = await connect();
    await until(() => events.length === 1);
    expect(events[0].d.content).toBe("early");
    ws.close();
  });
});
