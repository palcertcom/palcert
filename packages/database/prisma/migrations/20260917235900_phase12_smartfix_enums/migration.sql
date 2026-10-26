-- =============================================================================
-- Phase 12 — SmartFix enum values
--
-- PostgreSQL will not let a transaction add a value to an enum and then use
-- it, so the new job types and the new purchasable resource arrive in their
-- own migration ahead of the one that needs them — the same split Phases 6
-- through 11 each made for the same reason.
-- =============================================================================

-- A correction is two pieces of durable work, not one. SMARTFIX_EXECUTE
-- transforms the document and starts the recheck; SMARTFIX_FINALIZE runs when
-- that recheck completes, decides whether the correction may be delivered, and
-- only then charges for it. Splitting them is what lets the recheck be an
-- ordinary check with its own queue, its own retries and its own failures.
ALTER TYPE "ProcessingJobType" ADD VALUE IF NOT EXISTS 'SMARTFIX_EXECUTE';
ALTER TYPE "ProcessingJobType" ADD VALUE IF NOT EXISTS 'SMARTFIX_FINALIZE';

-- Phase 10 already published the SMARTFIX *product*; this is the *resource* it
-- buys. Reusing the Phase 10 product and the Phase 11 purchase domain is
-- deliberate: there is one billing framework, and a second one would mean two
-- answers to "was I charged for this?".
ALTER TYPE "ServiceResourceType" ADD VALUE IF NOT EXISTS 'SMARTFIX';
