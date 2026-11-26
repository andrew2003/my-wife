---
name: tdd-money-rules
description: Use when implementing money rules, fault points or penalties as pure functions with table-driven tests.
---

# Money, fault points and penalties

- The rule is a pure function: inputs in, decision out. No I/O, no clock, no randomness. Pass `now` as a parameter. Amounts are integer VND.
- Defaults come from the user's settings object; the spec numbers are only default values.
- The LLM may propose (for example a category). Code decides and writes to the ledger. The bot never moves money.
- Penalties need hard facts, an audit trail entry and an appeal path. AI labels are informational only.
- Tests are table-driven, copied from the spec examples, one row per case with a name:

```ts
const cases = [
  { name: 'exact amount within limit', input: { /* ... */ }, expected: { /* ... */ } },
];
it.each(cases)('$name', ({ input, expected }) => {
  expect(rule(input)).toEqual(expected);
});
```

- Add edge rows: zero, boundary, one VND over, time-zone day boundary, repeated event (idempotency).
- Email and chat content is untrusted data: validate with schemas from `packages/contracts` before the rule sees it.
