import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandDefinition } from "@my-wife/contracts";
import { createApp } from "../src/app";
import { createDiscordChannel } from "../src/channels/discord";
import { createTelegramChannel } from "../src/channels/telegram";
import { menuEntries, registerCommandMenus, suggestCommands } from "../src/commands/menu";

const def = (id: string, over: Partial<CommandDefinition> = {}): CommandDefinition => ({
  id,
  kind: "builtin",
  name: id,
  aliases: [],
  descriptionKey: `commands.desc.${id}`,
  enabled: true,
  ai: false,
  builtin: true,
  args: [],
  ...over,
});

const DEFS: CommandDefinition[] = [
  def("task", { aliases: ["viec"] }),
  def("today", { aliases: ["hom_nay"] }),
  def("spend", { enabled: false }),
  def("custom:tea", {
    name: "tea",
    builtin: false,
    kind: "prompt",
    descriptionKey: undefined,
    description: { vi: "Mời trà", en: "Offer tea" },
  }),
];

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

interface Call {
  method: string;
  path: string;
  body: any;
}

/** Minimal HTTP stand-in that records every request. */
async function recorder() {
  const calls: Call[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString();
      calls.push({
        method: req.method ?? "",
        path: req.url ?? "",
        body: text ? JSON.parse(text) : null,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { calls, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const clock = { now: () => new Date("2026-11-28T00:00:00Z") };

describe("menu entries", () => {
  it("removes disabled commands and resolves descriptions per locale", () => {
    const en = menuEntries(DEFS, "en");
    expect(en.map((e) => e.command)).toEqual(["task", "today", "tea"]);
    expect(en[0]!.description).toBe("Add a task.");
    expect(en[2]!.description).toBe("Offer tea");
    expect(menuEntries(DEFS, "vi")[2]!.description).toBe("Mời trà");
  });
});

describe("registering menus", () => {
  it("sends the enabled list to Telegram and drops a disabled command", async () => {
    const tg = await recorder();
    const channel = createTelegramChannel({ baseUrl: tg.url, token: "t", clock });
    await registerCommandMenus([{ channel, target: "42" }], DEFS, "en");
    const call = tg.calls.find((c) => c.path.endsWith("/setMyCommands"))!;
    expect(call.body.commands.map((c: { command: string }) => c.command)).toEqual([
      "task",
      "today",
      "tea",
    ]);
    expect(call.body.scope).toEqual({ type: "chat", chat_id: 42 });
  });

  it("sends the enabled list to Discord with descriptions capped at 100 characters", async () => {
    const dc = await recorder();
    const channel = createDiscordChannel({
      baseUrl: dc.url,
      token: "t",
      clock,
      applicationId: "app1",
    });
    const long = def("task", {
      descriptionKey: undefined,
      description: { vi: "x".repeat(200), en: "x".repeat(200) },
    });
    await registerCommandMenus([{ channel, target: "9" }], [long, ...DEFS.slice(2)], "en");
    const call = dc.calls.find((c) => c.method === "PUT")!;
    expect(call.path).toBe("/api/v10/applications/app1/commands");
    expect(call.body.map((c: { name: string }) => c.name)).toEqual(["task", "tea"]);
    expect(call.body[0].description).toHaveLength(100);
  });
});

describe("in-app autocomplete", () => {
  it("suggests matching names and aliases after a slash", () => {
    expect(suggestCommands("/", DEFS, "en").map((s) => s.name)).toEqual(["task", "today", "tea"]);
    expect(suggestCommands("/ta", DEFS, "en").map((s) => s.name)).toEqual(["task"]);
    expect(suggestCommands("/hom", DEFS, "en")).toEqual([
      { name: "today", matchedAs: "hom_nay", description: "Summarise today." },
    ]);
    expect(suggestCommands("/spe", DEFS, "en")).toEqual([]);
  });

  it("suggests nothing once an argument started or without a slash", () => {
    expect(suggestCommands("ta", DEFS, "en")).toEqual([]);
    expect(suggestCommands("/task buy", DEFS, "en")).toEqual([]);
  });

  it("serves suggestions over GET /commands/suggest for the calling user", async () => {
    const app = createApp({ logLevel: "silent" } as never, { commandSource: async () => DEFS });
    const res = await app.inject({
      method: "GET",
      url: "/commands/suggest?q=%2Fta&locale=vi",
      headers: { "x-user-id": "u1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.items.map((i: { name: string }) => i.name)).toEqual(["task"]);
    const anon = await app.inject({ method: "GET", url: "/commands/suggest?q=%2F" });
    expect(anon.statusCode).toBe(401);
  });
});
