#!/usr/bin/env node
// Generates size variants of the private character art, once, on a developer machine.
//
// Usage: MASCOT_ART_DIR=/path/outside/repo node scripts/generate-art-variants.mjs [dir]
//
// For every original `<key>.<ext>` in the private art directory (the same
// MASCOT_ART_DIR the web app reads), it writes `<key>.<size>.<ext>` next to it,
// which is the layout the art route serves. Nothing is resized at run time and
// nothing is written inside the repository: a directory inside it is refused.
//
// Sizes are a default, configurable with ART_VARIANT_WIDTHS, for example
// "small=256,medium=640,large=1280" (name=width in pixels). The image library
// (sharp) is a root devDependency, loaded only when the script really resizes.
import { readdir, mkdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, isAbsolute, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

/** Default variant widths in pixels, by size name (matches the web ART_SIZES). */
export const DEFAULT_WIDTHS = { small: 256, medium: 640, large: 1280 };

const IMAGE_EXTENSIONS = new Set([".webp", ".png", ".jpg", ".jpeg", ".avif"]);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Parses "name=width,name=width"; unset or blank gives the defaults. */
export function parseWidths(text) {
  if (!text || !text.trim()) return { ...DEFAULT_WIDTHS };
  const widths = {};
  for (const part of text.split(",")) {
    const [name, value] = part.split("=").map((s) => s.trim());
    const width = Number(value);
    if (!/^[a-z][a-z0-9]*$/.test(name ?? "") || !Number.isInteger(width) || width <= 0) {
      throw new Error(`Invalid ART_VARIANT_WIDTHS entry: "${part}"`);
    }
    widths[name] = width;
  }
  return widths;
}

export function isInsideRepository(dir, root = REPO_ROOT) {
  const rel = relative(root, resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Default resizer: sharp, loaded lazily. Never enlarges an image. */
export async function sharpResize(input, output, width) {
  const { default: sharp } = await import("sharp");
  await sharp(input).resize({ width, withoutEnlargement: true }).toFile(output);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes the missing variants for every original in `dir`. Existing variants are
 * kept, and files that are already variants are not used as originals.
 */
export async function generateVariants({ dir, widths = DEFAULT_WIDTHS, resize = sharpResize }) {
  if (isInsideRepository(dir)) {
    throw new Error("Refusing to write inside the repository: use a private directory outside it");
  }
  const sizes = Object.keys(widths);
  const entries = await readdir(dir, { withFileTypes: true });
  const created = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;
    const stem = basename(entry.name, extname(entry.name));
    const innerExt = extname(stem).slice(1);
    if (sizes.includes(innerExt)) continue; // already a variant
    for (const size of sizes) {
      const target = join(dir, `${stem}.${size}${extname(entry.name)}`);
      if (await exists(target)) continue;
      await mkdir(dirname(target), { recursive: true });
      await resize(join(dir, entry.name), target, widths[size]);
      created.push(target);
    }
  }
  return { created };
}

async function main() {
  const dir = process.argv[2] ?? process.env.MASCOT_ART_DIR?.trim();
  if (!dir) {
    console.error("Set MASCOT_ART_DIR or pass the private art directory as an argument.");
    process.exit(1);
  }
  const widths = parseWidths(process.env.ART_VARIANT_WIDTHS);
  const { created } = await generateVariants({ dir, widths });
  console.log(`Created ${created.length} variant(s) in ${dir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
