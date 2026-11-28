"use client";

import { resolveExpression } from "../lib/expressions";
import { translate, type Locale } from "../lib/i18n";
import {
  stateExpression,
  stateKeys,
  type ScreenStateKeys,
  type ScreenStateKind,
} from "../lib/screen-state";
import { useArt } from "./art-context";
import { Mascot } from "./mascot";
import { EmptyState, ErrorState, Skeleton } from "./ui";

export { stateKeys };

export interface ScreenStateProps {
  locale: Locale;
  kind: ScreenStateKind;
  keys: ScreenStateKeys;
  /** Retry action of the error state. */
  onRetry?: () => void;
  /** Skeleton height; keeps the layout from jumping. */
  height?: string;
}

/**
 * The one loading, empty and error presentation for every screen: a skeleton, a friendly
 * empty state and a retryable error state, both with the art of the active expression.
 */
export function ScreenState({ locale, kind, keys, onRetry, height = "8rem" }: ScreenStateProps) {
  const art = useArt();
  const t = (key: string) => translate(locale, key);
  if (kind === "loading") return <Skeleton label={t(keys.loading)} height={height} />;
  const mascot = (
    <div className="mw-state-art">
      <Mascot
        artKey={resolveExpression(art.expressions, stateExpression(kind))}
        size="small"
        alt=""
        available={art.available}
      />
    </div>
  );
  if (kind === "empty") return <EmptyState title={t(keys.empty)} art={mascot} />;
  return (
    <ErrorState
      title={t(keys.error)}
      art={mascot}
      {...(onRetry ? { retryLabel: t(keys.retry), onRetry } : {})}
    />
  );
}
