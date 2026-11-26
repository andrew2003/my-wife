import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { servicePort } from "@my-wife/config";
import {
  BANK_DKIM_DOMAIN,
  buildEmailFixtures,
  createDkimKey,
  dkimTxtRecord,
  injectEmails,
  type DkimKey,
} from "../emails";

const { values } = parseArgs({
  options: {
    url: {
      type: "string",
      default:
        process.env.INGEST_WEBHOOK_URL ??
        `http://localhost:${servicePort("ingest")}/webhook/inbound-email`,
    },
    secret: { type: "string", default: process.env.INGEST_WEBHOOK_SECRET },
    to: { type: "string", default: process.env.DEMO_FORWARD_ADDRESS ?? "u-demo@in.example.test" },
    only: { type: "string", multiple: true },
    keys: { type: "string", default: process.env.DKIM_KEY_FILE ?? ".demo/dkim-keys.json" },
    list: { type: "boolean", default: false },
  },
});

/** Test keys persist so the published DNS record stays valid between runs. */
function loadKeys(file: string): { bank: DkimKey; attacker: DkimKey } {
  if (existsSync(file))
    return JSON.parse(readFileSync(file, "utf8")) as { bank: DkimKey; attacker: DkimKey };
  const keys = { bank: createDkimKey("test"), attacker: createDkimKey("attacker") };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

const keys = loadKeys(values.keys as string);
const fixtures = await buildEmailFixtures({
  bankKey: keys.bank,
  attackerKey: keys.attacker,
  now: new Date(),
  toAddress: values.to as string,
});

if (values.list) {
  for (const f of fixtures) console.log(`${f.name}\t${f.expect.state}\tdkim=${f.expect.dkim}`);
  console.log(
    `\nTest DKIM key for ${BANK_DKIM_DOMAIN}: ${keys.bank.selector}._domainkey TXT "${dkimTxtRecord(keys.bank)}"`,
  );
} else {
  if (!values.secret) throw new Error("Set INGEST_WEBHOOK_SECRET or pass --secret");
  const results = await injectEmails(fixtures, {
    url: values.url as string,
    secret: values.secret,
    only: values.only,
  });
  for (const r of results) {
    const expected = fixtures.find((f) => f.name === r.name)!.expect.state;
    console.log(`${r.name}\tHTTP ${r.status}\texpected=${expected}\t${JSON.stringify(r.body)}`);
  }
}
