import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { FakeChatServer, sendJson, type RouteContext } from "./base";

/** In-process stand-in for the Discord REST API plus a minimal gateway over WebSocket. */
export class DiscordFake extends FakeChatServer {
  readonly token: string;
  private wss: WebSocketServer | null = null;
  private ready = new Set<WebSocket>();
  private queued: unknown[] = [];
  private attachments = new Map<string, Uint8Array>();
  private nextId = 1000;

  constructor(opts: { token?: string } = {}) {
    super();
    this.token = opts.token ?? "fake-discord-token";
  }

  get gatewayUrl(): string {
    return `ws://127.0.0.1:${this.port}/gateway`;
  }

  /** The user writes in a channel the bot can see. */
  injectText(channelId: string, userId: string, content: string): void {
    this.dispatch("MESSAGE_CREATE", {
      id: this.id(),
      channel_id: channelId,
      author: { id: userId, bot: false },
      content,
      attachments: [],
      timestamp: new Date().toISOString(),
    });
  }

  /** The user clicks a button on a bot message. */
  tapButton(channelId: string, userId: string, messageId: string, customId: string): void {
    this.dispatch("INTERACTION_CREATE", {
      id: this.id(),
      type: 3,
      channel_id: channelId,
      member: { user: { id: userId } },
      message: { id: messageId, channel_id: channelId },
      data: { custom_id: customId, component_type: 2 },
    });
  }

  /** The user posts a photo attachment; returns the attachment (its `url` serves the bytes). */
  injectPhoto(channelId: string, userId: string, bytes: Uint8Array): { id: string; url: string } {
    const id = this.id();
    this.attachments.set(id, bytes);
    const attachment = { id, url: `${this.url}/attachments/${id}`, content_type: "image/jpeg" };
    this.dispatch("MESSAGE_CREATE", {
      id: this.id(),
      channel_id: channelId,
      author: { id: userId, bot: false },
      content: "",
      attachments: [attachment],
      timestamp: new Date().toISOString(),
    });
    return attachment;
  }

  private id(): string {
    return String(this.nextId++);
  }

  private dispatch(t: string, d: unknown): void {
    const frame = { op: 0, t, s: 0, d };
    if (this.ready.size === 0) return void this.queued.push(frame);
    for (const ws of this.ready) ws.send(JSON.stringify(frame));
  }

  protected override onStart(server: Server): void {
    this.wss = new WebSocketServer({ server, path: "/gateway" });
    this.wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { op: number; d?: { token?: string } };
        if (msg.op === 1) return ws.send(JSON.stringify({ op: 11 }));
        if (msg.op !== 2) return;
        if (msg.d?.token !== this.token) return ws.close(4004, "Authentication failed");
        ws.send(JSON.stringify({ op: 0, t: "READY", s: 0, d: { user: { id: "bot", bot: true } } }));
        this.ready.add(ws);
        for (const frame of this.queued.splice(0)) ws.send(JSON.stringify(frame));
      });
      ws.on("close", () => this.ready.delete(ws));
    });
  }

  protected override onStop(): void {
    for (const ws of this.wss?.clients ?? []) ws.terminate();
    this.wss?.close();
    this.wss = null;
    this.ready.clear();
  }

  protected override resetState(): void {
    this.queued = [];
    this.attachments.clear();
  }

  protected override async handle({ req, res, url, body }: RouteContext): Promise<void> {
    const att = url.pathname.match(/^\/attachments\/(\d+)$/);
    if (att) {
      const bytes = this.attachments.get(att[1]!);
      if (!bytes) return sendJson(res, 404, { message: "Unknown attachment" });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return void res.end(Buffer.from(bytes));
    }
    if (req.headers.authorization !== `Bot ${this.token}`) {
      return sendJson(res, 401, { message: "401: Unauthorized", code: 0 });
    }
    const path = url.pathname.replace(/^\/api\/v\d+/, "");
    if (path === "/users/@me") return sendJson(res, 200, { id: "bot", username: "fake-bot", bot: true });
    if (path === "/gateway" || path === "/gateway/bot") {
      return sendJson(res, 200, { url: this.gatewayUrl });
    }
    const post = path.match(/^\/channels\/([^/]+)\/messages$/);
    if (post && req.method === "POST") {
      if (!this.admitSend(res)) return;
      const rows: Array<{ components?: Array<{ label?: string; custom_id?: string }> }> =
        body.components ?? [];
      const buttons = rows
        .flatMap((r) => r.components ?? [])
        .map((c) => ({ label: String(c.label ?? ""), value: String(c.custom_id ?? "") }));
      const msg = this.recordBot(post[1]!, String(body.content ?? ""), buttons);
      return sendJson(res, 200, { id: msg.id, channel_id: post[1], content: msg.text });
    }
    return sendJson(res, 404, { message: "404: Not Found", code: 0 });
  }
}
