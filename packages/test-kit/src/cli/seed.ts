import { parseArgs } from "node:util";
import { applySeed, buildSeed, FileSeedStore } from "../seed";

const { values } = parseArgs({
  options: {
    file: { type: "string", default: process.env.SEED_FILE ?? ".demo/seed.json" },
    now: { type: "string" },
    locale: { type: "string", default: process.env.UI_LANGUAGE ?? "vi" },
  },
});

const locale = values.locale === "en" ? "en" : "vi";
const now = values.now ? new Date(values.now) : new Date();
const result = await applySeed(new FileSeedStore(values.file as string), buildSeed(now, locale));
console.log(`seed: ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged`);
