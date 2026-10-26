# Standards, versions and rules

How PalCert models *what a document is checked against*. Introduced in Phase 3.

## The entity model

```
Organization (tenant)
  └── DocumentType          systemCategory + organization-chosen name
        └── Standard        stable identity, unique code per organization
              └── StandardVersion      DRAFT → PUBLISHED → SUPERSEDED | ARCHIVED
                    ├── StandardRule[] frozen with the version
                    └── StandardVersionSnapshot   written once, at publication
```

### Why identity and content are separate rows

A `Standard` is the stable identity of a set of requirements — "IUG Master's
Thesis Formatting". A `StandardVersion` is one concrete, dated expression of it.

Submissions, findings and certificates always reference a **version**, never the
standard, because a certificate that says "complies with IUG Thesis Formatting"
is worthless a year later when the requirements have changed. The standard is
what people talk about; the version is what was actually applied.

`versionLabel` ("1.0", "2026 revision") is therefore a *label*, not an identity:
unique within its standard so humans can refer to it, but the system never
resolves anything by it.

### Why `DocumentType` is split in two

`systemCategory` is a closed PalCert enum that pipelines, extraction hints and
reporting key off. `name` is whatever the organization calls it. One university's
"Master's Dissertation" and another's "رسالة ماجستير" are both `THESIS` to the
platform and both correct to their owner.

One enum alone would force organizations to adopt PalCert's vocabulary; one
free-text field alone would make every downstream feature string-match on user
input.

## Lifecycles

| Entity | States | Transitions |
| --- | --- | --- |
| `DocumentType` | `ACTIVE` ⇄ `ARCHIVED` | Both directions. Archiving is refused while active standards reference it. |
| `Standard` | `ACTIVE` ⇄ `ARCHIVED` | Both directions. Published versions stay readable when archived. |
| `StandardVersion` | `DRAFT` → `PUBLISHED` → `SUPERSEDED` or `ARCHIVED` | Publishing a successor supersedes the version in force in the same transaction ([ADR-0143](../adr/0143-publishing-a-successor-supersedes-the-version-in-force.md)); archiving is a deliberate retirement. Also `DRAFT` → `ARCHIVED` (abandoned draft). Nothing returns from `PUBLISHED`, `SUPERSEDED` or `ARCHIVED`; clone to reuse content. |

See [ADR-0024](../adr/0024-published-immutability.md) for why the version
lifecycle has no way back, and how that is enforced at both layers.

## The rule model

A rule is **data, never an expression** — see
[ADR-0022](../adr/0022-rules-are-data-not-code.md). It is a closed tuple:

| Field | Notes |
| --- | --- |
| `ruleCode` | `UPPERCASE.DOT.SEPARATED`, unique per version. Findings quote it. |
| `category` | One of 23. Drives report grouping. |
| `evaluationMode` | `DETERMINISTIC` / `AI_ASSISTED` / `MANUAL`. |
| `scope` | Discriminated on `kind`: `DOCUMENT`, `SECTION`, `ELEMENT`, `METADATA`, `PAGE`. |
| `operator` | One of 14. |
| `expected` | Discriminated on `type`. `PATTERN` names a PalCert matcher, never a regex. |
| `unit` | Required for numeric values; `COUNT` is the explicit "plain count". |
| `tolerance` | Only where the operator and value type make it meaningful. |
| `severity`, `blocking`, `autofix` | See the invariants below. |
| `origin`, `originReference` | Provenance, for when a standard is disputed. |
| `displayOrder` | Report ordering — part of the meaning, so it is hashed. |
| six localized strings | `titleEn`/`titleAr` mandatory; descriptions and guidance optional. |

### Relational vs JSONB

Everything queried or reported on is a **relational column** — category,
severity, operator, evaluation mode, blocking. Only `scope` and `expectedValue`
are JSONB, because they are discriminated unions whose shape depends on the
discriminant; modelling them relationally would need a dozen mostly-null
columns.

Both are validated against the versioned contract in `@palcert/contracts` before
they are written, and the database additionally requires each to be an object
carrying its discriminant. The JSONB is a serialization format, not an escape
hatch.

### Safety invariants

- **Blocking is version-dependent.** Under **rule schema version 1** only a
  `DETERMINISTIC` rule may be `blocking`. Under **version 2** (Phase 4,
  [ADR-0030](../adr/0030-rule-schema-v2-blocking-semantics.md)) a rule may be
  blocking in any evaluation mode, and the safety property moves to
  evaluation: an unresolved non-deterministic blocking rule prevents a final
  compliance decision until a reviewer resolves it. The engine returns
  `INDETERMINATE` with `requiresReview` for every such rule, so a model's
  judgement still never blocks — or clears — a certificate on its own.
- **A `MANUAL` rule cannot have autofix.** A question put to a person cannot be
  answered by a fixer.
- Both are enforced by `validateRuleDefinition` *and* by check constraints, and
  both are **version-aware**: a rule is judged by the schema version of the
  version that owns it (`rule_schema_version`), which a trigger keeps equal to
  its parent's. New drafts are written under the current version; a clone keeps
  its source's version unless `upgradeRuleSchema` is passed explicitly, and the
  source is never modified.

### Rule schema versions

| Version | Blocking | Status |
| --- | --- | --- |
| 1 | `DETERMINISTIC` rules only | Historical; still validated and evaluated under its own rules |
| 2 | Any evaluation mode; unresolved non-deterministic blocking rules hold the compliance decision open | Current |

`GET /standards/rule-schema` advertises `ruleSchemaVersion` (what new drafts are
written under), `supportedRuleSchemaVersions` and
`blockingAnyModeFromSchemaVersion`, so a client never hard-codes the list.
Published v1 content keeps its v1 semantics and its original content hash;
canonicalization did not change, so `STANDARD_CANONICALIZATION_VERSION` is
still `1`.

### The operator / value compatibility matrix

`OPERATOR_VALUE_COMPATIBILITY` in `@palcert/contracts` is the single source of
truth. The API validator, the rule builder UI and (from Phase 6) the evaluator
all read it, so a combination the UI offers is by construction one the API
accepts. It is served to the browser by `GET /standards/rule-schema`.

## Publication

One transaction:

1. `SELECT … FOR UPDATE` the version, so concurrent publishes serialize;
2. refuse if another version of the standard is already in force;
3. re-validate **every** rule — including rules written before a validation rule
   was tightened;
4. canonicalize and hash ([ADR-0023](../adr/0023-standard-content-hashing.md));
5. insert the snapshot (unique per version, so a retry cannot duplicate it);
6. flip the version to `PUBLISHED` with its hash.

Publication is **idempotent**: publishing an already-published version returns
its existing state rather than failing, so a client retrying after a dropped
response is not told it broke something.

## Concurrency

`If-Match` carrying the version's `revision`, on every draft mutation including
rule mutations. The version is the aggregate root. See
[ADR-0025](../adr/0025-optimistic-concurrency-for-drafts.md).

## Tenant isolation

All five tables are `TENANT_SCOPED` with a denormalized `organization_id`, RLS
`ENABLE` + `FORCE`, and a policy that is a single-column comparison — no join to
a parent, which would be slower and would make this table's access depend on
another table's policy.

Cross-tenant **parent injection** is blocked structurally: every parent
reference is a *composite* foreign key including `organization_id`
(`standards_document_type_org_fkey`, `standard_versions_standard_org_fkey`,
`standard_rules_version_org_fkey`, `standard_version_snapshots_version_org_fkey`,
`standard_versions_cloned_from_org_fkey`). A child can never sit in one tenant
while pointing at a parent in another, whatever the application does.

## Permissions

| Permission | Owner | Admin | Template manager | Reviewer |
| --- | :-: | :-: | :-: | :-: |
| `standard:document-type:read` | ✓ | ✓ | ✓ | ✓ |
| `standard:definition:read` | ✓ | ✓ | ✓ | ✓ |
| `standard:document-type:manage` | ✓ | ✓ | ✓ | |
| `standard:definition:create` | ✓ | ✓ | ✓ | |
| `standard:definition:update` | ✓ | ✓ | ✓ | |
| `standard:definition:archive` | ✓ | ✓ | ✓ | |
| `standard:version:create` | ✓ | ✓ | ✓ | |
| `standard:version:update` | ✓ | ✓ | ✓ | |
| `standard:version:archive` | ✓ | ✓ | ✓ | |
| `standard:rule:write` | ✓ | ✓ | ✓ | |
| `standard:version:publish` | ✓ | ✓ | ✓ | |

`standard:version:publish` is a permission of its own rather than part of
`standard:version:update`, because authoring a standard and putting it into
force are different acts. No role holds publish without edit; the separation
exists so the reverse can be expressed.

A reviewer reads and can never write — asserted directly by test, over every
write endpoint.

## Out of scope for Phase 3

No AI calls, no DOCX or PDF parsing, no compliance evaluation, no SmartFix. This
phase defines *what* a document will be checked against. Phase 4 added the
engine that checks synthetic facts against these rules
([rule-engine.md](rule-engine.md)); real documents arrive with the parsers of
Phase 6 onward.
