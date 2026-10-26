# ADR-0127: Durable management intents, and a bounded window to re-read a secret

- **Status:** Accepted
- **Date:** 2026-09-18
- **Phase:** 17

## Context

Six webhook operations either mint a credential or send something to a third
party. Each has the same failure: the client's connection drops after PalCert
commits, the client retries, and without something durable in between the retry
creates a second endpoint, a second secret or a second outbound message.

The secret case is worse than the others. A caller who never saw the response
has no other way to learn the signing secret PalCert generated, and minting a
new one means the receiver they just configured is already wrong.

## Decision

**Every such mutation requires an `Idempotency-Key` and is recorded as a
`WebhookManagementOperation`.**

The key is hashed rather than stored — keeping a client-supplied string beside
the resources it can re-address is an invitation. The request is fingerprinted
from its *meaning*: the normalized URL rather than what was typed, a sorted set
rather than whatever order the client listed.

Three answers, and the distinctions matter to whoever is debugging: the same
actor repeating the same request gets the original result; a different actor
using the same key gets `WEBHOOK_IDEMPOTENCY_KEY_CONFLICT`; the same actor with
a changed request gets `WEBHOOK_IDEMPOTENCY_KEY_REUSED`.

**For the two secret-bearing operations, a 24-hour recovery window.** The
secret is sealed under the keyring with additional authenticated data binding it
to the operation, the organization, the actor, the endpoint and the
configuration version, and the identical request returns the identical secret
until the window closes. Unlimited identical repeats, no additional side
effect. Afterwards the read path refuses *before decrypting anything*, with
`WEBHOOK_IDEMPOTENCY_KEY_EXPIRED`.

## Consequences

There is no "show me the current secret" route, and there never will be: it
would turn every read of the settings screen into a credential disclosure and
make "who has seen this secret?" unanswerable.

The window is measured by the application's clock, which the reveal doorway is
given explicitly. Two clocks deciding one deadline is a bug even when they
usually agree.

The sweeper that clears expired ciphertext is storage hygiene. The authority for
expiry is the read path.
