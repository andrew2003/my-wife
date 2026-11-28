import { fetchWithPolicy } from "@my-wife/service-kit";
import type { InboundReply, Question, SendResult } from "@my-wife/contracts";
import type { MenuChannel } from "../commands/menu";
import { renderMessage } from "../i18n";

export interface TelegramChannelOptions {
  /** Bot API origin; the emulated server in tests, `https://api.telegram.org` otherwise. */
  baseUrl: string;
  token: string;
  clock: { now(): Date };
}

/** Loosely typed Telegram JSON; every field is validated before use. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TelegramJson = any;

/** Button callback data is `<questionId>:<value>`. */
function parseButton(data: string): { questionId: string; value: string } | null {
  const i = data.indexOf(":");
  return i > 0 ? { questionId: data.slice(0, i), value: data.slice(i + 1) } : null;
}

/** Telegram implementation of the shared `ChatChannel` interface. `raw` updates are untrusted. */
export function createTelegramChannel(opts: TelegramChannelOptions): MenuChannel {
  const challenges = new Map<string, string>();

  const api = async (method: string, body: unknown): Promise<TelegramJson> => {
    const res = await fetchWithPolicy(`${opts.baseUrl}/bot${opts.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`telegram ${method} failed with HTTP ${res.status}`);
    return res.json();
  };

  const sendText = async (
    target: string,
    text: string,
    buttons: Array<{ text: string; callback_data: string }> = [],
  ): Promise<SendResult> => {
    const out = await api("sendMessage", {
      chat_id: Number(target),
      text,
      reply_markup: { inline_keyboard: buttons.length ? [buttons] : [] },
    });
    return {
      externalMessageId: String(out.result.message_id),
      acceptedAt: opts.clock.now().toISOString(),
    };
  };

  const buttonsFor = (question: Question, locale: "vi" | "en") =>
    question.options.map((o) => ({
      text: renderMessage({ key: o.labelKey, params: {} }, locale),
      callback_data: `${question.id}:${o.value}`,
    }));

  return {
    kind: "telegram",
    async registerMenu(target, entries) {
      await api("setMyCommands", {
        commands: entries,
        scope: { type: "chat", chat_id: Number(target) },
      });
    },
    send: (target, m) => sendText(target, renderMessage(m.message, m.locale)),
    sendQuestion: (target, m, question) =>
      sendText(target, renderMessage(m.message, m.locale), buttonsFor(question, m.locale)),
    async sendPhotoRequest(target, m, challengeId) {
      const result = await sendText(target, renderMessage(m.message, m.locale));
      challenges.set(target, challengeId);
      return result;
    },
    async parseReply(raw: TelegramJson): Promise<InboundReply | null> {
      const sentAt = opts.clock.now().toISOString();
      const cb = raw?.callback_query;
      if (cb && typeof cb.data === "string") {
        const b = parseButton(cb.data);
        return b ? { kind: "button", ...b, externalId: String(cb.from.id), sentAt } : null;
      }
      const msg = raw?.message;
      if (!msg?.chat) return null;
      const externalId = String(msg.chat.id);
      if (Array.isArray(msg.photo) && msg.photo.length > 0) {
        return {
          kind: "photo",
          challengeId: challenges.get(externalId) ?? null,
          fileRef: msg.photo.at(-1).file_id,
          externalId,
          sentAt,
        };
      }
      if (typeof msg.text === "string") return { kind: "text", text: msg.text, externalId, sentAt };
      return null;
    },
    async receivePhoto(reply) {
      const file = await api("getFile", { file_id: reply.fileRef });
      const res = await fetchWithPolicy(
        `${opts.baseUrl}/file/bot${opts.token}/${file.result.file_path}`,
        {},
        { idempotent: true },
      );
      if (!res.ok) throw new Error(`telegram file download failed with HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async link(userToken, raw: TelegramJson) {
      if (raw?.message?.text !== `/start ${userToken}`)
        throw new Error("link token does not match");
      return { externalId: String(raw.message.chat.id) };
    },
    async health() {
      try {
        await api("getMe", {});
        return { healthy: true };
      } catch (err) {
        return { healthy: false, detail: String(err) };
      }
    },
  };
}
