# ADR-0054: The AI provider sits behind a port, and there is exactly one of them

- **Status:** Accepted
- **Date:** 2026-09-13
- **Phase:** 8

## Context

PalCert's AI layer calls a third-party model API. Two failure modes are
foreseeable and both are expensive to fix later: business logic that reaches
for a vendor SDK directly, so the vendor's shape spreads through the codebase;
and a speculative multi-provider abstraction built before anyone needs one, so
the interface is a lowest common denominator of APIs nobody has used.

## Decision

All AI work goes through an abstract `AIProviderPort`: capabilities, token
counting, rule assessment, report supplement, availability probe. No service,
controller or job handler imports a vendor SDK.

Exactly two implementations exist, and neither is speculative:

- `AnthropicAIProvider` — the one that serves real users.
- `FakeAIProvider` — deterministic, for tests only. Configuration validation
  **refuses it when `NODE_ENV=production`**, because presenting invented
  assessments to someone as a review of their thesis would be the most
  dishonest thing this codebase could do.

There is no empty third adapter added for architectural symmetry, and there is
no fallback to a second company. If the configured provider is unavailable, the
review fails and says so.

## Alternatives considered

**Call the SDK from the services.** Rejected: it makes the vendor's error
classes, retry behaviour and response shape a load-bearing part of PalCert's
domain code, and makes the fake provider impossible without mocking HTTP.

**Fall back to another provider on failure.** Rejected outright. The user
consented to *a* category of external processing on the understanding that
PalCert controls where their document goes. Silently routing it to a second
company on an overload would break that, and the user would never know.

## Consequences

- Swapping or adding a provider is a new adapter plus a configuration value.
- Every test path — refusal, rate limiting, malformed output, hallucinated
  evidence — is exercised without a network, a credential or a bill.
- Provider unavailability degrades the AI feature only. The deterministic
  product is untouched, and `/health/ready` does not probe the provider.
