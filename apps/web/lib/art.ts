import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { ART_SIZES, artUrl, type ArtMode, type ArtSize } from "./art-url";

export { ART_SIZES, artUrl };
export type { ArtMode, ArtSize };

/** Allowed image extensions, in lookup order, with their content types. */
const EXTENSIONS: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  avif: "image/avif",
};

/** Art keys are board names: lower-case words joined by dashes. */
const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const CREDITS_FILE = "credits.txt";

/** The private art directory from MASCOT_ART_DIR, or null when unset or blank. */
export function artDirectory(env: Record<string, string | undefined>): string | null {
  const value = env.MASCOT_ART_DIR?.trim();
  return value ? value : null;
}

export function isArtKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export function isArtSize(value: string): value is ArtSize {
  return (ART_SIZES as readonly string[]).includes(value);
}

export interface ArtFile {
  path: string;
  contentType: string;
}

/**
 * Maps a key, size and mode to a file. Names come from the directory listing
 * (an allowlist), never from joining request text onto a path. A variant is
 * `<key>.<size>.<ext>`; with only originals (`<key>.<ext>`) the original is served.
 * Dark mode looks for `<key>-dark` first and then the light key.
 */
export async function resolveArtFile(
  dir: string,
  key: string,
  size: ArtSize,
  mode: ArtMode,
): Promise<ArtFile | null> {
  if (!isArtKey(key)) return null;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
  const keys = mode === "dark" ? [`${key}-dark`, key] : [key];
  for (const k of keys) {
    for (const stem of [`${k}.${size}`, k]) {
      for (const [ext, contentType] of Object.entries(EXTENSIONS)) {
        const name = `${stem}.${ext}`;
        if (files.has(name)) return { path: join(dir, name), contentType };
      }
    }
  }
  return null;
}

/** The credit text kept inside the private directory; null when absent. */
export async function readCredits(dir: string | null): Promise<string | null> {
  if (!dir) return null;
  try {
    const text = (await readFile(join(dir, CREDITS_FILE), "utf8")).trim();
    return text || null;
  } catch {
    return null;
  }
}
