import { randomUUID } from "node:crypto";
import { loadConfig } from "@my-wife/config";
import { SETTINGS, type ChannelKind, type EventEnvelope } from "@my-wife/contracts";
import {
  DiscordFake,
  SimClock,
  TelegramFake,
  createFakeDiscordChannel,
  createFakeTelegramChannel,
} from "@my-wife/test-kit";
// The dev runner and notify export no package entry point for these parts; mount them from sources.
import { mountSleepJob, startAll } from "../../dev-runner/src/runner";
import {
  ChannelService,
  InMemoryChannelLinkStore,
} from "../../../services/notify/src/channels/channel-service";
import { createDispatcher, InMemoryInbox } from "../../../services/notify/src/dispatch/dispatcher";
import {
  createScheduleChatPorts,
  createWakePhotoHandler,
  createWakeRestClients,
} from "../../../services/notify/src/wake/wake-photo";

export const TELEGRAM_USER = "0190a0a0-0000-7000-8000-0000000000f4";
export const DISCORD_USER = "0190a0a0-0000-7000-8000-0000000000f5";
export const TELEGRAM_CHAT = "4242";
export const DISCORD_CHANNEL = "77001";
export const DISCORD_AUTHOR = "9001";
const MINUTE_MS = 60_000;

/**
 * The routines flow of two users, one on Telegram and one on Discord, in one process on one
 * `SimClock`: schedule (sleep and wake jobs), ai (challenge and fake vision grading), notify's
 * channel service with the shared adapter interface, against the emulated Telegram and Discord
 * servers. Every job receives `now` from the simulator.
 *
 * Bridges stand in for wiring that does not exist yet: `routine.reminder_due` to a chat message,
 * the challenge id of schedule to the one ai knows (#254), and `ai.photo_graded` to schedule
 * (#253). Chat servers receive locale keys as text (the reference channels of the test kit).
 */
export async function startRoutinesWorld(opts: {
  start: string;
  /**
   * Settings both users share (schedule, ai and the dispatcher read them on every call, so a
   * scenario may change them mid-run); anything missing is the registry default.
   */
  settings?: Record<string, unknown>;
  /** Also runs the routine reminder job (meals) every minute of simulated time. */
  routineJobs?: boolean;
}) {
  const settings = opts.settings ?? {};
  const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
  const clock = new SimClock(opts.start);
  const now = () => clock.now();
  const events: EventEnvelope[] = [];
  const challengeOwner = new Map<string, string>();

  const telegram = new TelegramFake({ clock });
  const discord = new DiscordFake({ clock });
  await telegram.start();
  await discord.start();

  const links = new InMemoryChannelLinkStore();
  links.add({ userId: TELEGRAM_USER, channel: "telegram", externalId: TELEGRAM_CHAT });
  links.add({ userId: DISCORD_USER, channel: "discord", externalId: DISCORD_CHANNEL });

  // Filled once the runner is up; the callbacks below run only after that.
  let urls = {} as Awaited<ReturnType<typeof startAll>>["urls"];
  const rest = createWakeRestClients({
    get schedule() {
      return urls.schedule;
    },
    get ai() {
      return urls.ai;
    },
  });
  const service = new ChannelService({
    channels: [createFakeTelegramChannel(telegram), createFakeDiscordChannel(discord)],
    links,
    publish: async () => undefined,
    onPhoto: createWakePhotoHandler(rest),
  });
  const channelOf = (userId: string): ChannelKind =>
    userId === TELEGRAM_USER ? "telegram" : "discord";
  // Routine reminders pass notify's dispatcher, so quiet hours apply to them (the wake challenge
  // is the wake-up message and goes straight out).
  const inbox = new InMemoryInbox();
  const dispatcher = createDispatcher({
    now,
    settings: {
      get: async () => ({
        quietHours: (settings["notify.quiet_hours"] ?? SETTINGS["notify.quiet_hours"].default) as {
          from: string;
          to: string;
        },
        timeZone: (settings["calendar.time_zone"] ?? "Asia/Ho_Chi_Minh") as string,
      }),
    },
    inbox,
    deliver: async (userId, message) =>
      void (await service.deliver(userId, channelOf(userId), message)),
    deliverDigest: async () => undefined,
    publish: async () => undefined,
  });
  const ports = createScheduleChatPorts({
    service,
    channels: ["telegram", "discord"] as ChannelKind[],
    locale: "en",
    now,
  });

  const headersOf = (userId: string) => ({
    "content-type": "application/json",
    "x-user-id": userId,
  });
  const postAs = (userId: string, url: string, payload?: unknown) =>
    fetch(url, { method: "POST", headers: headersOf(userId), body: JSON.stringify(payload ?? {}) });
  const getAs = (userId: string, url: string) => fetch(url, { headers: headersOf(userId) });

  const runner = await startAll(config, {
    ephemeralPorts: true,
    schedule: {
      now,
      readSettings: async () => settings,
      publish: async (e) => {
        events.push(e);
        if (e.type === "routine.reminder_due") {
          const p = e.payload as { messageKey: string; params: Record<string, string | number> };
          await dispatcher.send(e.userId, {
            id: randomUUID(),
            class: "timed",
            message: { key: p.messageKey, params: p.params },
            locale: "en",
            sourceService: "schedule",
            isWakeUp: false,
            createdAt: now().toISOString(),
          });
        }
      },
      sendPhotoRequest: ports.sendPhotoRequest,
      sendReply: ports.sendReply,
      // schedule asks ai for the challenge, so both services know the same challenge id.
      generateWakeChallenge: async (userId) => {
        const res = await postAs(userId, `${urls.ai}/wake/challenges`);
        const body = (await res.json()) as {
          data: { challengeId: string; message: { key: string; params: Record<string, number> } };
        };
        challengeOwner.set(body.data.challengeId, userId);
        return { challengeId: body.data.challengeId, ...body.data.message };
      },
    },
    ai: {
      now,
      readSettings: async () => settings,
      publish: async (e) => {
        if (e.name !== "ai.photo_graded") return;
        const payload = e.payload as { challengeId: string };
        const envelope = {
          id: `ai-photo-graded-${payload.challengeId}`,
          type: "ai.photo_graded",
          occurredAt: now().toISOString(),
          userId: challengeOwner.get(payload.challengeId) ?? "",
          schemaVersion: 1,
          payload,
        } as EventEnvelope;
        events.push(envelope);
        await runner.publish(envelope);
        await fetch(`${urls.schedule}/events/photo-graded`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(envelope),
        });
      },
    },
  });
  urls = runner.urls;

  mountSleepJob(runner, clock, MINUTE_MS);
  clock.scheduleEvery(
    MINUTE_MS,
    async () => void (await postAs(TELEGRAM_USER, `${urls.schedule}/jobs/wake`)),
  );
  if (opts.routineJobs) {
    clock.scheduleEvery(
      MINUTE_MS,
      async () => void (await postAs(TELEGRAM_USER, `${urls.schedule}/jobs/routines`)),
    );
  }

  // The Discord bot's gateway connection: dispatch frames are handed to the channel service.
  const frames: unknown[] = [];
  let frameWaiter: (() => void) | undefined;
  const socket = new WebSocket(discord.gatewayUrl);
  await new Promise<void>((resolve, reject) => {
    socket.onerror = () => reject(new Error("discord gateway connection failed"));
    socket.onmessage = (m) => {
      const frame = JSON.parse(String(m.data)) as { op: number; t?: string };
      if (frame.op === 10) socket.send(JSON.stringify({ op: 2, d: { token: discord.token } }));
      else if (frame.t === "READY") resolve();
      else if (frame.op === 0) {
        frames.push(frame);
        frameWaiter?.();
      }
    };
  });

  return {
    clock,
    events,
    inbox,
    settings,
    urls,
    telegram,
    discord,
    types: () => events.map((e) => e.type),
    ofType: <T extends EventEnvelope["type"]>(type: T) =>
      events.filter((e) => e.type === type) as EventEnvelope<T>[],
    postAs,
    getAs,
    /** Feeds what the Telegram bot would receive by polling to the channel service. */
    pollTelegram: async () => {
      const res = await fetch(`${telegram.url}/bot${telegram.token}/getUpdates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const { result } = (await res.json()) as { result: Array<{ update_id: number }> };
      await fetch(`${telegram.url}/bot${telegram.token}/getUpdates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ offset: (result.at(-1)?.update_id ?? 0) + 1 }),
      });
      for (const update of result) await service.handleUpdate("telegram", update);
    },
    /** Feeds the frames the Discord bot received over its gateway to the channel service. */
    drainDiscord: async () => {
      if (frames.length === 0) {
        // The frame is on its way over the socket: wait for it, with an upper bound.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("no discord frame arrived")), 5000);
          frameWaiter = () => {
            clearTimeout(timer);
            frameWaiter = undefined;
            resolve();
          };
        });
      }
      for (const frame of frames.splice(0)) await service.handleUpdate("discord", frame);
    },
    stop: async () => {
      socket.close();
      await runner.stop();
      await telegram.stop();
      await discord.stop();
    },
  };
}

export type RoutinesWorld = Awaited<ReturnType<typeof startRoutinesWorld>>;
