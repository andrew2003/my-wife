# Admin

Owner: `identity` (roles and admin API) with admin screens in `apps/web`. A page for the platform owner: invitations, system errors, incident declaration for bulk fault waivers, and per-user feature toggles. Admin power is limited and audited.

## 1. Roles

`user` and `admin`. The first admin comes from the initial setup. Admin screens need role `admin` and a fresh session. Admin cannot read bank, receipt, chat or camera content, cannot read keys, and cannot change a user's rules; they can only act on the platform and on account access.

## 2. Functions

| Function | Description |
| --- | --- |
| Invitations | Create, revoke and list invitations; shows expiry and use; respects `identity.max_users` |
| Users | List with state, last seen, feature flags; suspend or reactivate |
| System errors | View failed jobs, delivery failures, unhealthy channels, parse failures counts, queue depth; no personal content |
| Incidents | Declare an incident (start, end, scope all or selected services, reason). Faults overlapping it are waived automatically (`waived_system`) in `rules`. Ending an incident closes the interval |
| Feature flags | Enable or disable features per user (for example camera supervision, wake photo, sync) |
| DKIM sender map | Maintain the global map `bank sender -> DKIM domain` used by `ingest`; users only choose from it |
| Platform settings | Admin-scope rows of `02-defaults.md`, for example FX provider, retention |
| Audit | Read the audit log of admin actions |

## 3. Incident state machine

`declared` -> `active` -> `ended`; `cancelled`.

| From | Trigger | To |
| --- | --- | --- |
| (new) | admin declares with a start (may be in the past) | `active` if the end is open, `ended` if closed |
| `active` | admin sets the end | `ended` |
| `active` | admin cancels (mistake) | `cancelled`; waivers granted by it are re-evaluated by `rules` |

Incident intervals are combined with the server heartbeat gap rule in `21-monitor.md`. Declaring an incident is a privileged action: it needs a reason, is audited, and every user whose faults are waived sees it in their report.

## 4. Audit

Every admin action writes `audit_log` (who, what, before and after, time). Retention `admin.audit_retention_days`.

## 5. Events

Published: `incident.declared`, `incident.ended`, `incident.cancelled`, `feature_flag.changed`, `invitation.created`, `invitation.revoked`, `sender_map.changed`.

Consumed: `user.*`, job and delivery failure events, `sync.failed`.

## 6. Acceptance

1. Given an admin declares an incident covering 14:00-14:30, Then a fault in that period is waived and the user's weekly report shows the waiver and the reason.
2. Given a non-admin session, When it calls an admin API, Then the gateway returns 403.
3. Given a revoked invitation, Then it cannot be used.
4. Given the admin disables a feature for a user, Then the feature is unavailable on the next request and a notice appears.
5. Given an admin action, Then an audit entry exists and no personal content is shown on any admin screen.
