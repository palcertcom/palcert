# ADR-0010: Arabic/English and RTL from day one

- **Status:** Accepted
- **Date:** 2026-09-12
- **Phase:** 0

## Context

PalCert's first market is Palestinian and regional institutions. §31 requires
Arabic and English support with correct RTL and LTR rendering, and explicitly
forbids retrofitting RTL after the application is built. Documents themselves may
mix Arabic and English text.

## Decision

- **Routing:** every page lives under a locale segment — `/en/...`, `/ar/...`.
  Middleware negotiates the locale from `Accept-Language` and redirects
  locale-less paths.
- **Direction:** `lang` and `dir` are set on `<html>` by the locale layout, so
  direction is correct before any component renders.
- **Styling:** CSS logical properties (`margin-inline-start`, `padding-inline`,
  `text-align: start`) only. Physical `left`/`right` properties are prohibited
  in layout code.
- **Messages:** typed catalogues with an identical key set per locale. A unit
  test fails CI if a key is missing, empty, or if the Arabic value duplicates
  the English one.

## Alternatives considered

- **English first, Arabic later.** Rejected by §31 and by experience: RTL
  retrofits touch every component.
- **A heavier i18n framework (next-intl, i18next).** Deferred: the Phase 0
  surface is a handful of strings. The catalogue shape here is compatible with
  adopting one when message volume justifies it.

## Consequences

- Every new screen must be checked in both directions.
- Translation coverage is enforced mechanically, not by review.
- A message-catalogue migration to a fuller framework remains straightforward.
