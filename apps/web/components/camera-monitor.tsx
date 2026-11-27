"use client";

import { useRef, useState } from "react";
import {
  createCameraMonitor,
  detectWebgl,
  documentVisibility,
  httpHeartbeatSender,
  selectDelegate,
  type Delegate,
  type FrameAnalyzer,
} from "../lib/camera-monitor";
import { createFrameGuardedFetch } from "../lib/frame-guard";
import { translate, type Locale } from "../lib/i18n";

/** Placeholder analyser until the MediaPipe landmarker is wired in: it reports nothing. */
const quietAnalyzer: FrameAnalyzer = { analyze: () => [] };

export function CameraMonitor(props: {
  locale: Locale;
  sessionId: string;
  forcedDelegate?: string;
  /** `monitor.heartbeat_interval_seconds`, supplied by the page. */
  heartbeatEverySeconds: number;
}) {
  const { locale, sessionId, forcedDelegate, heartbeatEverySeconds } = props;
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"idle" | "running" | "denied">("idle");
  const [delegate, setDelegate] = useState<Delegate | null>(null);

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      if (video.current) {
        video.current.srcObject = stream;
        await video.current.play();
      }
      setDelegate(selectDelegate({ webglAvailable: detectWebgl(), forced: forcedDelegate }));
      createCameraMonitor({
        sessionId,
        heartbeatEverySeconds,
        // The frame stays in the page; only the analyser sees it.
        grabFrame: () => video.current,
        analyzer: quietAnalyzer,
        send: httpHeartbeatSender(createFrameGuardedFetch()),
        onVisibility: documentVisibility,
      }).start();
      setState("running");
    } catch {
      setState("denied");
    }
  }

  return (
    <section>
      <video ref={video} muted playsInline hidden />
      {state === "idle" && (
        <button type="button" onClick={() => void start()}>
          {translate(locale, "monitor.start")}
        </button>
      )}
      {state === "running" && (
        <p data-testid="monitor-status">
          {translate(locale, "monitor.running")}{" "}
          {delegate && translate(locale, "monitor.delegate", { delegate })}
        </p>
      )}
      {state === "denied" && <p role="alert">{translate(locale, "monitor.denied")}</p>}
    </section>
  );
}
