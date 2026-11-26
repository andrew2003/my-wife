import {
  notifyEvents,
  type ChannelKind,
  type ChatChannel,
  type OutboundMessage,
  type Question,
} from "@my-wife/contracts";
import type { QuestionService } from "../questions/question-service";

export interface ChannelLink {
  userId: string;
  channel: ChannelKind;
  externalId: string;
}

export interface ChannelLinkStore {
  findByUser(userId: string, channel: ChannelKind): ChannelLink | undefined;
  findByExternalId(channel: ChannelKind, externalId: string): ChannelLink | undefined;
}

export class InMemoryChannelLinkStore implements ChannelLinkStore {
  private links: ChannelLink[] = [];
  add(link: ChannelLink): void {
    this.links.push(link);
  }
  findByUser(userId: string, channel: ChannelKind) {
    return this.links.find((l) => l.userId === userId && l.channel === channel);
  }
  findByExternalId(channel: ChannelKind, externalId: string) {
    return this.links.find((l) => l.channel === channel && l.externalId === externalId);
  }
}

export interface ChatContext {
  channel: ChannelKind;
  externalId: string;
  userId: string;
}

export interface PublishedEvent {
  name: "notify.sent" | "notify.reply_received";
  payload: unknown;
  /** Chat context of inbound events; not part of the contract payload. */
  context?: ChatContext;
}

/** Image bytes handed to the caller; notify never stores them. */
export interface PhotoHandoff extends ChatContext {
  bytes: Uint8Array;
  challengeId: string | null;
}

export interface ChannelServiceDeps {
  channels: ChatChannel[];
  links: ChannelLinkStore;
  publish: (event: PublishedEvent) => Promise<void>;
  onPhoto: (photo: PhotoHandoff) => Promise<void>;
  /** When set, button taps go through the first-reply-wins question state machine. */
  questions?: QuestionService;
}

/** Channel-agnostic delivery and inbound handling on top of `ChatChannel`. */
export class ChannelService {
  constructor(private readonly deps: ChannelServiceDeps) {}

  private channel(kind: ChannelKind): ChatChannel {
    const channel = this.deps.channels.find((c) => c.kind === kind);
    if (!channel) throw new Error(`channel ${kind} is not configured`);
    return channel;
  }

  private target(userId: string, kind: ChannelKind): string {
    const link = this.deps.links.findByUser(userId, kind);
    if (!link) throw new Error(`user is not linked to ${kind}`);
    return link.externalId;
  }

  async deliver(userId: string, kind: ChannelKind, message: OutboundMessage): Promise<void> {
    await this.channel(kind).send(this.target(userId, kind), message);
    await this.deps.publish({
      name: "notify.sent",
      payload: notifyEvents["notify.sent"].parse({
        messageId: message.id,
        class: message.class,
        channel: kind,
      }),
    });
  }

  /** Sends one message with the question buttons over the first channel the user is linked to. */
  async deliverQuestion(
    userId: string,
    message: OutboundMessage,
    question: Question,
  ): Promise<void> {
    for (const channel of this.deps.channels) {
      const link = this.deps.links.findByUser(userId, channel.kind);
      if (!link) continue;
      await channel.sendQuestion(link.externalId, message, question);
      await this.deps.publish({
        name: "notify.sent",
        payload: notifyEvents["notify.sent"].parse({
          messageId: message.id,
          class: message.class,
          channel: channel.kind,
        }),
      });
      return;
    }
    throw new Error("user is not linked to any channel");
  }

  async requestPhoto(
    userId: string,
    kind: ChannelKind,
    message: OutboundMessage,
    challengeId: string,
  ): Promise<void> {
    await this.channel(kind).sendPhotoRequest(this.target(userId, kind), message, challengeId);
  }

  /** Handles one raw channel update. Updates from unlinked chats are ignored. */
  async handleUpdate(kind: ChannelKind, raw: unknown): Promise<void> {
    const channel = this.channel(kind);
    const reply = await channel.parseReply(raw);
    if (!reply) return;
    const link = this.deps.links.findByExternalId(kind, reply.externalId);
    if (!link) return;
    const context: ChatContext = {
      channel: kind,
      externalId: link.externalId,
      userId: link.userId,
    };

    if (reply.kind === "button" && this.deps.questions) {
      await this.deps.questions.answer(
        link.userId,
        reply.questionId,
        reply.value,
        "chat",
        reply.sentAt,
        context,
      );
      return;
    }

    if (reply.kind === "photo") {
      const bytes = await channel.receivePhoto(reply);
      await this.deps.onPhoto({ ...context, bytes, challengeId: reply.challengeId });
      return;
    }
    const payload =
      reply.kind === "button"
        ? {
            questionId: reply.questionId,
            sourceService: "notify",
            kind: "button",
            value: reply.value,
          }
        : {
            questionId: `chat:${reply.externalId}`,
            sourceService: "notify",
            kind: "text",
            value: reply.text,
          };
    await this.deps.publish({
      name: "notify.reply_received",
      payload: notifyEvents["notify.reply_received"].parse({
        ...payload,
        answeredAt: reply.sentAt,
        via: "chat",
      }),
      context,
    });
  }
}
