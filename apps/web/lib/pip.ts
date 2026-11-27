/** Minimal shape of a Document Picture-in-Picture window (Chrome, Edge). */
export interface PipWindowLike {
  document: { title: string; body: { textContent: string | null; style?: Record<string, string> } };
  addEventListener(type: "pagehide", fn: () => void): void;
  close(): void;
}

/** Minimal shape of `window.documentPictureInPicture`. */
export interface PipApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<PipWindowLike>;
}

export interface CountdownPip {
  /** Writes the formatted remaining time into the floating window. */
  update(text: string): void;
  close(): void;
}

export function isPipSupported(api: PipApi | undefined): api is PipApi {
  return !!api && typeof api.requestWindow === "function";
}

/** The browser API when present; undefined on Firefox, Safari and during server rendering. */
export function browserPipApi(): PipApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { documentPictureInPicture?: PipApi }).documentPictureInPicture;
}

/**
 * Opens the floating window. Must be called from a user gesture. Resolves to null when the
 * API is missing or the browser refuses, so the caller keeps the in-page countdown.
 */
export async function openCountdownPip(
  api: PipApi | undefined,
  opts: { title: string; onClose?: () => void; width?: number; height?: number },
): Promise<CountdownPip | null> {
  if (!isPipSupported(api)) return null;
  let win: PipWindowLike;
  try {
    win = await api.requestWindow({ width: opts.width ?? 240, height: opts.height ?? 120 });
  } catch {
    return null;
  }
  win.document.title = opts.title;
  const style = win.document.body.style;
  if (style) {
    style.margin = "0";
    style.display = "grid";
    style.placeItems = "center";
    style.height = "100vh";
    style.font = "600 40px system-ui, sans-serif";
    style.fontVariantNumeric = "tabular-nums";
  }
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    opts.onClose?.();
  };
  win.addEventListener("pagehide", finish);
  return {
    update(text) {
      if (!closed) win.document.body.textContent = text;
    },
    close() {
      if (closed) return;
      win.close();
      finish();
    },
  };
}
