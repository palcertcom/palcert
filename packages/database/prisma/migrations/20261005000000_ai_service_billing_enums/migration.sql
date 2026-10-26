-- =============================================================================
-- ADR-0149 — AI service billing: enum values
--
-- PostgreSQL will not let a transaction add a value to an enum and then use
-- it, so the new products and purchasable resources arrive in their own
-- migration ahead of the one that seeds and binds them — the same split every
-- earlier billing phase made.
-- =============================================================================

-- What PalCert sells: an AI review of a check report, and AI extraction of
-- proposed rules from guideline sources.
ALTER TYPE "ServiceProductCode" ADD VALUE IF NOT EXISTS 'AI_REVIEW';
ALTER TYPE "ServiceProductCode" ADD VALUE IF NOT EXISTS 'AI_RULE_EXTRACTION';

-- What each purchase pays for: one ai_reviews row, one rule_extraction_runs row.
ALTER TYPE "ServiceResourceType" ADD VALUE IF NOT EXISTS 'AI_REVIEW';
ALTER TYPE "ServiceResourceType" ADD VALUE IF NOT EXISTS 'AI_RULE_EXTRACTION';
