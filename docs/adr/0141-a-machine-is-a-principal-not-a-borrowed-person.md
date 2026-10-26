# ADR-0141: A machine is a principal, not a borrowed person

- **Status:** Accepted
- **Date:** 2026-09-20
- **Phase:** 19

## Context

Phase 19 gives an organization credentials its own systems can use. The
cheapest way to build that — and the way most products build it first — is to
let a credential authenticate *as somebody*: mint a service user, give it a
membership, and reuse every guard, every query and every audit path unchanged.

Everything downstream then works on the first try, which is exactly the
problem. A service user has an id, so `app_current_user_id()` answers with it,
so the Phase-14 submission policy's personal branch
(`owner_user_id = app_current_user_id()`) matches — and the machine can see a
person's own submissions inside the organization, which no human reviewer can.
It has a membership, so its roles are a role bundle somebody will widen for an
unrelated reason. It has a `userId`, so every audit row an integration produces
names a person who did not act, and an auditor reading the log after an
incident cannot tell the two apart. None of those is a bug in a service user;
they are what a service user *is*.

The second question is what a credential may reach. "It belongs to the
organization, so it may do what the organization may do" is the other cheap
answer, and it means every route PalCert adds later is silently reachable by
every existing integration.

## Decision

**A machine authenticates as itself.** `MachinePrincipal` is its own type with
an `apiClientId` and no `userId` — not an optional one, none — so a service
that wants to ask "was this me?" cannot compile against a machine. Audit rows
carry `actor_type` (`USER`, `API_CLIENT`, `SYSTEM`) with a database constraint
that the kind and the columns agree, so a row cannot claim to be an integration
and name a person. Machine reads run under
`withTenant({ organizationId, userId: '' })`: the empty user id is not a
shortcut but the mechanism — RLS then matches the organization branch of every
policy and none of the personal one, so "a machine cannot see a person's own
submissions" is enforced by PostgreSQL rather than by a `where` clause somebody
has to remember.

**Access is an allow-list of named operations, not a permission bundle.** Every
route a machine can reach declares a `@MachineOperation`, each operation maps
to exactly one scope, and a route that declares none is unreachable. The
`API_CLIENT` role holds `permissions: []` on purpose. Adding a route anywhere
else in PalCert never widens machine access; widening it is an edit to one
file, visible in review.

**The credential's secret exists once.** Cryptographically random, shown once,
stored only as an Argon2id verifier. The reveal type is separate from the read
type precisely so returning a secret is a deliberate act visible in a
signature, and the read type has no field that could hold one.

## Alternatives considered

**A service user per credential.** Rejected above: it inherits the personal RLS
branch, the role bundle and the borrowed audit actor, and each of those is a
disclosure waiting for an unrelated change.

**JWT bearer tokens.** A signed token needs no lookup, which is its appeal and
its problem: revocation stops being immediate. "Revoked" that means "revoked
within fifteen minutes" is not what an administrator believes they clicked. The
per-request verifier check costs one Argon2 comparison, which the throttle
bounds, and buys revocation that is true on the very next request.

**Reusing the Phase-17 webhook signing secret as an inbound credential.** Those
secrets authenticate *PalCert to a receiver*. Accepting one inbound would make
every receiver that holds one able to impersonate the organization to PalCert,
which inverts the direction of trust the whole webhook design rests on.

**Translating `API_CLIENT` into the organization's permissions.** Rejected: it
makes every future route a retroactive grant to every existing credential.

## Consequences

A machine cannot reach a personal check, a balance, a payment record, a
document's contents, an administrative function or certificate issuance —
because there is no route that names those operations, not because a guard
refuses them.

Audit answers "who did this?" with three distinguishable kinds, and the log can
be read after an incident without inferring which nulls meant what.

Phase 19 ships no machine write surface. The idempotency machinery is built
anyway, because the first mutating route must not be the moment somebody
designs retry semantics under pressure.

The cost is a second read path: `IntegrationReadService` queries for itself
rather than reusing the human services, because those take a `userId` and
several of them legitimately use it. A blank one would work until a service
asked a question about it, and then it would answer something false rather than
refusing.
