import type { ChatChannel, InboundReply, OutboundMessage, Question, SendResult } from "@my-wife/contracts";
import type { DiscordFake } from "./discord";
import type { TelegramFake } from "./telegram";

/**
 * Reference `ChatChannel` implementations that talk to the fakes over their wire protocols.
 * They send the locale key as the text (never a rendered string) and encode a button as
 * `<questionId>:<value>`. Real adapters (grammY, discord.js) must satisfy the same tests.
 */

function buttonsFor(question: Question) {
  return question.options.map((o) => ({ label: o.labelKey, value: `${question.id}:${o.value}` }));
}

function parseButton(data: string): { questionId: string; value: string } | null {
  const i = data.indexOf(":");
  return i > 0 ? { questionId: data.slice(0, i), value: data.slice(i + 1) } : null;
}

async function checkedJson(res: Response, what: string): Promise<any> {
  if (!res.ok) throw new Error(`${what} failed with HTTP ${res.status}`);
  return res.json();
}

export function createFakeTelegramChannel(fake: TelegramFake): ChatChannel {
  const challenges = new Map<string, string>();
  const api = async (method: string, body: unknown) =>
    checkedJson(
      await fetch(`${fake.url}/bot${fake.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      method,
    );
  const sendWith = async (target: string, text: string, buttons: Array<{ label: string; value: string }>) => {
    const out = await api("sendMessage", {
      chat_id: Number(target),
      text,
      reply_markup: {
        inline_keyboard: buttons.length
          ? [buttons.map((b) => ({ text: b.label, callback_data: b.value }))]
          : [],
      },
    });
    return { externalMessageId: String(out.result.message_id), acceptedAt: fake.clock.now().toISOString() } satisfies SendResult;
  };

  return {
    kind: "telegram",
    send: (target, message: OutboundMessage) => sendWith(target, message.message.key, []),
    sendQuestion: (target, message, question) =>
      sendWith(target, message.message.key, buttonsFor(question)),
    async sendPhotoRequest(target, message, challengeId) {
      challenges.set(target, challengeId);
      return sendWith(target, message.message.key, []);
    },
    async parseReply(raw: any): Promise<InboundReply | null> {
      const sentAt = fake.clock.now().toISOString();
      const cb = raw?.callback_query;
      if (cb && typeof cb.data === "string") {
        const b = parseButton(cb.data);
        return b ? { kind: "button", ...b, externalId: String(cb.from.id), sentAt } : null;
      }
      const msg = raw?.message;
      if (!msg) return null;
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
      const res = await fetch(`${fake.url}/file/bot${fake.token}/${file.result.file_path}`);
      if (!res.ok) throw new Error(`file download failed with HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async link(userToken, raw: any) {
      if (raw?.message?.text !== `/start ${userToken}`) throw new Error("link token does not match");
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

export function createFakeDiscordChannel(fake: DiscordFake): ChatChannel {
  const challenges = new Map<string, string>();
  const headers = { authorization: `Bot ${fake.token}`, "content-type": "application/json" };
  const sendWith = async (target: string, content: string, buttons: Array<{ label: string; value: string }>) => {
    const out = await checkedJson(
      await fetch(`${fake.url}/api/v10/channels/${target}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          content,
          components: buttons.length
            ? [{ type: 1, components: buttons.map((b) => ({ type: 2, style: 1, label: b.label, custom_id: b.value })) }]
            : [],
        }),
      }),
      "create message",
    );
    return { externalMessageId: String(out.id), acceptedAt: fake.clock.now().toISOString() } satisfies SendResult;
  };

  return {
    kind: "discord",
    send: (target, message: OutboundMessage) => sendWith(target, message.message.key, []),
    sendQuestion: (target, message, question) =>
      sendWith(target, message.message.key, buttonsFor(question)),
    async sendPhotoRequest(target, message, challengeId) {
      challenges.set(target, challengeId);
      return sendWith(target, message.message.key, []);
    },
    async parseReply(raw: any): Promise<InboundReply | null> {
      const sentAt = fake.clock.now().toISOString();
      if (raw?.t === "INTERACTION_CREATE") {
        const b = parseButton(String(raw.d?.data?.custom_id ?? ""));
        const user = raw.d?.member?.user?.id;
        return b && user ? { kind: "button", ...b, externalId: String(raw.d.channel_id), sentAt } : null;
      }
      if (raw?.t !== "MESSAGE_CREATE" || raw.d?.author?.bot) return null;
      const externalId = String(raw.d.channel_id);
      const attachment = raw.d.attachments?.[0];
      if (attachment) {
        return {
          kind: "photo",
          challengeId: challenges.get(externalId) ?? null,
          fileRef: String(attachment.url),
          externalId,
          sentAt,
        };
      }
      return typeof raw.d.content === "string"
        ? { kind: "text", text: raw.d.content, externalId, sentAt }
        : null;
    },
    async receivePhoto(reply) {
      const res = await fetch(reply.fileRef);
      if (!res.ok) throw new Error(`attachment download failed with HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async link(userToken, raw: any) {
      if (raw?.d?.content !== `/start ${userToken}`) throw new Error("link token does not match");
      return { externalId: String(raw.d.channel_id) };
    },
    async health() {
      const res = await fetch(`${fake.url}/api/v10/users/@me`, { headers });
      return res.ok ? { healthy: true } : { healthy: false, detail: `HTTP ${res.status}` };
    },
  };
}

export type { Question };
