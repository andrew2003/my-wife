import type { ChannelKind } from "../common";
import type { InboundReply, OutboundMessage, Question, SendResult } from "./entities";

/**
 * Shared adapter interface for chat channels (ADR 0005). Implementations: Telegram, Discord.
 * `raw` is the channel's own update object and is treated as untrusted data.
 */
export interface ChatChannel {
  readonly kind: ChannelKind;
  send(target: string, message: OutboundMessage): Promise<SendResult>;
  sendQuestion(target: string, message: OutboundMessage, question: Question): Promise<SendResult>;
  /** Returns null for updates that are not replies (for example from an unlinked identity). */
  parseReply(raw: unknown): Promise<InboundReply | null>;
  sendPhotoRequest(target: string, message: OutboundMessage, challengeId: string): Promise<SendResult>;
  /** Fetches the photo bytes for a `photo` reply; the caller deletes them after grading. */
  receivePhoto(reply: Extract<InboundReply, { kind: "photo" }>): Promise<Uint8Array>;
  /** Consumes a one-time user token and returns the external chat id to store. */
  link(userToken: string, raw: unknown): Promise<{ externalId: string }>;
  health(): Promise<{ healthy: boolean; detail?: string }>;
}
