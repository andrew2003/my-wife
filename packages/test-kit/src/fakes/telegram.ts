import { systemClock, type Clock } from "../clock";
import { FakeChatServer, sendJson, type RouteContext } from "./base";

interface Update {
  update_id: number;
  [key: string]: unknown;
}

/** In-process stand-in for the Telegram Bot API (the subset the notify adapter uses). */
export class TelegramFake extends FakeChatServer {
  readonly token: string;
  private updates: Update[] = [];
  private nextUpdateId = 1;
  private files = new Map<string, Uint8Array>();
  private nextFileId = 1;

  constructor(opts: { token?: string; clock?: Clock } = {}) {
    super(opts.clock ?? systemClock);
    this.token = opts.token ?? "fake-telegram-token";
  }

  /** The user writes a message to the bot. Returns the update id. */
  injectText(chatId: number | string, text: string, from: { id?: number | string } = {}): number {
    return this.push({
      message: {
        message_id: this.nextUpdateId,
        date: Math.floor(this.clock.now().getTime() / 1000),
        chat: { id: Number(chatId), type: "private" },
        from: { id: Number(from.id ?? chatId), is_bot: false },
        text,
      },
    });
  }

  /** The user taps an inline button of a bot message. */
  tapButton(chatId: number | string, messageId: number | string, data: string): number {
    return this.push({
      callback_query: {
        id: String(this.nextUpdateId),
        from: { id: Number(chatId), is_bot: false },
        message: { message_id: Number(messageId), chat: { id: Number(chatId), type: "private" } },
        data,
      },
    });
  }

  /** The user sends a photo; the bytes are served through getFile. */
  injectPhoto(chatId: number | string, bytes: Uint8Array): number {
    const fileId = `photo-${this.nextFileId++}`;
    this.files.set(fileId, bytes);
    return this.push({
      message: {
        message_id: this.nextUpdateId,
        date: Math.floor(this.clock.now().getTime() / 1000),
        chat: { id: Number(chatId), type: "private" },
        from: { id: Number(chatId), is_bot: false },
        photo: [{ file_id: fileId, file_unique_id: fileId, width: 640, height: 480 }],
      },
    });
  }

  private push(body: Record<string, unknown>): number {
    const id = this.nextUpdateId++;
    this.updates.push({ update_id: id, ...body });
    return id;
  }

  protected override resetState(): void {
    this.updates = [];
    this.files.clear();
  }

  protected override async handle({ res, url, body }: RouteContext): Promise<void> {
    const file = url.pathname.match(/^\/file\/bot([^/]+)\/(.+)$/);
    if (file) {
      if (file[1] !== this.token) return sendJson(res, 401, { ok: false });
      const bytes = this.files.get(file[2]!);
      if (!bytes) return sendJson(res, 404, { ok: false });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return void res.end(Buffer.from(bytes));
    }
    const m = url.pathname.match(/^\/bot([^/]+)\/(\w+)$/);
    if (!m) return sendJson(res, 404, { ok: false, description: "not found" });
    if (m[1] !== this.token) return sendJson(res, 401, { ok: false, description: "Unauthorized" });

    switch (m[2]) {
      case "getMe":
        return sendJson(res, 200, { ok: true, result: { id: 1, is_bot: true, username: "fake_bot" } });
      case "sendMessage":
      case "sendPhoto": {
        if (!this.admitSend(res)) return;
        const rows: Array<Array<{ text: string; callback_data: string }>> =
          body.reply_markup?.inline_keyboard ?? [];
        const buttons = rows.flat().map((b) => ({ label: b.text, value: b.callback_data }));
        const text = String(body.text ?? body.caption ?? "");
        const msg = this.recordBot(String(body.chat_id), text, buttons);
        return sendJson(res, 200, {
          ok: true,
          result: { message_id: Number(msg.id), chat: { id: Number(body.chat_id) }, text },
        });
      }
      case "answerCallbackQuery":
        return sendJson(res, 200, { ok: true, result: true });
      case "getUpdates": {
        const offset = Number(body.offset ?? 0);
        if (offset > 0) this.updates = this.updates.filter((u) => u.update_id >= offset);
        return sendJson(res, 200, { ok: true, result: this.updates });
      }
      case "getFile": {
        if (!this.files.has(body.file_id)) return sendJson(res, 400, { ok: false });
        return sendJson(res, 200, {
          ok: true,
          result: { file_id: body.file_id, file_path: body.file_id },
        });
      }
      default:
        return sendJson(res, 404, { ok: false, description: `unsupported method ${m[2]}` });
    }
  }
}
