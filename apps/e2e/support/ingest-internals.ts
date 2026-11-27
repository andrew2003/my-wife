/**
 * The ingest package exports only `createApp`. The scenario needs the DKIM verifier, the
 * receipt store and the two registered templates to mount the webhook with test settings, so it
 * reads them from the package sources. Replace this file once ingest exports them.
 */
export { createMailauthVerifier } from "../../../services/ingest/src/dkim";
export { MemoryIngestStore } from "../../../services/ingest/src/store";
export {
  BASIC_BANK_TEMPLATE,
  FOREIGN_CARD_TEMPLATE,
  fingerprintTemplate,
} from "../../../services/ingest/src/templates";
