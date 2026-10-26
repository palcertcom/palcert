# ADR-0044: Typography is resolved per script, not per run

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 6

## Context

PalCert is Arabic and English from day one (P8). That is not a translation
requirement; it reaches into how formatting is stored.

WordprocessingML does not record "the font of this run". It records up to four
fonts — `w:rFonts/@w:ascii`, `@w:hAnsi`, `@w:eastAsia`, `@w:cs` — and which one
applies depends on the *character*. Size, bold and italic are doubled the same
way: `w:sz` and `w:szCs`, `w:b` and `w:bCs`, `w:i` and `w:iCs`.

A run holding "Hello مرحبا" is therefore rendered in two typefaces at two
sizes. An analyzer that reports one effective font per run is wrong about half
that text — and a bilingual thesis is full of such runs.

## Decision

**Run text is segmented by script channel, and formatting is resolved per
segment.**

- A documented classifier maps every code point to `LATIN`, `COMPLEX_SCRIPT`,
  `EAST_ASIAN` or `NEUTRAL`, by Unicode block. Arabic, Hebrew, Syriac, Thaana,
  Nko and the Arabic presentation forms are complex script. Neutral characters
  (whitespace, joiners) extend the neighbouring segment rather than splitting
  it, so "Hello مرحبا" is two segments and not four.
- Each segment reads its own font slot: complex script from `@w:cs`, East
  Asian from `@w:eastAsia`, Latin from `@w:ascii` below U+0080 and `@w:hAnsi`
  above it.
- Facts are named for the channel they describe: `fontFamily` and `fontSize`
  for Latin, `fontFamilyComplexScript` and `fontSizeComplexScript` for complex
  script, and likewise `boldComplexScript` and `italicComplexScript`.
- Theme references resolve per slot too: `@w:cstheme="minorBidi"` yields the
  theme's minor complex-script typeface, not the token.

Nothing is inferred from byte ranges. Classifying Arabic by "not ASCII" is the
specific mistake this decision exists to prevent.

## Alternatives considered

- **One effective font per run, from `@w:ascii`.** Rejected: silently wrong for
  every mixed run, and wrong in the direction that passes bad documents.
- **Split runs into one fact per character range.** Rejected as noise: a
  segment is the natural unit, and facts are deduplicated per paragraph anyway.
- **Treat `@w:cs` as a fallback for a missing `@w:ascii`.** Rejected: they are
  different channels, not a chain.

## Consequences

- A standard can require a specific Arabic typeface and size independently of
  the Latin one, which is what Arabic-language institutions actually specify.
- The property catalogue documents both channels explicitly so rule authors
  know which one they are constraining.
- Nine Arabic-specific fixtures and unit tests cover `cs`, `csTheme`, `szCs`,
  `bCs`, `iCs`, paragraph `bidi`, run `rtl`, and mixed text in one paragraph
  and in one run.
