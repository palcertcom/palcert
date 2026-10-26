# ADR-0084: A plan is free, hashed, and executed exactly as approved

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 12

## Context

SmartFix changes somebody's thesis. Agreeing to that without seeing what will
change is not agreement.

The convenient design is one call: pay, and PalCert works out what to do and
does it. The user sees the result afterwards. That is how most automated
correction products work, and it is why people do not trust them with anything
that matters.

There is a second, quieter problem. Even if the user *is* shown a plan first,
regenerating it at execution time means the list they approved and the list
that runs are two different computations. Between them the document can change,
the standard can be republished, or the engine can be upgraded.

## Decision

**Planning is a separate, free operation. The plan is stored, hashed, and the
execution applies that plan or nothing.**

- `POST /smartfix/checks/:id/plan` reserves nothing and charges nothing.
- The plan artifact is stored and its SHA-256 recorded on the row.
- Executing re-reads the stored artifact, verifies it hashes to the recorded
  value, and hands it to the engine with that hash.
- The engine recomputes the hash over the plan it was given and refuses on a
  mismatch, and refuses again if the plan's `documentSha256` is not the digest
  of the bytes in front of it.
- The plan also records the fix engine version and capability registry version
  it was produced under, and the engine refuses a plan from a different one — a
  plan approved under a registry that could change less must not execute under
  one that can change more.
- Plans expire, because a plan is a snapshot of one document against one set of
  rules and both move on.

## Alternatives considered

**Plan and execute in one paid call.** Cheaper to build and impossible to trust.

**Store only a summary and regenerate the actions.** The summary is what the
user read; the actions are what runs. Two computations, one signature.

## Consequences

- Planning costs PalCert a document read and an engine call, for free. That is
  the price of informed consent.
- A user can plan, decline, edit their document, and plan again; each plan is
  its own immutable record of what was proposed.
- "What exactly did I agree to?" is answerable from a hash.
