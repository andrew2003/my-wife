# Decision log

One row per decision an agent made where the spec was silent, or per answer given by the project owner. The owner can overrule any row by leaving feedback through the `status` command.

| Date | Decided by | Question | Decision | Reason |
| --- | --- | --- | --- | --- |
| 2026-11-26 | spec-auditor + lead | Penalty mechanics (overspend) | The limit deduction is the economic penalty; the transfer to penalty savings clears a penalty ledger entry with status `due`, `paid` or `suspended`. | Needed for table-driven tests; reversible. |
| 2026-11-26 | lead | Where unresolved money lands (unknown spend after 24h, unallocated cash, overdue receivable) | Use the user's ordered `want` list; fall back to the first `want` category; else a visible, appealable system "unclassified" category. | Safe default. |
| 2026-11-26 | lead | Penalty source exhausted | The shortfall becomes penalty debt and carries over, like the weekly cap. | Safe default. |
| 2026-11-26 | lead | Weekly limit rounding; `fund` categories | The last week of a cycle gets the remainder. `fund` categories have only a cycle-level code. | Safe default. |
| 2026-11-26 | lead | Reconciliation model | Split into a `transaction_type` enum and a `reconciliation_result` enum with a precedence order (`wrong_bank` > `amount_mismatch` > `matched`). Symmetric tolerance with a minimum absolute value; an unplanned amount is never `matched`. | Overlapping cases in 01. |
| 2026-11-26 | lead | Transfer codes | User short codes must be unique and not reserved (`DC`, `PH`, `MW`). Use cycle sequence plus week index instead of ISO week. Match case-insensitively, ignoring separators and diacritics. | Banks mangle memos. |
| 2026-11-26 | lead | Refunds; cycle gap; mid-cycle changes | Refund restoration is capped at the original amount, the excess goes to income. Spending while awaiting funds is booked to the previous cycle as unplanned with no penalty. Structural changes (N, week start) apply next cycle; raising a `want` limit is loosening (locked), lowering applies immediately. | Safe defaults. |
| 2026-11-26 | lead | Trial clock; outage waiver | The trial clock is independent of cycles. Waive faults during admin-declared incidents and server-side heartbeat gaps overlapping a platform outage; all else is a fault with appeal. | Safe default. |
| 2026-11-26 | lead | Defaults table; FX; admin | Architect writes one defaults table (every number a setting). FX provider is pluggable; the VND amount in the email wins. Admin page specified in `50-admin.md`. | Principle 1. |
| 2026-11-26 | lead | DKIM trust and fixtures | Sender-to-DKIM-domain map is global and admin-curated; users only choose from it. Unsigned mail is rejected; balance reconciliation is the backstop. Test fixtures are synthetic mails signed with a test key; no real emails in the repo. | Prevents faked penalty payments. |
| 2026-11-26 | lead | Tenancy and keys | Every table has `user_id` with row-level security. One master key from an env var with a key-id column for rotation. | Principle 7. |
| 2026-11-26 | lead | M1 sequencing; LOGIN_METHOD; Google scopes | M1 uses stubs or fake-camera happy paths for contract, camera and wake-up photo. LOGIN_METHOD is `google` or `magic_link` with expiring invitation tokens. Use the narrow `drive.file` scope. | Safe defaults. |
