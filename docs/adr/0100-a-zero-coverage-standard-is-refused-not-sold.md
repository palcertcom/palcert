# ADR-0100: A standard with no answerable rule is refused, not sold

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** 13

## Context

Format support is not a single number. A standard about page size, fonts and
page counts is almost fully answerable from a PDF; one about margins, styles and
tracked changes is answerable not at all. Both are legitimate standards, and a
user choosing between them cannot tell which is which.

A check whose every rule is INDETERMINATE is a report with no verdict in it,
delivered at full price. The user has paid for the discovery that PalCert could
not answer their question.

## Decision

**Coverage is previewed before payment, and zero coverage is refused.**

- `GET /catalogue/standards/:id/compatibility?documentVersionId=…` compares the
  standard's published rules against the property support registry for the
  version's detected format. It is free and it does not open the document — the
  work the user has not paid for yet.
- Every rule is listed with its support level and a readable reason, so the user
  can see exactly which of their requirements will be checked.
- **Partial coverage is sold.** Eight answerable rules of twelve is a useful
  check, and the four come back INDETERMINATE with reasons.
- **Zero coverage is refused**, with `CHECK_STANDARD_NOT_SUPPORTED_FOR_FORMAT`,
  before the reservation — not refunded afterwards, which would still have moved
  the user's money and their attention.
- A rule PalCert cannot map to any property counts as unsupported rather than
  being dropped. Dropping it would shrink the denominator and inflate the
  percentage the user reads.

The preview promises coverage, never a result: a fully supported standard can
still come back INDETERMINATE on a scanned PDF with no text to read. The UI says
so rather than implying a verdict.

## Alternatives considered

**Refuse anything below a threshold.** Any threshold is arbitrary, and a user
who wants their four answerable rules checked is entitled to buy that.

**Sell everything and refund zero-coverage checks.** A refund is slower than a
refusal, involves the user's money, and teaches them that PalCert sells things
it cannot do.

**Preview by opening the document.** More accurate, and it is the paid work.

## Consequences

- Users see, before paying, which of their requirements will actually be
  checked.
- Institutions get a reason to think about what their standards ask for, and in
  which format they ask students to submit.
- The preview and the analyzer read the same registry file, so they cannot drift.
