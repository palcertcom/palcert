# ADR-0128: The webhook keyring carries a key id from day one

- **Status:** Accepted
- **Date:** 2026-09-18
- **Phase:** 17

## Context

PalCert already has a secret box (Phase 1) that seals with a single key and no
key id. It is approved, it works, and it cannot be rotated without a migration
that decrypts every row — which is exactly the migration nobody wants to run
during the incident that made rotation necessary.

Phase 17 seals two new classes of material: every endpoint's URL and every
signing secret, for every organization.

## Decision

**A separate primitive, with a `kid` on every envelope and purpose-specific
additional authenticated data.**

Each sealed value records the id of the key that sealed it, so several keys can
be open at once and material can be re-sealed incrementally. The AAD is
length-prefixed and starts with a purpose, so a reveal envelope can never
coincide with a configuration envelope however the ids line up, and a URL sealed
for one configuration version will not open for another.

Readiness is an awaited part of startup: a process that does not hold every key
its stored rows refer to refuses to finish starting — including when the feature
is switched off while sealed rows still exist, because turning a feature off does
not make its rows readable.

The Phase 1 secret box is left alone.

## Consequences

Key retirement is an ordinary operation: add the new key, deploy, rewrap, remove
the old key. Doing it in the wrong order fails at boot rather than at delivery.

A missing key is an infrastructure fault, not a configuration fault, and the
delivery path treats it that way: it throws to the queue's ladder rather than
settling somebody's endpoint as permanently broken. Material that will not
authenticate under a key the process *does* hold is the opposite — a row that no
longer describes itself — and settles permanently.

Two crypto primitives now exist in the codebase. That is the cost, and it is
smaller than the cost of retrofitting a key id onto stored ciphertext.
