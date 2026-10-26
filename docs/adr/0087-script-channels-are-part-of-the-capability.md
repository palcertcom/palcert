# ADR-0087: A script channel is part of the capability, not a mutator detail

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 12

## Context

WordprocessingML does not have "the font size of a run". It has `w:sz` for
Latin text and `w:szCs` for complex-script text, and analogous pairs for bold
(`w:b`/`w:bCs`), italic (`w:i`/`w:iCs`) and the font family slots
(`@w:ascii`/`@w:hAnsi`, `@w:cs`, `@w:eastAsia`).

PalCert is an Arabic product. An engine that wrote `w:sz` for an Arabic
paragraph would produce a valid file, succeed without error, change nothing a
reader can see, and let the manifest claim the size was corrected. The user
would pay for a correction that did not happen, and would only find out when
their institution rejected the document.

This is the single most dangerous way for this engine to be wrong, because
every layer above it reports success.

## Decision

**Every run-level capability carries its script channel, and the mutator never
infers one.**

- `fontSize` → `LATIN` → `w:sz`; `fontSizeComplexScript` → `COMPLEX_SCRIPT` →
  `w:szCs`. Same for bold, italic and the font family slots.
- The channel is on the capability in the shared registry, on the planned
  action, and in the manifest entry.
- A registry parity test refuses a `RUN_PROPERTIES` capability without a
  channel, and refuses a channel on anything else.
- The Latin font family writes both `@w:ascii` and `@w:hAnsi`, because Word
  splits the ASCII and high-ANSI ranges and setting one leaves accented Latin
  on the old face.
- A theme attribute on the same slot is removed when an explicit face is
  written, because a theme reference outranks it.

## Alternatives considered

**Infer the channel from the run's text.** A run can hold both scripts, and the
Phase 6 model already resolves per-slot properties precisely because one answer
would be wrong for one of them.

**Write both channels.** Changes text the rule never addressed.

## Consequences

- A rule about Arabic typography and a rule about Latin typography are separate
  capabilities with separate targets, which is what they are.
- The manifest says which channel each change was written to, so "why does my
  Arabic still look the same?" has an answer in the record.
