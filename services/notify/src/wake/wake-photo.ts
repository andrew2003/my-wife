import { randomUUID } from "node:crypto";
import type { ChannelKind, Locale, MessageRef, OutboundMessage } from "@my-wife/contracts";
import type { ChannelService, PhotoHandoff } from "../channels/channel-service";

/** schedule owns the photo window: it answers whether the photo counts as the wake proof. */
export interface ScheduleWakePort {
  reportPhoto(
    userId: string,
    challengeId: string,
    sentAt: string,
  ): Promise<{ accepted: boolean; challengeKey: string }>;
}

/** ai grades the photo (`GradePhotoRequest`); the result comes back as `ai.photo_graded`. */
export interface AiWakePort {
  gradePhoto(
    userId: string,
    request: { challengeId: string; challengeKey: string; imageBase64: string },
  ): Promise<void>;
}

/**
 * `onPhoto` for the channel service. A photo goes to ai only when schedule accepts it (inside the
 * window); otherwise schedule has already answered in plain words. The bytes are wiped in every
 * outcome and are never stored or logged.
 */
export function createWakePhotoHandler(deps: { schedule: ScheduleWakePort; ai: AiWakePort }) {
  return async (photo: PhotoHandoff): Promise<void> => {
    try {
      if (!photo.challengeId) return;
      const verdict = await deps.schedule.reportPhoto(
        photo.userId,
        photo.challengeId,
        photo.sentAt,
      );
      if (!verdict.accepted) return;
      await deps.ai.gradePhoto(photo.userId, {
        challengeId: photo.challengeId,
        challengeKey: verdict.challengeKey,
        imageBase64: Buffer.from(photo.bytes).toString("base64"),
      });
    } finally {
      photo.bytes.fill(0);
    }
  };
}

async function postJson(url: string, userId: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user-id": userId },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`request failed with status ${res.status}`);
  return res.json();
}

/** Internal REST clients; base URLs come from configuration. */
export function createWakeRestClients(urls: { schedule: string; ai: string }): {
  schedule: ScheduleWakePort;
  ai: AiWakePort;
} {
  return {
    schedule: {
      reportPhoto: async (userId, challengeId, sentAt) => {
        const json = (await postJson(`${urls.schedule}/wake/photos`, userId, {
          challengeId,
          sentAt,
        })) as { data: { accepted: boolean; challengeKey: string } };
        return json.data;
      },
    },
    ai: {
      gradePhoto: async (userId, request) => {
        await postJson(`${urls.ai}/wake/challenges/${request.challengeId}/photo`, userId, {
          imageBase64: request.imageBase64,
        });
      },
    },
  };
}

/**
 * Ports for schedule's `sendPhotoRequest` and `sendReply`, on top of the shared adapter
 * interface. Messages go to the first channel the user is linked to.
 */
export function createScheduleChatPorts(opts: {
  service: ChannelService;
  channels: ChannelKind[];
  locale: Locale;
  now: () => Date;
}) {
  const pick = (userId: string): ChannelKind => {
    const kind = opts.channels.find((k) => opts.service.isLinked(userId, k));
    if (!kind) throw new Error("user is not linked to any channel");
    return kind;
  };
  const build = (message: MessageRef, isWakeUp: boolean): OutboundMessage => ({
    id: randomUUID(),
    class: "timed",
    message,
    locale: opts.locale,
    sourceService: "schedule",
    isWakeUp,
    createdAt: opts.now().toISOString(),
  });
  return {
    sendPhotoRequest: (userId: string, message: MessageRef, challengeId: string) =>
      opts.service.requestPhoto(userId, pick(userId), build(message, true), challengeId),
    sendReply: (userId: string, message: MessageRef) =>
      opts.service.deliver(userId, pick(userId), build(message, false)),
  };
}
