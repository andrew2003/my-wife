import { describe, expect, it, vi } from "vitest";
import en from "../locales/en.json";
import vi_ from "../locales/vi.json";
import { isPipSupported, openCountdownPip, type PipApi, type PipWindowLike } from "../lib/pip";

function fakeWindow() {
  const listeners: Record<string, () => void> = {};
  const body = { textContent: "" };
  const win: PipWindowLike = {
    document: { body, title: "" },
    addEventListener: (type, fn) => void (listeners[type] = fn),
    close: vi.fn(() => listeners.pagehide?.()),
  };
  return { win, body };
}

describe("picture-in-picture countdown", () => {
  it("reports unsupported without the Document PiP API", () => {
    expect(isPipSupported(undefined)).toBe(false);
    expect(isPipSupported({ requestWindow: async () => fakeWindow().win })).toBe(true);
  });

  it("shows the countdown in a floating window when opened", async () => {
    const f = fakeWindow();
    const api: PipApi = { requestWindow: vi.fn(async () => f.win) };
    const pip = await openCountdownPip(api, { title: "Time remaining" });
    expect(pip).not.toBeNull();
    expect(api.requestWindow).toHaveBeenCalledOnce();
    expect(f.win.document.title).toBe("Time remaining");
    pip!.update("24:59");
    expect(f.body.textContent).toBe("24:59");
    pip!.update("24:58");
    expect(f.body.textContent).toBe("24:58");
  });

  it("returns null when unsupported or the request is rejected", async () => {
    expect(await openCountdownPip(undefined, { title: "t" })).toBeNull();
    const api: PipApi = { requestWindow: async () => Promise.reject(new Error("denied")) };
    expect(await openCountdownPip(api, { title: "t" })).toBeNull();
  });

  it("calls onClose when the window is closed and ignores later updates", async () => {
    const f = fakeWindow();
    const onClose = vi.fn();
    const pip = await openCountdownPip(
      { requestWindow: async () => f.win },
      { title: "t", onClose },
    );
    pip!.update("01:00");
    pip!.close();
    expect(onClose).toHaveBeenCalledOnce();
    pip!.update("00:59");
    expect(f.body.textContent).toBe("01:00");
  });

  it("has the strings in both locales", () => {
    for (const k of ["pip.open", "pip.close", "pip.unsupported"]) {
      expect(en).toHaveProperty([k]);
      expect(vi_).toHaveProperty([k]);
    }
  });
});
