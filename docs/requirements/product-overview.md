# PalCert product requirements

_Source of truth: the PalCert Master Development Prompt. This document restates
the fixed product decisions so engineering work can reference them without
re-reading the full brief. Section numbers (§) refer to the master prompt._

## 1. What PalCert does

PalCert is an AI-powered document compliance, correction, verification and
certification platform for universities, scientific journals, publishers,
research institutions and other organizations.

```
Define → Check → Fix → Verify → Approve → Certify
```

## 2. Fixed decisions

These may only change by explicit product-owner decision.

| Decision | Detail |
| --- | --- |
| AI is not the compliance authority (§2) | A deterministic rule engine computes every verdict and the score |
| Provider-agnostic AI (§3) | `AIProvider` interface; Anthropic Claude first |
| No blockchain in v1 (§4) | But SHA-256 hashes preserved for all immutable artifacts |
| Tenant = `Organization` (§5) | Never `University` |
| Extensible RBAC (§6) | No hard-coded role conditionals |
| All user fees belong to PalCert (§7) | Organizations get no per-document revenue share in v1 and cannot set prices |
| Originals immutable (§8.3) | SmartFix always writes a new version plus a change manifest |
| Published standard versions immutable (§12) | Clone → edit → publish as a new version |
| Arabic + English, RTL from the start (§31) | Not retrofitted |

## 3. Organization types (§5)

`UNIVERSITY`, `SCIENTIFIC_JOURNAL`, `PUBLISHER`, `RESEARCH_INSTITUTION`,
`GOVERNMENT`, `COMPANY`, `OTHER`.

## 4. Roles (§6)

Customer: `STUDENT`, `SERVICE_USER`.
Organization: `ORGANIZATION_OWNER`, `ORGANIZATION_ADMIN`,
`ORGANIZATION_REVIEWER`, `TEMPLATE_MANAGER`.
PalCert staff: `PALCERT_ADMIN`, `PALCERT_FINANCE`, `PALCERT_SUPPORT`,
`PALCERT_AUDITOR`.
Integration: `API_CLIENT`.

## 5. Commercial services (§8)

| Service | Description |
| --- | --- |
| **PalCert Preview** | Free preliminary analysis; issue count only, detail requires payment |
| **PalCert Check** | Paid inspection producing score, findings, locations, expected/actual values, recommendations |
| **PalCert SmartFix** | Paid automatic correction; new version, change manifest, free automatic recheck, before/after results |
| **PalCert ExpertFix** | Future manual service; data model must accommodate it |

The automatic recheck after SmartFix never incurs a second check fee (§8.3).
The SmartFix price is shown and accepted before the job runs; no hidden
post-processing charges (§28).

## 6. SmartFix safety boundary (§9)

**May change:** font, font size, font style, paragraph alignment, paragraph
spacing, line spacing, indentation, page margins, page size, styles, headings,
numbering, page numbers, headers, footers, caption formatting. Later: TOC,
figure/table numbering, section numbering, bibliography and citation formatting.

**Must never invent or alter:** scientific findings, research results, academic
conclusions, data values, missing citations, authors, DOIs, experimental
results, or the meaning of academic text.

When content cannot be safely fixed, SmartFix emits `MANUAL_ACTION_REQUIRED`.

## 7. Standards model (§11, §12)

```
Organization → Document Type → Standard → Standard Version → Rules
```

Lifecycle: `DRAFT` → `PUBLISHED` → `ARCHIVED`. A published version is immutable;
changes go `2026.1 → clone → 2026.2 draft → edit → publish`. Every historical
check stays bound to the exact standard version that produced it.

## 8. Rules (§13, §14, §15)

Rules are structured data, never hard-coded application branches:

```json
{
  "code": "BODY.FONT.SIZE",
  "category": "TYPOGRAPHY",
  "scope": "BODY_PARAGRAPH",
  "operator": "EQUALS",
  "expected": 12,
  "unit": "PT",
  "tolerance": 0,
  "severity": "ERROR",
  "blocking": true,
  "autofix": true
}
```

Categories: `PAGE_LAYOUT`, `TYPOGRAPHY`, `PARAGRAPH`, `HEADINGS`, `SECTIONS`,
`TABLE_OF_CONTENTS`, `HEADER_FOOTER`, `PAGE_NUMBERING`, `FIGURES`, `TABLES`,
`EQUATIONS`, `CAPTIONS`, `CITATIONS`, `REFERENCES`, `LISTS`, `LANGUAGE`,
`RTL_LTR`, `WORD_COUNT`, `PAGE_COUNT`, `ANONYMIZATION`, `DECLARATIONS`,
`METADATA`, `CUSTOM`.

Severities: `CRITICAL`, `ERROR`, `WARNING`, `RECOMMENDATION`, `INFO`.

An organization configures a compliance policy (for example: critical = 0,
errors ≤ 3, score ≥ 95%). The compliance engine — never the AI — decides pass or
fail.

AI-extracted rules are always created as `DRAFT` and require human
confirm/edit/reject before publication (§16). Never auto-publish.

## 9. Checks, submissions and certificates (§21–§23)

- **Private check** — visible only to the user; the organization does not see it.
- **Official submission** — the user deliberately submits; lifecycle
  `NOT_SUBMITTED → SUBMITTED → UNDER_REVIEW → APPROVED | REJECTED |
  REVISION_REQUESTED`.
- The organization may comment but may never modify the PalCert score, the
  machine findings, or a historical report.
- A certificate may be issued when technical compliance passes **and** the
  institution approved. Certificates reference the document hash, report hash,
  standard version, institution, document type and issue date; status is
  `VALID`, `REVOKED` or `EXPIRED`. Public verification at
  `palcert.com/verify/{certificateId}` never exposes the private document.

## 10. Money (§26, §27)

Customer credit is called **PalCert Balance** / **Customer Credit Balance** —
never a crypto wallet. It is an append-only ledger; a mutable balance column is
never the source of truth.

Transaction types: `TOP_UP`, `CHECK_CHARGE`, `SMARTFIX_CHARGE`,
`EXPERTFIX_CHARGE`, `REFUND`, `PROMOTIONAL_CREDIT`, `ADMIN_ADJUSTMENT`.

Flow: verify funds → reserve/authorize → process → produce report → finalize
charge. A technical failure before delivering the paid service must refund. All
financial operations are idempotent and auditable.

## 11. What PalCert does not claim

PalCert checks submission compliance. It does not determine scientific merit,
research validity, peer-review acceptance, novelty or editorial acceptance
(§24). Organization approval is separate from PalCert technical compliance.

## 12. Deferred (§43)

Blockchain trust layer, OJS, Moodle, university SSO, SAML, advanced API
integrations, W3C Verifiable Credentials, JATS XML, ExpertFix workflow, advanced
AI provider routing, institution subscriptions, enterprise contracts.
