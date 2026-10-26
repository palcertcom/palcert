# Phase 19 capability matrix

What a machine credential can and cannot do, and where each answer is enforced.
The point of the table is the third column: almost nothing here is a guard
saying no, because almost nothing here is reachable in the first place.

Companion to [integration-api.md](integration-api.md), which is written for
whoever has to integrate, and to
[ADR-0141](../adr/0141-a-machine-is-a-principal-not-a-borrowed-person.md).

## What a credential is

| Property | Answer | Enforced by |
|---|---|---|
| Belongs to | Exactly one organization | `organization_id NOT NULL`, immutable by trigger |
| Is a person? | No — `MachinePrincipal` has no `userId` field at all | The type; a service asking "was this me?" cannot compile against a machine |
| Can impersonate? | No | No route accepts an actor, and machine reads pass `userId: ''` |
| Secret at rest | Argon2id verifier only | `api_client_secrets.secret_verifier`; no plaintext column exists |
| Secret recoverable? | Once, inside the idempotency window, by repeating the identical request; never after | Sealed reveal copy on the operation row, `API_CLIENT_SECRET_NO_LONGER_RECOVERABLE` after |
| Live secrets | 1 normally, 2 during an overlap, never 3 | Partial unique indexes `api_client_secrets_one_active` / `…_one_rotating_out` |
| Rotation overlap | ≤ 12 hours, recorded, self-ending | `API_CLIENT_ROTATION_OVERLAP_SECONDS`, `overlap_ends_at`, checked at authentication |
| Revocation | Final; every secret retired in the same transaction | `api_clients_guard()` refuses any transition out of `REVOKED` |

## What a credential may read

Four scopes, all read-only. Each row is a named operation; a route that names
none is unreachable.

| Operation | Scope | Returns | Withholds |
|---|---|---|---|
| `organization.profile.read` | `organization:read` | The credential's own organization | Any other organization — no parameter names one |
| `organization.standard.list` / `.read` | `organization:read` | Published standard versions and their content hashes | Drafts |
| `submission.list` / `.read` | `submissions:read` | Submission metadata and decision state | The document, the report, the submitter |
| `submission.revision.history` | `submissions:read` | Decision events and their source | Which named reviewer decided |
| `certificate.read` | `certificates:read` | Issuance status and lifecycle dates | The PDF, the verification code, its hash |
| `certificate.events.read` | `certificates:read` | Lifecycle events | As above |
| `webhook.endpoint.list` | `webhooks:read` | Endpoint status and description | The URL, the signing secret, the ciphertext |

## What no credential can reach

Not refused — absent. There is no operation that names any of these, so no
scope can grant them and no future route widens them by accident.

| Capability | Why not in Phase 19 |
|---|---|
| Submission evidence (document, report) | A different decision from "a submission arrived". Needs its own scope, short-lived URLs and audit trail. |
| Any write, anywhere | A machine that can act wrongly at scale is a different class of incident from one that can only read. |
| A person's own checks, documents or reports | User-private. Machine reads carry an empty user id, so RLS matches only the organization branch. |
| Balances, payments, invoices, provider metadata | Finance is untouched by Phase 19. |
| Certificate issuance or revocation | Certificate control is a human authority. |
| Platform or user administration, verification decisions | Not an organization capability at all. |
| Submission decisions, SmartFix execution, standards authoring | Human authority, unchanged. |
| Another organization's anything | No `organizationId` parameter exists on any integration route. |

## Where each protection lives

| Property | Layer |
|---|---|
| Credential is well-formed | Shape check before any database work or Argon2 |
| Credential is live | `ApiClientAuthService.authenticate`, comparing against *now* rather than trusting a sweeper |
| Organization is live | Second read under the credential's own tenant context |
| Operation is allow-listed | `@MachineOperation` metadata, checked in `ApiClientGuard` before authentication |
| Scope covers the operation | `API_CLIENT_OPERATION_SCOPE`, checked in the guard |
| Tenant confinement | PostgreSQL RLS, organization branch only |
| Verifier table is unreachable by tenants | `SYSTEM` classification, no tenant policy at all |
| Bookkeeping cannot escalate | `api_clients_guard()` refuses any system-context update but `last_used_at` |
| Rate | Per-credential Redis windows, auth attempts counted separately from successes |
| Retry safety | `Idempotency-Key` required on create and rotate |
| Secret never escapes | Separate reveal type; audit metadata key refusal; logger redaction paths; URL redaction |

## Audit

| Actor kind | `actor_type` | `actor_user_id` | `actor_api_client_id` |
|---|---|---|---|
| A person | `USER` | set | null |
| A credential | `API_CLIENT` | **null** | set |
| PalCert itself | `SYSTEM` | null | null |

The shape is a database constraint, not a convention: a row cannot claim to be
an integration and name a person. Creating a credential is a person's act and
stays a person's act — issuing a credential is not the credential acting.

## Deferred

Recorded here so the next phase starts from a decision rather than a gap:

- **A machine write surface**, with its own scopes and its own tests. The
  idempotency machinery is already built so that the first write route is not
  the moment somebody designs retry semantics under pressure.
- **Machine access to submission evidence**, with short-lived URLs and its own
  audit trail.
- **Credential lifecycle in the database**, the Phase 17 shape, which would
  make the API-client system writes forgery-proof against the application
  itself rather than merely separated from every tenant-scoped path.
- **Per-client usage metering**, which the `last_used_at` minute resolution
  deliberately does not approximate.
- **OAuth 2.0, OIDC, JWT, mTLS, signed requests.** Phase 19 is a client id and
  a secret over TLS; a bearer token would trade immediate revocation for a
  saved lookup, and "revoked within fifteen minutes" is not what an
  administrator believes they clicked.
