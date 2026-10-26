# ADR-0129: A secret rotation re-seals the destination, it does not rebuild it

- **Status:** Accepted
- **Date:** 2026-09-19
- **Phase:** 17

## Context

ADR-0122 makes every endpoint configuration immutable: a change is a new
version, never an edit. A secret rotation is therefore a new configuration
version carrying a new signing secret and *the same destination*.

"The same destination" is the hard part. Phase 17 deliberately keeps the
decrypted URL out of every tenant-facing surface: the read models publish
scheme, host and port and never the path, because a path routinely carries a
tenant identifier or a token an organization's own support staff should not read
out of a settings screen. That left the rotation path with no URL to copy —
and the obvious shortcut, rebuilding one from the tenant-safe projection, loses
the path silently. The endpoint would keep reporting the destination it always
reported while its events started arriving at the receiver's root.

## Decision

**A rotation reads the source version's sealed URL material and re-seals it,
byte for byte, against the new version id.**

The material is fetched through a narrow definer function that is authorized as
the tenant actor and verifies ownership in the database. It returns sealed URL
material and its binding only — never the source version's signing secret, which
a rotation has no reason to see. The server opens the URL inside the request,
re-validates it against the current URL policy, allocates the new configuration
version id, re-seals the exact normalized URL against that id, and generates a
fresh secret. Nothing in that sequence puts a URL in a DTO, a response, a log or
an audit entry.

**The source version is the pending one if there is one, otherwise the verified
one.** A pending version is what the organization most recently chose, so a
rotation during a URL change carries that change forward instead of reverting
it; an endpoint that has never verified can still recover from a lost first
secret. With neither, the rotation is refused.

**The rotation's idempotency fingerprint is the endpoint alone.** The
configuration version id is mutable server state that this very operation
changes, so including it would make the identical retry fingerprint against a
different id and be refused as a reuse — exactly when a caller who lost the
response needs the answer.

## Alternatives considered

**Rebuild the URL from the endpoint's read model.** Loses the path. Rejected:
it is a silent redirection of an organization's traffic, and nothing on the
outside distinguishes it from a working integration until deliveries fail.

**Publish the full URL on a tenant read surface so rotation can copy it.**
Rejected: it widens the privacy surface permanently to serve one internal step,
and it is the disclosure Phase 17 was built to avoid.

**Ask the administrator to retype the URL when rotating.** Rejected: a rotation
is usually an incident response, and a retyped URL is a second chance to make a
typo at the worst possible moment. It also conflates two operations that have
different permissions.

## Consequences

The URL policy is applied again on every rotation, so a destination that has
since become disallowed — a reserved range, a retired port, a host PalCert now
owns — is refused at rotation rather than carried forward.

Rotation is provable without disclosing anything: the stored `url_sha256` is a
digest over the whole normalized URL, so tests compare digests across versions
instead of comparing URLs.

There is still no dual-secret window. Deliveries already created stay bound to
the configuration they were created with, and the honest signal for when the
previous secret can be retired is `unsettledOldConfigDeliveries` reaching zero.
