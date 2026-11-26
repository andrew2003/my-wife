# Rules service

Owner: `rules`. Fault points, penalties, trial mode, waivers, appeals, the commitment contract and the loosening lock. Principles 3 and 4: penalties rest only on hard facts, with an audit trail and an appeal; code decides, the LLM only proposes.

## 1. Pure functions (each with table-driven tests)

All take explicit inputs and `now`; none read the clock or the database.

| Function | Input | Output |
| --- | --- | --- |
| `computeOverspendPenalty` | category priority, weekly limit, spent, exception used, settings | excess, penalty amount, limit deduction, warning-only flag for `need` when `penalty.need_overspend_mode` is `warn_only` |
| `scoreFault` | fault type, reason (none / honest / quota-exceeded), settings | points |
| `applyWaivers` | faults in the week, waivers available, system-fault flags | faults waived, points left |
| `computePenaltyForWeek` | fault points, thresholds, weekly cap, carried debt | penalty amount, capped amount, new carry-over |
| `allocatePenaltySource` | penalty amount, user's ordered `want` list with remaining limits | deductions per category, shortfall (becomes penalty debt) |
| `settleTrial` | suspended entries, appeals, installments K | real penalty schedule |
| `isLooseningChange` | old rule, new rule | boolean; decides effective-from |
| `computeWithdrawalPenalty` | withdrawn amount, settings | repayment plus extra penalty |
| `clearPoints` | week result, settings | points to clear, reward eligibility |

Re-running a function on the stored inputs during an appeal must give the original output unless the appeal changed an input.

## 2. Fault points

- Only **hard signals** add points: `heartbeat_lost`, `camera_off`, `no_face`, `tab_away`, and (at routine level `commit`) `wake_late` and `bedtime_missed`. Soft signals (looking away, head down, yawning, drowsy, late-night label) never add points.
- Points = `fault.weight.<type>` times the reason multiplier: an honest reason is lighter (`fault.reason_multiplier_percent.honest`), silence is full (`silent`). A reason beyond the per-type weekly quota (`reason.quota_per_week`) is treated as `silent`.
- Each fault is scored with the rules in force when it happened (point-in-time). A later rule change never rewrites recorded faults.
- A fault entry holds: `type`, `occurred_at`, `signal_ref`, `reason_ref?`, `weight_snapshot`, `points`, `status` (see below), `waiver?`, `system_cause?`.

### Fault state machine

`pending_reason` -> `recorded` -> (`appealed` -> `upheld` | `overturned`) ; also `waived_system`, `waived_card`, `expired`.

| From | Trigger | To |
| --- | --- | --- |
| (new) | `fault.detected` from monitor | `pending_reason` |
| `pending_reason` | reason given in time | `recorded` (honest multiplier) |
| `pending_reason` | `monitor.urgent_silent_fault_after_seconds` elapsed with no reason | `recorded` (silent) |
| `pending_reason` / `recorded` | overlaps an admin incident or a server heartbeat gap during a platform outage, or an `ai`/parser misread confirmed | `waived_system` (removed from totals, shown in the report) |
| `recorded` | user spends a waiver card | `waived_card` (limited by `fault.waivers_per_week`) |
| `recorded` | user files appeal within `appeal.window_hours` | `appealed` |
| `appealed` | decision | `upheld` (stays) or `overturned` (removed) |

Supplementing a reason within `reason.supplement_window_hours` re-scores the fault.

## 3. Weekly penalty computation

1. At week close sum points of faults in `recorded` (excluding waived and overturned).
2. Find the highest threshold reached in `fault.thresholds`; its `amount_vnd` is the raw monitoring penalty.
3. Add carried penalty debt, then cap at `penalty.weekly_cap_vnd`; the excess carries to next week as penalty debt.
4. `allocatePenaltySource`: deduct from `want` categories in `penalty.want_deduction_order`, never from `need`. If the sources are exhausted the shortfall becomes penalty debt and carries over.
5. A clean week (zero recorded points) clears accumulated points when `fault.clean_week_clears_points`; a clean streak of `reward.clean_streak_days` unlocks `reward.unlock_amount_vnd` in a `want` category or from the penalty fund as the user configured.

Overspend penalties (from `budget`) are separate: 100% of the excess is deducted from next week's limit of the same category; the monitoring cap applies to monitoring and routine penalties only (overspend is already self-limited by the excess). Both create entries in the penalty ledger.

## 4. Penalty ledger and penalty savings

Penalty ledger entry: `id`, `source` (`overspend`, `monitoring`, `routine`, `withdrawal`), `amount_vnd`, `status` (`suspended`, `due`, `paid`), `due_date`, `transfer_code` (`MW-PH-...`), `payment_transaction_id?`, `audit_refs[]`.

| From | Trigger | To |
| --- | --- | --- |
| (new, outside trial) | penalty computed | `due` |
| (new, in trial) | penalty computed | `suspended` |
| `suspended` | trial ends and appeal window passes | `due` (single payment or K installments) |
| `suspended` | appeal upheld or waiver | removed with audit |
| `due` | receipt for the `MW-PH-...` code received in the penalty savings account | `paid` |
| `due` | past `due_date` + `penalty.payment_grace_days` | still `due`, result `penalty_unpaid`, reminder escalation, carried like normal debt |

Penalty savings is a separate bank account. It does not count toward the fixed savings contribution or the surplus share. Money out of it is a serious violation: the user must repay it and pay `penalty.withdrawal_extra_percent` extra (`computeWithdrawalPenalty`). Detection comes from receipts and weekly balance reconciliation (`penalty_savings.withdrawal_detected`). It unlocks only under the condition written in the commitment contract (a maturity date or a goal); changing the condition is a loosening change.

## 5. Trial mode

- Length `trial.weeks`. The trial clock is independent of cycles.
- Inside the trial, all fault points, thresholds and amounts are computed as if real, but entries are `suspended`; the weekly report states "suspended penalties so far: X VND".
- Rule changes in the trial apply only to later faults (point-in-time rule lock).
- Auto-waivers (`waived_system`): admin incident, server heartbeat gap overlapping a platform outage, a confirmed misread, a successful appeal.
- End: send a per-fault summary and open the final appeal window `trial.final_appeal_hours`. After it, suspended totals become real `due` entries, paid at once or in `trial.installments_k` equal installments (K fixed when trial is enabled, immutable afterwards).
- Turning off the trial early ends it immediately. Deleting the account does not erase suspended penalties (see `40-identity-onboarding.md`).

## 6. Commitment contract

Per cycle the user signs a contract summarizing: budget rules, supervision windows, penalty thresholds and cap, routines at `commit` level, and the penalty-savings unlock condition. A signed version is immutable and versioned. The contract id is attached to the cycle and to each penalty entry.

Loosening lock: tightening takes effect immediately; loosening (lower penalty, fewer supervision hours, switching `commit` off, raising a `want` limit, changing the unlock condition) takes effect from `loosening.effective_from` (next week; next cycle for budget rules). `isLooseningChange` is the single decision function. The effective date is shown in the UI and stored.

## 7. Appeals

Anything penalizing can be appealed: a fault, a classification after week close, a wake-photo grade. Appeals have `window` (`appeal.window_hours`; `trial.final_appeal_hours` for the trial summary), a reason text, and optional evidence (a camera frame sent only on appeal; see `21-monitor.md`). Outcome is decided by code where the dispute is a hard fact (for example heartbeat log shows continuous presence) or by the user's accountability rules; the AI may summarize evidence but never decides. Every state change is written to `audit_log`.

## 8. Events

Published: `fault.recorded`, `fault.waived`, `fault.appeal_decided`, `penalty.issued`, `penalty.suspended`, `penalty.due`, `penalty.paid`, `penalty.unpaid`, `penalty.cap_carried`, `trial.started`, `trial.ended`, `trial.settled`, `contract.signed`, `rule.changed` (with `effective_from`), `reward.unlocked`, `appeal.opened`.

Consumed: `overspend.detected`, `fault.detected`, `reason.given`, `routine.late_detected`, `txn.recorded` (penalty payments and withdrawals), `penalty_savings.withdrawal_detected`, `incident.declared`, `week.closed`, `cycle.opened`.

## 9. Acceptance

1. Given thresholds `[6 -> 20,000; 12 -> 50,000]`, When a week has 7 points, Then raw penalty is 20,000; with 12 points 50,000.
2. Given a weekly cap 30,000 and a raw penalty 50,000, Then 30,000 is issued and 20,000 carries to next week.
3. Given a `need` category overspend and the default `penalty.need_overspend_mode` = `penalize`, Then the penalty is computed like other groups and an `overspend` ledger entry exists. Given the mode is `warn_only`, Then a warning is sent and no penalty entry exists.
4. Given the user is in trial, When a penalty is computed, Then it is `suspended`, and no payment request is sent.
5. Given a fault inside an admin-declared incident, Then it becomes `waived_system` and the report shows it.
6. Given a loosening change on Wednesday, Then the effective date is the next week start; a tightening change is effective immediately.
7. Given an outflow from penalty savings, Then a withdrawal penalty with `penalty.withdrawal_extra_percent` is issued and flagged.
8. Given the `want` list has insufficient remaining limit for a penalty, Then the shortfall is penalty debt carried over.
