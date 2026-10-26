# ADR-0053: Violations are capped, and the cap is always disclosed

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 7

## Context

A long thesis can violate a single body-font rule on every paragraph. Four
thousand violation rows for one rule help nobody: they make the report page
unusable, the API response enormous, and the database write slow — on exactly
the documents that most need checking.

But silently keeping the first fifty would be worse than either extreme. A
reader who fixes the five places listed and re-checks, only to find four
hundred more, has been misled by the product.

## Decision

Violations are bounded at three points, and every bound is disclosed.

- The **engine** returns at most 1000 violations per rule and sets `truncated`.
- The **orchestrator** stores at most `CHECK_MAX_STORED_VIOLATIONS_PER_RULE`
  (default 200) and marks the result truncated whenever the stored list is
  shorter than what was found — whether the engine capped it or PalCert did.
- The **API** returns at most `CHECK_MAX_RETURNED_VIOLATIONS_PER_RULE`
  (default 50) per rule in a results page.

Every rule result carries `totalViolationCount` — the true number — alongside
`returnedViolationCount` and `violationsTruncated`. A database constraint
enforces `returned_violation_count <= total_violation_count`.

The UI says so in words: how many places are shown out of how many were found,
and a note that fixing the rule usually fixes all of them at once.

The **score is unaffected** by any of this: a rule counts once regardless of
how many times it was violated (ADR-0048), so capping the evidence cannot move
the number.

## Consequences

- The report stays readable and the response stays bounded.
- A reader is never told a truncated list is the whole story.
- Someone who needs every occurrence has the true count and the rule; the
  places are in their own document.
