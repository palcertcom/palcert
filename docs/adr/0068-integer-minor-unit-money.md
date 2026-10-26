# ADR-0068: Money is an integer count of minor units, and a string on the wire

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 10

## Context

Phase 10 introduces the first thing in PalCert that is actually money: a
customer's credit balance, what they paid to create it, and every movement in
between. Getting the representation wrong is not a rounding bug, it is a class
of bug that produces balances nobody can reconcile and refunds that do not
match what was charged.

Three representations were on the table, and two of them fail immediately.

A binary float cannot hold `0.10`. Adding ten of them gives
`0.9999999999999999`, and a balance that is compared to zero to decide whether
a customer may proceed will eventually decide wrongly. JavaScript's `number` is
a float, so `JSON.parse('{"amount": 10.25}')` has already lost the value before
any PalCert code sees it.

A database `NUMERIC` is exact, but it arrives in Node as a float or a string
depending on the driver, and every arithmetic operation on the way to a
decision is an opportunity to convert it to `number` "just for this
comparison".

The third option is to never have a fractional quantity at all.

## Decision

**An amount is a `bigint` count of the currency's minor units, paired with an
ISO 4217 code. It is `BIGINT` in PostgreSQL and a decimal *string* in JSON.**

- `{ "currency": "USD", "minorUnits": "1025" }` is $10.25. There is no
  `10.25` anywhere in the system.
- Exactly one place knows how many minor units a currency has:
  `CURRENCY_REGISTRY` in `@palcert/contracts`. USD, EUR and ILS have two
  decimal places, JOD has three, JPY has none. `currencyExponent` throws for a
  currency it does not know rather than assuming two.
- Conversion between a human's "20.50" and 2050 happens at the *edges* and
  nowhere else: `parseMinorUnits` on input, `formatMinorUnits` on output. Both
  work by moving digits — `formatMinorUnits` slices the string and inserts a
  separator. Neither divides.
- A unit test scans the money module's source for `/100`, `Math.`,
  `parseFloat`, `toFixed` and `Number(`, and fails if any appears. The rule is
  enforced by the build, not by review.

## Alternatives considered

**`NUMERIC(19,4)` with a decimal library.** Rejected. It is exact, but it
leaves a fractional quantity in play, and the discipline that keeps it out of
`number` is entirely convention. Integers make the wrong thing impossible
rather than discouraged.

**A single fixed exponent of 2 for every currency.** Rejected. JOD has three
decimal places and JPY has none; a fixed exponent silently multiplies or
divides real amounts by 10 for those currencies, and the error would be found
by a customer, not by a test.

**Numbers in JSON, converted carefully at the boundary.** Rejected. By the time
a careful boundary sees a JSON number it is already a double. There is no
careful.

## Consequences

- `BigInt` cannot be `JSON.stringify`-ed, which is inconvenient exactly once
  per serialization boundary and catches every accidental leak of a raw row to
  a response.
- Comparisons, sums and sign checks are ordinary integer operations, exact by
  construction, with no tolerance and no epsilon anywhere in the finance code.
- The browser never parses an amount into a `number` either: `toDecimalString`
  in the web app slices digits the same way, and `Intl.NumberFormat` is told
  the exact fraction digits so it formats rather than rounds.
- Amounts are bounded (`MAX_MINOR_UNITS`) so a hostile or mistaken input
  cannot create a balance no reconciliation can print.
