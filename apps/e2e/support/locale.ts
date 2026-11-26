import { readFileSync } from "node:fs";

const file = new URL("../../web/locales/en.json", import.meta.url);
const messages = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;

/** UI text of the `en` locale (the suite builds the web app with UI_LANGUAGE=en). */
export function text(key: string): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`Missing locale key: ${key}`);
  return value;
}
