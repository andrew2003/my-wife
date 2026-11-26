import { describe, expect, it } from "vitest";
import { createWakePhotoHandler } from "../src/wake/wake-photo";
import type { PhotoHandoff } from "../src/channels/channel-service";

const CID = "7b0f6f58-0c52-4a3c-9a43-2a0f4b1b9a11";
const SENT = "2026-11-23T23:02:00.000Z";

function photo(overrides: Partial<PhotoHandoff> = {}): PhotoHandoff {
  return {
    channel: "telegram",
    externalId: "chat-1",
    userId: "u1",
    bytes: new Uint8Array([1, 2, 3]),
    challengeId: CID,
    sentAt: SENT,
    ...overrides,
  };
}

function setup(accepted: boolean) {
  const calls: string[] = [];
  const graded: { userId: string; body: Record<string, unknown> }[] = [];
  const handler = createWakePhotoHandler({
    schedule: {
      reportPhoto: async (userId, challengeId, sentAt) => {
        calls.push(`schedule:${userId}:${challengeId}:${sentAt}`);
        return { accepted, challengeKey: "routine.wake_challenge.sink" };
      },
    },
    ai: {
      gradePhoto: async (userId, body) => {
        calls.push("ai");
        graded.push({ userId, body });
      },
    },
  });
  return { handler, calls, graded };
}

describe("wake photo hand-off", () => {
  it("reports the send time to schedule, then hands the photo to ai as GradePhotoRequest", async () => {
    const { handler, calls, graded } = setup(true);
    await handler(photo());
    expect(calls).toEqual([`schedule:u1:${CID}:${SENT}`, "ai"]);
    expect(graded[0]!.userId).toBe("u1");
    expect(graded[0]!.body).toEqual({
      challengeId: CID,
      challengeKey: "routine.wake_challenge.sink",
      imageBase64: Buffer.from([1, 2, 3]).toString("base64"),
    });
  });

  it("does not send the photo to ai when schedule does not accept it", async () => {
    const { handler, calls } = setup(false);
    await handler(photo());
    expect(calls).toEqual([`schedule:u1:${CID}:${SENT}`]);
  });

  it("ignores a photo that belongs to no challenge", async () => {
    const { handler, calls } = setup(true);
    await handler(photo({ challengeId: null }));
    expect(calls).toEqual([]);
  });

  it("wipes the image bytes in every outcome", async () => {
    const ok = setup(true);
    const a = photo();
    await ok.handler(a);
    expect([...a.bytes]).toEqual([0, 0, 0]);
    const late = setup(false);
    const b = photo();
    await late.handler(b);
    expect([...b.bytes]).toEqual([0, 0, 0]);
  });
});

describe("schedule chat ports", () => {
  it("sends the challenge as a wake-up photo request and replies as plain messages", async () => {
    const { createScheduleChatPorts } = await import("../src/wake/wake-photo");
    const sent: string[] = [];
    const service = {
      isLinked: (_u: string, k: string) => k === "discord",
      requestPhoto: async (_u: string, k: string, m: { isWakeUp: boolean }, id: string) =>
        void sent.push(`photo:${k}:${m.isWakeUp}:${id}`),
      deliver: async (_u: string, k: string, m: { message: { key: string } }) =>
        void sent.push(`reply:${k}:${m.message.key}`),
    };
    const ports = createScheduleChatPorts({
      service: service as never,
      channels: ["telegram", "discord"],
      locale: "vi",
      now: () => new Date(SENT),
    });
    await ports.sendPhotoRequest("u1", { key: "routine.wake_challenge.sink", params: {} }, CID);
    await ports.sendReply("u1", { key: "routine.wake_photo_late", params: {} });
    expect(sent).toEqual([`photo:discord:true:${CID}`, "reply:discord:routine.wake_photo_late"]);
  });
});
