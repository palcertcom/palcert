# ADR-0003: AI provider abstraction

- **Status:** Accepted
- **Date:** 2026-09-12
- **Phase:** 0 (interface), Phase 8 (implementation)

## Context

PalCert's initial preferred model provider is the Anthropic Claude API, but
provider pricing, capability and availability change, and some institutions will
demand a specific provider or stricter data handling for confidential
unpublished research (§49).

## Decision

All AI access goes through an `AIProvider` interface:

```ts
interface AIProvider {
  extractRules(...): Promise<...>;
  analyzeSemanticStructure(...): Promise<...>;
  analyzeReferences(...): Promise<...>;
  explainFindings(...): Promise<...>;
  generateReportNarrative(...): Promise<...>;
}
```

Business logic depends on the interface only and never imports a vendor SDK.
Providers live under `ai/providers/<vendor>/`. Only the provider a phase
requires is implemented — Anthropic first.

Every AI call records provider, model, request type, latency, token usage, cost
metadata, prompt version and result version. All responses are validated against
strict schemas before persistence; an invalid response raises
`AI_RESPONSE_INVALID` and never corrupts deterministic results.

## Alternatives considered

- **Direct SDK calls at call sites.** Rejected: couples business logic to a
  vendor and makes per-organization provider policy impossible.
- **Third-party LLM gateway.** Deferred: adds a dependency that would receive
  confidential customer documents.

## Consequences

- One extra indirection per AI call.
- Provider routing per organization or per request type is a later
  configuration change, not a rewrite (§43 lists advanced routing as future).
- Cost and latency telemetry is uniform across providers.
