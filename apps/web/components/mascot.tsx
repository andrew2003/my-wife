import { artUrl, type ArtSize } from "../lib/art";

/** Original wave motif with initials; stands in whenever there is no private art. */
export function FallbackArt({ initials, label }: { initials?: string; label?: string }) {
  return (
    <svg
      className="fallback-art"
      viewBox="0 0 120 120"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle cx="60" cy="60" r="58" fill="var(--mw-color-primary)" />
      <path
        d="M8 78 C28 58 44 98 64 78 S100 58 112 74 L112 96 A58 58 0 0 1 8 96 Z"
        fill="var(--mw-color-accent)"
        opacity="0.85"
      />
      <path d="M60 34 C52 44 52 52 60 56 C68 52 68 44 60 34 Z" fill="var(--mw-color-on-primary)" />
      {initials ? (
        <text x="60" y="112" textAnchor="middle" fontSize="16" fill="var(--mw-color-on-primary)">
          {initials}
        </text>
      ) : null}
    </svg>
  );
}

interface MascotProps {
  artKey: string;
  size: ArtSize;
  alt: string;
  /** False when no private art directory is configured. */
  available: boolean;
  initials?: string;
}

/**
 * Art by key, size and mode. A picture element lets prefers-color-scheme pick the
 * dark file with no script; without art the original fallback is drawn.
 */
export function Mascot({ artKey, size, alt, available, initials }: MascotProps) {
  if (!available) return <FallbackArt label={alt} {...(initials ? { initials } : {})} />;
  return (
    <picture>
      <source media="(prefers-color-scheme: dark)" srcSet={artUrl(artKey, size, "dark")} />
      <img className="mascot-art" src={artUrl(artKey, size)} alt={alt} loading="lazy" />
    </picture>
  );
}
