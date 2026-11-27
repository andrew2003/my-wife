import { loadConfig, servicePort } from "@my-wife/config";
import { type EventEnvelope } from "@my-wife/contracts";
import { connectNats, subject } from "@my-wife/service-kit";
import { createApp, SERVICE_NAME } from "./app";
import {
  CONTRACT_SIGNED_SUBJECT,
  createSettingsReader,
  RECEIPT_SUBJECT,
  RECEIPT_UNKNOWN_SUBJECT,
  REPLY_RECEIVED_SUBJECT,
  runEventConsumer,
  runOnboardingConsumer,
  WEEK_CLOSED_SUBJECT,
  WEEK_PLANNED_SUBJECT,
} from "./consumer";

const config = loadConfig(process.env);
const nats = await connectNats(config.natsUrl, SERVICE_NAME);
const prefix = config.natsSubjectPrefix;
const identityUrl = process.env.IDENTITY_URL ?? `http://localhost:${servicePort("identity")}`;
const app = await createApp(config, {
  nats,
  publish: (event: EventEnvelope) => {
    nats.publish(subject(prefix, event.type), JSON.stringify(event));
  },
  readSettings: createSettingsReader({ identityUrl }),
});

void runOnboardingConsumer({
  nats,
  prefix,
  handler: app.onOnboardingStepCompleted,
  log: app.log,
});

void runEventConsumer({
  nats,
  prefix,
  type: RECEIPT_SUBJECT,
  handler: app.onReceiptParsed,
  log: app.log,
});

void runEventConsumer({
  nats,
  prefix,
  type: RECEIPT_UNKNOWN_SUBJECT,
  handler: app.onReceiptUnknown,
  log: app.log,
});

void runEventConsumer({
  nats,
  prefix,
  type: REPLY_RECEIVED_SUBJECT,
  handler: app.onReplyReceived,
  log: app.log,
});

void runEventConsumer({
  nats,
  prefix,
  type: CONTRACT_SIGNED_SUBJECT,
  handler: app.onContractSigned,
  log: app.log,
});

void runEventConsumer({
  nats,
  prefix,
  type: WEEK_CLOSED_SUBJECT,
  handler: app.onWeekClosed,
  log: app.log,
});

void runEventConsumer({
  nats,
  prefix,
  type: WEEK_PLANNED_SUBJECT,
  handler: app.onWeekPlanned,
  log: app.log,
});

await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? servicePort(SERVICE_NAME)) });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => nats.drain());
  });
}
