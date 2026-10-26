# The integration API and machine credentials

**Phase 19.** How an organization's own systems read from PalCert: what a
credential is, what it can reach, how it is rotated and revoked, and what
happens when something goes wrong.

Related: [ADR-0141](../adr/0141-a-machine-is-a-principal-not-a-borrowed-person.md)
for why a machine is its own principal, [tenancy.md](tenancy.md) for the four
layers every read passes through, and [webhooks.md](webhooks.md) for the
outbound direction, which is a different capability with a different secret.

## What a credential is

An **API client** belongs to exactly one organization. It is not a user, does
not have a user, and cannot be made into one: there is no impersonation path
and no `userId` on the principal it produces.

It carries two values:

| | Shape | Secret? |
|---|---|---|
| Client id | `pcid_` + 32 hex characters | No. Public, displayable, loggable. |
| Client secret | `pcsk_` + 64 hex characters (32 random bytes) | Yes. Shown once, ever. |

PalCert stores an Argon2id verifier of the secret and nothing else. There is no
API that returns a secret after the response that created it, and there is no
column that could. If a secret is lost, rotation is the only way forward — the
management screen says so before it shows the value, not after.

## Authenticating

HTTP Basic over TLS, client id as the username and client secret as the
password:

```bash
curl -u "$PALCERT_CLIENT_ID:$PALCERT_CLIENT_SECRET" \
  https://api.palcert.ps/api/v1/integration/v1/organization
```

Basic rather than something bespoke because every HTTP client on every platform
already implements it correctly, which matters more for an integration
credential than novelty does.

**PalCert never reads a credential from a query string or a body field.** A
secret in a URL is a secret in every proxy log between the caller and the
server; the guard ignores it, and the logger redacts any `pcsk_` token that
reaches a logged URL anyway, so a client library that gets this wrong costs the
request rather than the credential.

### Every refusal looks the same

A failed authentication is always:

```
401  { "error": { "code": "API_CLIENT_AUTHENTICATION_FAILED", ... } }
```

Identically for an unknown client id, a wrong secret, a revoked client, a
disabled client, an expired client, an elapsed rotation overlap and a suspended
organization. The difference between two rejections is an oracle: a caller who
can tell "no such client" from "wrong secret" can enumerate which credentials
exist, and one who can tell "disabled" from "revoked" learns an organization's
internal state. The real reason is in PalCert's logs, where the administrator
who needs it can see it.

A credential is also only as live as the organization behind it: a suspended
institution's integrations stop with the institution, without anybody having to
revoke them one by one.

## Scopes

Four, all read-only:

| Scope | What a holder can see | What it deliberately cannot |
|---|---|---|
| `organization:read` | The organization's own profile; its standards and their **published** versions | Drafts — an integration acting on rules nobody approved is the failure this excludes |
| `submissions:read` | Submissions sent to this organization, their decision state and history | The attached document, the report, and who submitted it |
| `certificates:read` | Whether a certificate was issued, and its lifecycle events | The certificate PDF, and the verification code |
| `webhooks:read` | Whether outbound integrations are configured and healthy | The destination URL, and any signing secret |

Scopes are checked against a named **operation**, not a path. Every route a
machine can reach declares the operation it implements; a route that declares
none is unreachable. The complete list of operations is the complete answer to
"what can an integration do?", and adding a route anywhere else in PalCert
never widens it.

An operation the credential lacks the scope for is `403
API_CLIENT_SCOPE_INSUFFICIENT` — a different answer from 401, because the
credential is fine and the caller should not go looking at their secret.

Phase 19 ships **no machine write surface**. A machine that can act wrongly at
scale is a different class of incident from one that can only read, and the
write surface arrives when a concrete integration asks for it, with its own
tests.

## What a machine cannot reach, and why

Not by a guard refusing it — there is no route that names it:

- A person's own checks, documents or reports.
- A balance, a payment, or anything from a payment provider.
- Document contents, in any format.
- Administrative functions, or certificate issuance and revocation controls.
- Another organization. **There is no `organizationId` parameter on any
  integration route.** The tenant comes from the credential, which removes
  cross-organization IDOR as a category rather than defending against it.

A machine also cannot see a person's own submissions inside its own
organization. Machine reads run with an empty user id, so PostgreSQL's
row-level security matches the organization branch of every policy and none of
the personal one.

## Rotation

```bash
curl -u "$ID:$SECRET" -X POST \
  -H 'Idempotency-Key: <uuid>' \
  -d '{"overlapSeconds": 3600}' \
  https://api.palcert.ps/api/v1/organizations/$ORG/api-clients/$CLIENT/secret
```

A rotation mints a new secret and puts the previous one into a **bounded
overlap** during which both work, so a deployment can be rolled out without
downtime.

- The overlap is at most **twelve hours**. A rotation that left the old secret
  valid for ever would be an accidental second permanent credential, which is
  the thing rotation exists to remove.
- `overlapSeconds: 0` retires the previous secret immediately. That is the right
  answer when the reason for rotating is that the old one leaked.
- **At most two secrets are ever live**, enforced by partial unique indexes
  rather than by application care. A second rotation while an overlap is still
  running is refused with `409 API_CLIENT_ROTATION_IN_PROGRESS`, including when
  two rotations race — the loser gets the same 409 the sequential path returns,
  never an internal error.
- Revocation ends any overlap in the same transaction.

## Disabling and revoking

They are different acts and the difference matters during an incident:

| | Reversible? | Secrets | Use when |
|---|---|---|---|
| **Disable** | Yes | Survive; re-enabling needs no redeploy | Pausing an integration |
| **Revoke** | **No** | Every one retired immediately | You believe the credential is compromised |

`REVOKED` is final in the database, not just in the service: a trigger refuses
any transition out of it. A client an organization was told is dead cannot come
back because a later code path set a status without checking.

## Rate limits

Two windows, per credential rather than per IP — a customer's whole estate is
often one egress address, so an IP limit either throttles a real integration or
throttles nothing.

| Window | Limit | Counted |
|---|---|---|
| Authentication attempts | 60/minute per client id | Whether or not the secret was right |
| Authenticated requests | 600/minute per client | On success |

Failures are counted on a separate key from successes, so a busy legitimate
integration does not raise the ceiling an attacker guessing against the same
client id gets to hide under.

Over the limit is `429 API_CLIENT_RATE_LIMITED` — never 401, because telling a
working integration its secret broke is the wrong diagnosis.

## Idempotency

Required on the two routes that mint a credential: create and rotate. A create
without a key cannot be retried safely, and the failure mode — a second
credential the customer did not ask for and may not know about — is exactly
what a machine-credential feature must not do.

Send `Idempotency-Key: <uuid>`. Repeating the identical request within the
recovery window returns the identical response, **including the secret**, so a
client that lost its answer to a timeout can get it back. Repeating the same key
with a *different* request is refused. Once the window has closed the secret is
gone for good and rotation is the way forward.

## Error contract

| Code | HTTP | Meaning |
|---|---|---|
| `API_CLIENT_AUTHENTICATION_FAILED` | 401 | Any authentication failure, indistinguishably |
| `API_CLIENT_SCOPE_INSUFFICIENT` | 403 | Valid credential, operation outside its scopes |
| `API_CLIENT_OPERATION_NOT_PERMITTED` | 403 | Route is not on the machine allow-list |
| `API_CLIENT_RATE_LIMITED` | 429 | Over either window |
| `API_CLIENT_NOT_FOUND` | 404 | Management: no such client in this organization |
| `API_CLIENT_LIMIT_REACHED` | 409 | Management: this organization already holds the maximum |
| `API_CLIENT_TRANSITION_INVALID` | 409 | Management: not possible from the current status |
| `API_CLIENT_REVOKED` | 409 | Management: revocation is final |
| `API_CLIENT_ROTATION_IN_PROGRESS` | 409 | An overlap is still running |
| `API_CLIENT_ROTATION_OVERLAP_TOO_LONG` | 422 | Over twelve hours |
| `API_CLIENT_SCOPE_INVALID` | 422 | Not a scope PalCert offers; names the offender |
| `API_CLIENT_SCOPES_REQUIRED` | 422 | A client with no scopes could call nothing |
| `API_CLIENT_EXPIRY_INVALID` | 422 | Not in the future, or more than two years out |
| `API_CLIENT_SECRET_NO_LONGER_RECOVERABLE` | 410 | The idempotent recovery window has closed |

A `404` from an integration read is always "does not exist", including when the
row belongs to another organization. `403` would confirm it exists.

## Where the secret is not

Stated as a list because the absence is the feature:

- Not in the database in any recoverable form — an Argon2id verifier only.
- Not in any read response; the read type has no field that could carry one.
- Not in an audit record; audit metadata refuses keys matching
  `secret|token|credential|verifier`.
- Not in a log; `clientSecret`, `secretVerifier` and their variants are
  redaction paths, request headers are not serialized at all, and any `pcsk_`
  in a logged URL is replaced.
- Not in a webhook payload, and not in the URL.
- Not in the management UI after the panel that showed it once is dismissed —
  it lives in component state and nothing that outlives the page.

## Storage and isolation

| Table | Classification | Notes |
|---|---|---|
| `api_clients` | `TENANT_SCOPED` | An organization sees its own. The authentication path reads it through the system context, and a trigger confines that path to writing `last_used_at` alone. |
| `api_client_secrets` | `SYSTEM` | No tenant read path at all. Verifiers are not something an organization has a use for. |
| `api_client_operations` | `SYSTEM` | Idempotency records, including the short-lived sealed reveal copy. |

Nothing here is deletable: no `DELETE` policy and no `DELETE` grant. A revoked
client, a retired secret and a settled operation are records of what happened.

`last_used_at` is truncated to the minute on purpose. "Has this been used?" and
"is anything still calling?" are answered at minute resolution; second-level
timestamps across a set of credentials start to describe a customer's internal
schedule, which is not PalCert's to publish back to them.
