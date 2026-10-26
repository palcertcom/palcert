# ADR-0007: Blockchain-ready, not blockchain-integrated

- **Status:** Accepted
- **Date:** 2026-09-12
- **Phase:** 0

## Context

Verifiable certification invites blockchain anchoring, but v1 explicitly
excludes smart contracts, cryptocurrency, wallets, chain integrations, on-chain
transactions, decentralized storage and gas payments (§4). Retrofitting
integrity guarantees later, however, would require reprocessing historical
documents and reports — which may no longer exist.

## Decision

Implement no blockchain functionality in v1. Instead, compute and persist
**SHA-256 hashes for every immutable artifact** as it is created:

| Artifact | Hash |
| --- | --- |
| Uploaded document version | document SHA-256 |
| Published standard version | standard version hash |
| Machine report | report hash |
| Issued certificate | certificate hash |

Hashes are computed at creation time, stored alongside the artifact, and never
recomputed from mutable state. This leaves room for a future

```
Trust Anchor Service → Blockchain
```

that anchors existing hashes without touching the document or compliance
systems.

## Alternatives considered

- **Anchor to a chain in v1.** Rejected by product decision; adds custody, cost
  and regulatory surface with no v1 customer requirement.
- **Add hashes later.** Rejected: historical artifacts could not be hashed
  retroactively with any integrity meaning.

## Consequences

- A small, constant hashing cost per artifact.
- The hash algorithm and the exact byte range hashed must be recorded per
  artifact so a future verifier can reproduce it.
