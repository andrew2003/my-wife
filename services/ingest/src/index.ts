export { createApp, SERVICE_NAME, WEBHOOK_PATH, SECRET_HEADER, type IngestDeps } from "./app";
export { createMailauthVerifier, type DkimVerifier, type DnsResolver } from "./dkim";
export { fingerprintOfMail, type PipelineDeps, type SenderMapEntry } from "./pipeline";
export { assertTransition, canTransition } from "./receipt-state";
export { MemoryIngestStore, type IngestStore, type ReceiptRecord } from "./store";
export {
  BASIC_BANK_TEMPLATE,
  FOREIGN_CARD_TEMPLATE,
  fingerprintTemplate,
  type RegisteredTemplate,
  type TemplateParser,
} from "./templates";
