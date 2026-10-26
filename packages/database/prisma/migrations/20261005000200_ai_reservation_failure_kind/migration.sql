-- =============================================================================
-- ADR-0149 — one more reason an AI review can fail: its reservation lapsed
--
-- A worker re-checks the AI fee's reservation before every provider call and
-- fails the review — without calling the provider, without charging — when it
-- has expired or been released. That failure needs a name the known-kinds
-- check accepts. The new list is a strict superset of the old one, so every
-- existing row still satisfies it; nothing is rewritten.
-- =============================================================================
ALTER TABLE "ai_reviews" DROP CONSTRAINT "ai_reviews_failure_kind_known";
ALTER TABLE "ai_reviews"
    ADD CONSTRAINT "ai_reviews_failure_kind_known" CHECK (
        "failure_kind" IS NULL OR "failure_kind" IN (
            'RATE_LIMITED', 'OVERLOADED', 'TIMEOUT', 'NETWORK', 'AUTHENTICATION',
            'INVALID_REQUEST', 'PROVIDER_REFUSAL', 'OUTPUT_INVALID',
            'MODEL_UNAVAILABLE', 'CONTEXT_TOO_LARGE', 'UNKNOWN_PROVIDER_ERROR',
            'RESERVATION_EXPIRED'
        )
    );
