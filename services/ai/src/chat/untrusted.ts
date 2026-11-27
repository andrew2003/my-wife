/** Where untrusted text came from. */
export type UntrustedSource = "email" | "chat_paste";

const TAG = "untrusted_data";

/**
 * Wraps email fields and pasted chat text as inert data. A tag inside the content is escaped so
 * the content cannot end the wrapper early and pose as an instruction.
 */
export function wrapUntrusted(text: string, source: UntrustedSource): string {
  const safe = text.replace(new RegExp(`<(/?)${TAG}`, "gi"), `&lt;$1${TAG}`);
  return `<${TAG} source="${source}">\n${safe}\n</${TAG}>`;
}
