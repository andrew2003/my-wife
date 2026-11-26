import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { systemClock, type Clock } from "../clock";

/** A message the bot sent, in a channel-neutral shape that tests can assert on. */
export interface BotMessage {
  id: string;
  chatId: string;
  text: string;
  buttons: Array<{ label: string; value: string }>;
  sentAt: number;
}

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: any;
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

/** Shared plumbing for the in-process chat fakes: HTTP server, outage switches, message log. */
export abstract class FakeChatServer {
  constructor(readonly clock: Clock = systemClock) {}

  protected server: Server | null = null;
  protected port = 0;
  private down = false;
  private failures = 0;
  private bot: BotMessage[] = [];
  private nextMessageId = 1;
  private waiters: Array<{ pred: (m: BotMessage) => boolean; resolve: (m: BotMessage) => void }> =
    [];

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  protected abstract handle(ctx: RouteContext): Promise<void> | void;
  protected onStart(_server: Server): void {}
  protected onStop(): void {}
  protected resetState(): void {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.route(req, res);
    });
    this.onStart(this.server);
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.onStop();
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Simulates a channel outage: every send fails with 502 until switched off. */
  setDown(down: boolean): void {
    this.down = down;
  }
  /** Fails the next `n` sends, then recovers. */
  failNext(n: number): void {
    this.failures = n;
  }

  /** Messages the bot sent, optionally for one chat. */
  botMessages(chatId?: string): BotMessage[] {
    return this.bot.filter((m) => chatId === undefined || m.chatId === chatId);
  }
  lastBotMessage(chatId?: string): BotMessage | undefined {
    return this.botMessages(chatId).at(-1);
  }
  waitForBotMessage(pred: (m: BotMessage) => boolean, timeoutMs = 2000): Promise<BotMessage> {
    const hit = this.bot.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const waiter = {
        pred,
        resolve: (m: BotMessage) => {
          clearTimeout(timer);
          resolve(m);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error("waitForBotMessage timed out"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  reset(): void {
    this.bot = [];
    this.nextMessageId = 1;
    this.down = false;
    this.failures = 0;
    this.resetState();
  }

  /** Returns false (and writes the 502) when the send must fail. */
  protected admitSend(res: ServerResponse): boolean {
    if (this.down || this.failures > 0) {
      if (this.failures > 0) this.failures--;
      sendJson(res, 502, { ok: false, error: "fake channel unavailable" });
      return false;
    }
    return true;
  }

  protected recordBot(chatId: string, text: string, buttons: BotMessage["buttons"]): BotMessage {
    const msg: BotMessage = {
      id: String(this.nextMessageId++),
      chatId,
      text,
      buttons,
      sentAt: this.clock.now().getTime(),
    };
    this.bot.push(msg);
    for (const w of [...this.waiters]) {
      if (w.pred(msg)) {
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve(msg);
      }
    }
    return msg;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = {};
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          return sendJson(res, 400, { ok: false, error: "invalid json" });
        }
      }
      await this.handle({ req, res, url: new URL(req.url ?? "/", this.url), body });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err) });
    }
  }
}
