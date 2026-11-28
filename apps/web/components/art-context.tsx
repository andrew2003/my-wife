"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  defaultExpressionSettings,
  loadExpressions,
  type ExpressionSettings,
} from "../lib/expressions";

export interface ArtContextValue {
  /** False when no private art directory is configured. */
  available: boolean;
  /** The active sticker set and the user's state to expression mapping. */
  expressions: ExpressionSettings;
}

export const ArtContext = createContext<ArtContextValue>({
  available: false,
  expressions: defaultExpressionSettings(),
});

export function useArt(): ArtContextValue {
  return useContext(ArtContext);
}

/** Loads the expression settings once for the shell; defaults apply until then or on failure. */
export function ArtProvider({
  artAvailable,
  children,
}: {
  artAvailable: boolean;
  children: ReactNode;
}) {
  const [expressions, setExpressions] = useState<ExpressionSettings>(defaultExpressionSettings);
  useEffect(() => {
    let live = true;
    void loadExpressions().then((r) => {
      if (live && r.status === "ready") setExpressions(r.settings);
    });
    return () => {
      live = false;
    };
  }, []);
  return (
    <ArtContext.Provider value={{ available: artAvailable, expressions }}>
      {children}
    </ArtContext.Provider>
  );
}
