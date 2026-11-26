# Monitor service

Owner: `monitor`, with the browser-side camera and timer code in `apps/web`. Focus monitoring: heartbeats, hard and soft signals, urgent messages, reasons, breaks, tapering supervision. Fault scoring and penalties are in `12-rules.md`.

## 1. Principles

- The user must keep the web app open during their own work windows. No device blocking.
- Camera analysis runs in the browser (MediaPipe, CPU delegate when WebGL or a GPU is not available). Video never leaves the device and images are not stored (principle 5). A single frame goes to a vision model only on appeal or when the result is ambiguous (`monitor.ambiguous_confidence_below`), with consent.
- Camera monitoring requires a computer. A phone uses the checklist, the countdown and chat.
- Only hard signals can add fault points; soft signals only nudge and label.
- Only one monitoring session per user is active at a time. A second device attempting to start receives `session.already_active`.

## 2. Signals

| Signal | Class | Detection | Result |
| --- | --- | --- | --- |
| `heartbeat_lost` | hard | Server-side: no heartbeat for `monitor.heartbeat_missing_seconds` during a window (the browser cannot report its own closing) | Urgent message, possible fault |
| `camera_off` | hard | Client reports track ended or covered (frame variance near zero) | Urgent, possible fault |
| `no_face` | hard | No face for `monitor.no_face_seconds` | Urgent, possible fault |
| `tab_away` | hard | Visibility hidden or window blurred for `monitor.tab_away_seconds` | Urgent, possible fault |
| `looking_away`, `head_down`, `yawn`, `drowsy` | soft | Landmarks / blendshapes | Nudge and label only |
| `late_night` | soft | Web activity after bedtime (see routines) | Label |

Client sends a heartbeat every `monitor.heartbeat_interval_seconds` with filtered events at 2 to 5 fps (`monitor.camera_fps`); events contain type, timestamps and confidence, no images. Reduced fps on slow machines; paused during breaks.

## 3. Urgent escalation

On a hard signal the monitor opens a **reason ticket** and an urgent message that escalates:

1. Web banner with quick reason buttons.
2. After `monitor.urgent_chat_after_seconds` without an answer, send a chat message through `notify`.
3. After `monitor.urgent_silent_fault_after_seconds` without a reason, emit `fault.detected` with `reason = none`.

At most one urgent message per `monitor.urgent_min_gap_minutes` and none during pauses or breaks. Reasons have per-type quotas per week (`reason.quota_per_week`); an honest reason weighs less than silence (scoring is in `rules`). The user has `reason.supplement_window_hours` to add a reason or appeal.

### Reason ticket state machine

`open` -> `answered` | `escalated` -> `expired`; `closed` after the supplement window.

| From | Trigger | To |
| --- | --- | --- |
| `open` | user picks reason | `answered` (emit `reason.given`) |
| `open` | chat delay passes | `escalated` (chat message sent) |
| `escalated` / `open` | user answers | `answered` |
| `escalated` | silent delay passes | `expired` (emit `fault.detected` silent) |
| `answered` / `expired` | supplement window ends | `closed` |

## 4. Breaks and pauses

- A "Pause" button before restroom or water pauses monitoring for up to `monitor.break_max_minutes`, `monitor.breaks_per_day` per day. Exceeding either returns to normal monitoring.
- Pomodoro breaks, meal blocks and long breaks pause monitoring automatically.
- Special mode (sick, travel, holiday) suspends monitoring and penalties.

## 5. Platform outages and server-side history

The server records heartbeat history. A gap that overlaps an admin-declared incident, or a server or network outage detected by the platform (internal health log, within `monitor.outage_gap_margin_seconds`), is automatically `waived_system`; anything else is a fault with the right to appeal. Browser-reported clock values are advisory only.

## 6. Supervision levels (tapering)

`full` -> `no_camera` -> `checklist_only` -> `graduated`.

| From | Trigger | To |
| --- | --- | --- |
| `full` | `monitor.taper_clean_weeks` consecutive clean weeks and the user accepts the proposal | `no_camera` |
| `no_camera` | same | `checklist_only` |
| `checklist_only` | same | `graduated` (no monitoring; reports and optional reminders) |
| any | user asks for stricter | immediate |
| any | user asks for looser | next week or cycle (loosening lock) |

The bot proposes a step down; the user must agree. The graduated level keeps the history.

## 7. Offline check-ins and privacy

Offline tasks use chat check-ins (see `20-schedule.md`). Camera consent is separate (consent `camera`), and a vision-frame appeal needs consent `vision_frame`. Revoking consent stops that feature at once and disables camera supervision.

## 8. Data

`heartbeat` (rolling, aggregated into `presence_interval` for history), `focus_event` (type, class, timestamps, confidence; no images), `reason_ticket`, `reason`, `break`, `monitoring_session`.

## 9. Events

Published: `monitor.session_started`, `monitor.session_ended`, `focus.signal_detected` (soft included), `fault.detected` (hard only), `reason.given`, `reason.expired`, `urgent.sent`, `break.started`, `break.ended`, `supervision.level_changed`, `ask.supervision_taper` (question).

Consumed: `task.started`/`task.ended`/`session.*`, `special_mode.*`, `incident.declared`/`incident.ended`, `user.updated` (windows, consents), `routine.*` (pause for meals/sleep).

## 10. Acceptance

1. Given an active window and no heartbeat for 30 s, When the monitor checks, Then a reason ticket and an urgent message exist and `fault.detected` is not yet emitted.
2. Given the user answers with a reason within 60 s, Then the ticket is `answered` and a fault with an honest reason is scored lighter than silence.
3. Given a yawn or head-down signal, Then no ticket and no fault, only a nudge.
4. Given two urgent signals within 5 minutes, Then one urgent message is sent.
5. Given a gap overlapping a declared incident, Then the fault is `waived_system`.
6. Given a second device starts monitoring, Then it is refused with `session.already_active`.
7. Given WebGL is unavailable, Then the camera analysis falls back to the CPU delegate and the end-to-end test still passes.
8. Given any run, Then no network request carries a video frame, except an appeal frame with consent.
