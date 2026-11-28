// Client-safe art helpers: no Node built-ins, so client components may import this file.
export const ART_SIZES = ["small", "medium", "large"] as const;
export type ArtSize = (typeof ART_SIZES)[number];
export type ArtMode = "light" | "dark";

/** Public URL of an art file; the server maps key, size and mode to a file. */
export function artUrl(key: string, size: ArtSize, mode: ArtMode = "light"): string {
  const base = `/art/${encodeURIComponent(key)}?size=${size}`;
  return mode === "dark" ? `${base}&mode=dark` : base;
}
