-- =============================================================================
-- Phase 14 — the submission preparation job type, and a fifth isolation class
--
-- In its own migration for the reason Phase 6 and Phase 13 already met:
-- PostgreSQL adds an enum value inside a transaction but will not let the same
-- transaction use it, and Prisma runs each migration file in one transaction.
-- The tables in the next migration reference both of these, so both are
-- committed first.
-- =============================================================================

-- Copying one official submission's evidence into its snapshot. Durable,
-- because a half-copied handoff must never become visible to an institution.
ALTER TYPE "ProcessingJobType" ADD VALUE IF NOT EXISTS 'SUBMISSION_PREPARE';


-- ---------------------------------------------------------------------------
-- DUAL_PARTY_SCOPED
--
-- Phase 2 established four isolation classes, and every table since has fitted
-- one of them. An official submission fits none: it is legitimately readable
-- by the author who created it *and* by the organization they handed it to,
-- and those two are not the same party in any sense the existing classes model.
--
-- Labelling it USER_SCOPED would make the coverage test assert something false
-- — that `owner_user_id` alone decides who sees the row. Labelling it
-- TENANT_SCOPED would be worse: it would say the organization owns the
-- author's submission. Leaving it out of the catalogue is not an option, since
-- the catalogue exists precisely so a new table cannot be added without being
-- isolated (Phase 2 §4).
--
-- So the catalogue gains a fifth class rather than an exception. A
-- DUAL_PARTY_SCOPED table must name an owner column, must have RLS enabled and
-- forced, must be policied for all four commands, and its policies must name
-- both parties in USING and only the owner in WITH CHECK — the organization
-- reads what it was given and never writes a submission on the author's
-- behalf. The coverage test asserts each of those.
-- ---------------------------------------------------------------------------
ALTER TABLE "table_isolation_classification"
    DROP CONSTRAINT "table_isolation_classification_classification_check";

ALTER TABLE "table_isolation_classification"
    ADD CONSTRAINT "table_isolation_classification_classification_check"
    CHECK ("classification" IN ('GLOBAL', 'TENANT_SCOPED', 'USER_SCOPED', 'SYSTEM', 'DUAL_PARTY_SCOPED'));

-- A dual-party table must say who its owner is, exactly as a tenant table must
-- say who its tenant is.
ALTER TABLE "table_isolation_classification"
    ADD CONSTRAINT "dual_party_requires_column"
    CHECK ("classification" <> 'DUAL_PARTY_SCOPED' OR "tenant_column" IS NOT NULL);
