# ADR-0085: The capability registry is the floor; `autofix: SAFE` is a ceiling

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 12

## Context

Phase 3 lets a standard's author mark a rule `autofix: SAFE`. It is tempting to
read that as "SmartFix will fix this", and to drive the engine from it.

It cannot be. The author is making a statement about their *standard* — that
correcting this rule would not change what a document means. They are not
making a statement about PalCert's OOXML engine, which they have never seen and
which changes on a different schedule from their standard. An engine driven by
that flag would attempt properties it has no code for, and the failure would
surface after the user had paid.

The reverse mistake is just as bad: an engine that ignores the flag and fixes
whatever it technically can would override an author who deliberately said a
change needs judgement.

## Decision

**Both have to agree. `autofix: SAFE` is a ceiling; the capability registry is
the floor.**

- `contracts/registries/smartfix-capabilities.json` lists every property the
  engine can change, with its action type, its OOXML target scope, its script
  channel and its unit.
- The TypeScript constant is generated from that file; the Python engine reads
  the same file. Neither owns a copy.
- A property absent from the registry is never edited, however the rule is
  labelled. A rule whose `autofix` is `NONE` or `ADVANCED` is never acted on,
  however capable the engine is.
- The registry is versioned, and the version is stamped on every plan.

## Alternatives considered

**Drive from the rule flag alone.** Promises the user a fix the engine cannot
perform, discovered after payment.

**Drive from the engine's capabilities alone.** Overrides a standard author's
explicit judgement that a change needs a human.

## Consequences

- Adding a correctable property is a registry change plus engine code, and the
  parity tests refuse one without the other.
- The registry is published at `/smartfix/capabilities`, so the Rule Builder can
  eventually tell an author which of their rules SmartFix could act on.
- Bumping `capabilityRegistryVersion` invalidates outstanding plans by design.
