# ADR-0122: An endpoint's URL and secret live in immutable configuration versions

- **Status:** Accepted
- **Date:** 2026-09-18
- **Phase:** 17

## Context

The obvious model puts the URL and the signing secret on the endpoint row and
updates them in place. It fails in three places at once. A delivery in flight
was signed with a secret that no longer exists, so its signature stops meaning
anything. A typo in a URL silently stops an integration with no way back to
what it was. And "when did this change, and to what" has no answer.

## Decision

**The endpoint holds no URL and no secret.** Both live in
`WebhookEndpointConfigVersion` rows, which are immutable except for their
lifecycle status and their cryptographic envelope — and those are separate
operations with separate authority, so a rewrap cannot activate and an
activation cannot re-point a URL.

The endpoint points at two versions: the one currently serving
(`current_config_version_id`) and the one waiting to be verified
(`pending_config_version_id`), with at most one pending per endpoint.

A delivery references the configuration version it was created with, and keeps
it.

## Consequences

Changing a URL or rotating a secret is the same operation shape: a new version,
which must be verified before it serves. The verified one keeps serving in the
meantime, so a typo costs nothing.

An unsettled delivery is still signed with the secret it was created under,
which is why the rotation hazard is a first-class thing in the API and the UI:
a receiver keeps the previous secret valid until the unsettled
old-configuration count reaches zero. PalCert never re-signs an old delivery
with a new secret, because that is the one change a receiver cannot detect.

Configuration history is a read surface rather than an audit reconstruction.
