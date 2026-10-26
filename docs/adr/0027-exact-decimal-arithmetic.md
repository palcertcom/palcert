# ADR-0027: Exact rational arithmetic for measurements; no binary floating point

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 4

## Context

A formatting rule is a comparison between two measurements, frequently in
different units: a standard says "30 mm" and the document says "85.05 pt". The
conversion factor between points and millimetres is `25.4 / 72`, which has no
finite binary representation. Neither does `0.1`, the most common tolerance.

With IEEE-754 doubles, `30 mm → pt → mm` does not return `30`, and whether
`|actual − expected| ≤ tolerance` holds can depend on the order the conversions
happened in. A certificate that says a margin is wrong by
`0.000000000000004 mm` is not a certificate anyone should issue, and one that
says a margin is right because the error rounded away is worse.

The obvious fix, `Decimal`, was tried first and proved insufficient:
`Decimal(30) mm → pt → mm` yields `30.00000000000000000000000001` at the default
28-digit precision, because `72 / 25.4` is a repeating decimal. Any fixed
precision leaves some round trip inexact.

## Decision

**Comparison arithmetic uses `fractions.Fraction`; the wire and storage form is
a canonical decimal string.**

- Every number in a fact set and every expected value in a rule crosses the
  boundary as a **decimal string** (`"30"`, `"12.5"`), validated by the shared
  schema. A JSON number is rejected — it would already be a double by the time
  the engine saw it.
- On entry, strings are converted to `Fraction` without loss. Unit conversion
  multiplies by exact rational factors (`Fraction(254, 10) / 72` for points to
  millimetres). Comparison and tolerance use `Fraction` throughout.
- On exit, values are rendered with `format_exact`, which prints a terminating
  decimal exactly and never in exponent notation. The `normalizedValue` in a
  violation is the exact converted quantity.
- Units live in a registry with **dimensions**. Length units inter-convert;
  `COUNT`, `WORDS`, `PAGES`, `RATIO`, `RESOLUTION` and the rest are singleton
  dimensions. `PIXEL` is its own dimension and never converts to a length,
  because a pixel has no physical size without a DPI the engine is not given.
  Comparing across dimensions is `UNIT_INCOMPATIBLE`, not a coercion.

## Alternatives considered

**`Decimal` with high precision.** Rejected on the evidence above: it is
inexact for repeating quotients, and the failure is silent.

**Rounding to a fixed number of places before comparing.** Rejected. It moves
the question from "is this equal" to "is this equal after rounding to N", and
`N` becomes an undocumented part of every rule's meaning.

**Binary floats with an epsilon.** Rejected. An epsilon is a tolerance the
author did not write, applied to every rule, and it interacts with the
tolerance they did write in ways nobody can explain on a certificate.

## Consequences

- Unit conversion round-trips exactly and is transitive; both are proven by
  property tests over the whole registry, not asserted at a few points.
- Every measurement is serialized as a string, and every schema and type on
  both sides of the wire says so. A contributor adding a numeric field will be
  stopped by the schema validator before a float reaches a verdict.
- `Fraction` arithmetic is slower than doubles. At product scale — 200 rules
  over 10,000 facts — an evaluation takes well under a second, and the
  performance suite holds it to an order of magnitude above that.
- Values arriving as JSON floats from an older client are converted with
  `Decimal(repr(value))`, the shortest string that round-trips the double, so
  a rule authored as `12.5` stays `12.5` rather than becoming
  `12.5000000000000003`. This is a courtesy at the boundary, not a licence to
  use floats internally.
