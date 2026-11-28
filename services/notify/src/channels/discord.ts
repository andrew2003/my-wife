import type { InboundReply, Question, SendResult } from "@my-wife/contracts";
import type { MenuChannel } from "../commands/menu";
import { renderMessage } from "../i18n";

export interface DiscordChannelOptions {
  /** Discord origin; the emulated server in tests, `https://discord.com` otherwise. */
  baseUrl: string;
  token: string;
  /** Application id the slash commands are registered under; menus are skipped without it. */
  applicationId?: string;
  clock: { now(): Date };
}

/** Discord limits a slash command description to 100 characters. */
const DISCORD_DESCRIPTION_MAX = 100;

/** Hosts besides `baseUrl` that may serve attachments. */
const ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

/** Loosely typed gateway JSON; every field is validated before use. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DiscordJson = any;

/** Button custom ids are `<questionId>:<value>`. */
function parseButton(data: string): { questionId: string; value: string } | null {
  const i = data.indexOf(":");
  return i > 0 ? { questionId: data.slice(0, i), value: data.slice(i + 1) } : null;
}

/**
 * Discord implementation of the shared `ChatChannel` interface. `raw` is a gateway dispatch frame
 * (`{ t, d }`) and is untrusted. The external id of a chat is the Discord channel id.
 */
export function createDiscordChannel(opts: DiscordChannelOptions): MenuChannel {
  const challenges = new Map<string, string>();
  const headers = { authorization: `Bot ${opts.token}`, "content-type": "application/json" };

  const api = async (method: string, path: string, body?: unknown): Promise<DiscordJson> => {
    const res = await fetch(`${opts.baseUrl}/api/v10${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`discord ${method} ${path} failed with HTTP ${res.status}`);
    return res.json();
  };

  const sendText = async (
    target: string,
    content: string,
    buttons: Array<{ label: string; customId: string }> = [],
  ): Promise<SendResult> => {
    const out = await api("POST", `/channels/${encodeURIComponent(target)}/messages`, {
      content,
      components: buttons.length
        ? [
            {
              type: 1,
              components: buttons.map((b) => ({
                type: 2,
                style: 1,
                label: b.label,
                custom_id: b.customId,
              })),
            },
          ]
        : [],
    });
    return {
      externalMessageId: String(out.id),
      acceptedAt: opts.clock.now().toISOString(),
    };
  };

  const buttonsFor = (question: Question, locale: "vi" | "en") =>
    question.options.map((o) => ({
      label: renderMessage({ key: o.labelKey, params: {} }, locale),
      customId: `${question.id}:${o.value}`,
    }));

  const attachmentAllowed = (url: string): boolean => {
    try {
      const u = new URL(url);
      return (
        u.origin === new URL(opts.baseUrl).origin ||
        (u.protocol === "https:" && ATTACHMENT_HOSTS.has(u.hostname))
      );
    } catch {
      return false;
    }
  };

  return {
    kind: "discord",
    async registerMenu(_target, entries) {
      if (!opts.applicationId) return;
      // Discord slash commands are registered per application, so the list is bot-wide.
      await api(
        "PUT",
        `/applications/${encodeURIComponent(opts.applicationId)}/commands`,
        entries.map((e) => ({
          name: e.command,
          type: 1,
          description: e.description.slice(0, DISCORD_DESCRIPTION_MAX),
        })),
      );
    },
    send: (target, m) => sendText(target, renderMessage(m.message, m.locale)),
    sendQuestion: (target, m, question) =>
      sendText(target, renderMessage(m.message, m.locale), buttonsFor(question, m.locale)),
    async sendPhotoRequest(target, m, challengeId) {
      const result = await sendText(target, renderMessage(m.message, m.locale));
      challenges.set(target, challengeId);
      return result;
    },
    async parseReply(raw: DiscordJson): Promise<InboundReply | null> {
      const sentAt = opts.clock.now().toISOString();
      const d = raw?.d;
      if (!d || d.channel_id === undefined) return null;
      const externalId = String(d.channel_id);
      if (raw.t === "INTERACTION_CREATE") {
        const b = parseButton(String(d.data?.custom_id ?? ""));
        return b && (d.member?.user?.id ?? d.user?.id)
          ? { kind: "button", ...b, externalId, sentAt }
          : null;
      }
      if (raw.t !== "MESSAGE_CREATE" || d.author?.bot) return null;
      const attachment = Array.isArray(d.attachments) ? d.attachments[0] : undefined;
      if (attachment && typeof attachment.url === "string") {
        return {
          kind: "photo",
          challengeId: challenges.get(externalId) ?? null,
          fileRef: attachment.url,
          externalId,
          sentAt,
        };
      }
      return typeof d.content === "string"
        ? { kind: "text", text: d.content, externalId, sentAt }
        : null;
    },
    async receivePhoto(reply) {
      // The reference comes from an untrusted update: only fetch from known Discord hosts.
      if (!attachmentAllowed(reply.fileRef)) throw new Error("attachment host is not allowed");
      const res = await fetch(reply.fileRef, { redirect: "error" });
      if (!res.ok) throw new Error(`discord attachment download failed with HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async link(userToken, raw: DiscordJson) {
      if (raw?.t !== "MESSAGE_CREATE" || raw.d?.content !== `/start ${userToken}`)
        throw new Error("link token does not match");
      return { externalId: String(raw.d.channel_id) };
    },
    async health() {
      try {
        await api("GET", "/users/@me");
        return { healthy: true };
      } catch (err) {
        return { healthy: false, detail: String(err) };
      }
    },
  };
}
