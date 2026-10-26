-- ===========================================================================
-- Phase 9 — guideline sources, rule extraction and proposals
--
-- One sentence governs every line below: AI proposes, an authorized human
-- decides. The application enforces it; this file makes it true even if the
-- application is wrong.
--
--   * AI output and human decisions are different tables, so a decision can
--     never be written by rewriting what the model said.
--   * A completed run, its evidence and its proposals are append-only, by
--     trigger rather than by convention.
--   * Every table is organization-scoped under FORCE ROW LEVEL SECURITY, with
--     composite foreign keys so a proposal in one organization cannot point at
--     another's evidence even if service code tried.
--   * Nothing here touches standard_versions, standard_rules or any published
--     content hash. An accepted proposal becomes an ordinary Phase 3 rule
--     through the ordinary Phase 3 path.
--
-- Sections:
--   1. Generated DDL (Prisma)
--   2. Processing job wiring
--   3. Composite tenancy keys
--   4. Invariants
--   5. Immutability
--   6. Isolation classification
--   7. Row-level security
--   8. Permissions
--   9. Grants
-- ===========================================================================

-- ===========================================================================
-- 1. Generated DDL
--
--    Additive only. `prisma migrate diff` also proposes dropping every
--    hand-written composite tenancy key from Phases 5-8 and the isolation
--    catalogue itself, because none of them are expressible in the Prisma
--    schema. Those proposals are discarded: this migration adds Phase 9 and
--    changes nothing that came before it (§163).
-- ===========================================================================

-- CreateEnum
CREATE TYPE "StandardSourceKind" AS ENUM ('GUIDELINE_PDF', 'GUIDELINE_DOCX', 'TEMPLATE_DOCX');

-- CreateEnum
CREATE TYPE "StandardSourceStatus" AS ENUM ('AWAITING_UPLOAD', 'UPLOADED', 'VALIDATING', 'SCANNING', 'READY', 'REJECTED', 'FAILED', 'CANCELLED', 'UPLOAD_EXPIRED');

-- CreateEnum
CREATE TYPE "StandardSourceAuthority" AS ENUM ('PRIMARY', 'SUPPLEMENTARY', 'REFERENCE');

-- CreateEnum
CREATE TYPE "RuleExtractionStatus" AS ENUM ('CREATED', 'QUEUED', 'DISCOVERING_EVIDENCE', 'GENERATING_PROPOSALS', 'VALIDATING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('EXPLICIT_TEXT', 'VISUAL_EVIDENCE', 'TEMPLATE_OBSERVATION');

-- CreateEnum
CREATE TYPE "EvidenceLocatorType" AS ENUM ('PDF_PAGE', 'DOCX_NODE', 'TEXT_CHAR', 'FACT_SCOPE', 'NONE');

-- CreateEnum
CREATE TYPE "ObservationUniformity" AS ENUM ('UNIFORM', 'MOSTLY_UNIFORM', 'MIXED', 'INSUFFICIENT_SAMPLE');

-- CreateEnum
CREATE TYPE "RuleProposalKind" AS ENUM ('EXPLICIT_REQUIREMENT', 'TEMPLATE_INFERENCE', 'AMBIGUOUS_REQUIREMENT', 'CONFLICTING_REQUIREMENT', 'UNREPRESENTABLE_REQUIREMENT');

-- CreateEnum
CREATE TYPE "RuleProposalStatus" AS ENUM ('PENDING_REVIEW', 'ACCEPTED', 'MODIFIED_AND_ACCEPTED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ProposalValidationStatus" AS ENUM ('VALID', 'INVALID', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "ProposalConflictStatus" AS ENUM ('NONE', 'EXISTING_RULE_CODE', 'EXISTING_RULE_EXPECTATION', 'CROSS_SOURCE');

-- CreateEnum
CREATE TYPE "AutomationSupport" AS ENUM ('SUPPORTED_DOCX', 'PARTIAL_DOCX', 'NOT_CURRENTLY_MEASURABLE', 'NOT_APPLICABLE');

-- CreateTable
CREATE TABLE "standard_source_assets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "standard_version_id" UUID NOT NULL,
    "source_kind" "StandardSourceKind" NOT NULL,
    "status" "StandardSourceStatus" NOT NULL DEFAULT 'AWAITING_UPLOAD',
    "authority" "StandardSourceAuthority",
    "original_filename" TEXT NOT NULL,
    "declared_mime_type" TEXT,
    "detected_mime_type" TEXT,
    "expected_format" "DocumentFormat" NOT NULL,
    "detected_format" "DocumentFormat",
    "declared_size_bytes" INTEGER NOT NULL,
    "size_bytes" INTEGER,
    "client_sha256" TEXT,
    "sha256" TEXT,
    "page_count" INTEGER,
    "quarantine_object_key" TEXT NOT NULL,
    "quarantine_object_version_id" TEXT,
    "quarantine_object_etag" TEXT,
    "quarantine_deleted_at" TIMESTAMP(3),
    "clean_object_key" TEXT,
    "clean_object_version_id" TEXT,
    "clean_object_etag" TEXT,
    "scan_engine" TEXT,
    "scan_signature" TEXT,
    "idempotency_key" TEXT,
    "upload_expires_at" TIMESTAMP(3) NOT NULL,
    "rejection_code" TEXT,
    "failure_code" TEXT,
    "failure_detail" TEXT,
    "retention_locked_at" TIMESTAMP(3),
    "uploaded_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "uploaded_at" TIMESTAMP(3),
    "validated_at" TIMESTAMP(3),
    "scanned_at" TIMESTAMP(3),
    "ready_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),

    CONSTRAINT "standard_source_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_ai_consents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "consent_version" TEXT NOT NULL,
    "provider_category" TEXT NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL,
    "accepted_by_user_id" UUID,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_ai_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_extraction_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "standard_version_id" UUID NOT NULL,
    "status" "RuleExtractionStatus" NOT NULL DEFAULT 'CREATED',
    "base_standard_revision" INTEGER NOT NULL,
    "rule_schema_version" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "configured_model" TEXT NOT NULL,
    "provider_returned_model" TEXT,
    "prompt_version" TEXT NOT NULL,
    "prompt_hash" TEXT NOT NULL,
    "context_builder_version" TEXT NOT NULL,
    "proposal_schema_version" INTEGER NOT NULL,
    "source_set_hash" TEXT NOT NULL,
    "extraction_run_hash" TEXT,
    "sources_processed" INTEGER,
    "evidence_count" INTEGER,
    "observation_count" INTEGER,
    "explicit_requirement_count" INTEGER,
    "template_inference_count" INTEGER,
    "ambiguous_requirement_count" INTEGER,
    "conflicting_requirement_count" INTEGER,
    "unrepresentable_requirement_count" INTEGER,
    "invalid_proposal_count" INTEGER,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "invocation_count" INTEGER NOT NULL DEFAULT 0,
    "failure_kind" TEXT,
    "failure_detail" TEXT,
    "idempotency_key" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),

    CONSTRAINT "rule_extraction_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_extraction_run_sources" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "extraction_run_id" UUID NOT NULL,
    "source_asset_id" UUID NOT NULL,
    "source_kind" "StandardSourceKind" NOT NULL,
    "source_sha256" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_extraction_run_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extraction_invocations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "extraction_run_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "source_asset_id" UUID,
    "configured_model" TEXT NOT NULL,
    "provider_returned_model" TEXT,
    "prompt_version" TEXT NOT NULL,
    "prompt_hash" TEXT NOT NULL,
    "context_builder_version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "provider_request_id" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "started_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "latency_ms" INTEGER,
    "failure_kind" TEXT,
    "failure_detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extraction_invocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_evidence" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "extraction_run_id" UUID NOT NULL,
    "source_asset_id" UUID NOT NULL,
    "evidence_kind" "EvidenceKind" NOT NULL,
    "locator_type" "EvidenceLocatorType" NOT NULL,
    "start_page" INTEGER,
    "end_page" INTEGER,
    "node_ids" TEXT[],
    "start_char_index" INTEGER,
    "end_char_index" INTEGER,
    "excerpt" TEXT NOT NULL,
    "excerpt_hash" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_observations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "extraction_run_id" UUID NOT NULL,
    "source_asset_id" UUID NOT NULL,
    "scope_key" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "property" TEXT NOT NULL,
    "unit" TEXT,
    "modal_value" TEXT,
    "occurrence_count" INTEGER NOT NULL,
    "matching_count" INTEGER NOT NULL,
    "distinct_value_count" INTEGER NOT NULL,
    "uniformity" "ObservationUniformity" NOT NULL,
    "distribution" JSONB NOT NULL,
    "observation_hash" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_proposals" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "extraction_run_id" UUID NOT NULL,
    "proposal_key" TEXT NOT NULL,
    "kind" "RuleProposalKind" NOT NULL,
    "status" "RuleProposalStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "validation_status" "ProposalValidationStatus" NOT NULL,
    "validation_issues" JSONB,
    "automation_support" "AutomationSupport" NOT NULL,
    "conflict_status" "ProposalConflictStatus" NOT NULL,
    "conflict_existing_rule_id" UUID,
    "conflict_existing_rule_code" TEXT,
    "conflict_detail" TEXT,
    "related_proposal_keys" TEXT[],
    "suggested_rule" JSONB,
    "suggested_rule_code" TEXT,
    "interpretation_en" TEXT NOT NULL,
    "interpretation_ar" TEXT NOT NULL,
    "ambiguity_note" TEXT,
    "requires_clarification" BOOLEAN NOT NULL,
    "display_order" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_proposal_evidence" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "proposal_id" UUID NOT NULL,
    "source_evidence_id" UUID,
    "template_observation_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_proposal_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_proposal_decisions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "proposal_id" UUID NOT NULL,
    "decision" "RuleProposalStatus" NOT NULL,
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMP(3) NOT NULL,
    "resulting_rule_id" UUID,
    "rejection_reason" TEXT,
    "review_notes" TEXT,
    "accepted_rule" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_proposal_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "standard_rule_provenance" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "standard_rule_id" UUID NOT NULL,
    "extraction_run_id" UUID NOT NULL,
    "proposal_id" UUID NOT NULL,
    "source_asset_id" UUID NOT NULL,
    "source_sha256" TEXT NOT NULL,
    "evidence_kind" "EvidenceKind" NOT NULL,
    "locator_type" "EvidenceLocatorType" NOT NULL,
    "start_page" INTEGER,
    "end_page" INTEGER,
    "node_ids" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "standard_rule_provenance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "standard_source_assets_standard_version_id_created_at_id_idx" ON "standard_source_assets"("standard_version_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "standard_source_assets_organization_id_status_idx" ON "standard_source_assets"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "standard_source_assets_org_idempotency_key" ON "standard_source_assets"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "standard_source_assets_id_org_key" ON "standard_source_assets"("id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_ai_consents_organization_id_key" ON "organization_ai_consents"("organization_id");

-- CreateIndex
CREATE INDEX "rule_extraction_runs_standard_version_id_created_at_id_idx" ON "rule_extraction_runs"("standard_version_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "rule_extraction_runs_organization_id_status_idx" ON "rule_extraction_runs"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "rule_extraction_runs_org_idempotency_key" ON "rule_extraction_runs"("organization_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "rule_extraction_runs_id_org_key" ON "rule_extraction_runs"("id", "organization_id");

-- CreateIndex
CREATE INDEX "rule_extraction_run_sources_organization_id_idx" ON "rule_extraction_run_sources"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "rule_extraction_run_sources_extraction_run_id_source_asset__key" ON "rule_extraction_run_sources"("extraction_run_id", "source_asset_id");

-- CreateIndex
CREATE INDEX "extraction_invocations_organization_id_idx" ON "extraction_invocations"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "extraction_invocations_call_identity" ON "extraction_invocations"("extraction_run_id", "purpose", "source_asset_id", "attempt");

-- CreateIndex
CREATE INDEX "source_evidence_extraction_run_id_ordinal_idx" ON "source_evidence"("extraction_run_id", "ordinal");

-- CreateIndex
CREATE INDEX "source_evidence_organization_id_idx" ON "source_evidence"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_evidence_run_excerpt_key" ON "source_evidence"("extraction_run_id", "excerpt_hash");

-- CreateIndex
CREATE UNIQUE INDEX "source_evidence_id_org_key" ON "source_evidence"("id", "organization_id");

-- CreateIndex
CREATE INDEX "template_observations_extraction_run_id_ordinal_idx" ON "template_observations"("extraction_run_id", "ordinal");

-- CreateIndex
CREATE INDEX "template_observations_organization_id_idx" ON "template_observations"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "template_observations_run_hash_key" ON "template_observations"("extraction_run_id", "observation_hash");

-- CreateIndex
CREATE UNIQUE INDEX "template_observations_id_org_key" ON "template_observations"("id", "organization_id");

-- CreateIndex
CREATE INDEX "rule_proposals_extraction_run_id_display_order_idx" ON "rule_proposals"("extraction_run_id", "display_order");

-- CreateIndex
CREATE INDEX "rule_proposals_organization_id_status_idx" ON "rule_proposals"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "rule_proposals_extraction_run_id_proposal_key_key" ON "rule_proposals"("extraction_run_id", "proposal_key");

-- CreateIndex
CREATE UNIQUE INDEX "rule_proposals_id_org_key" ON "rule_proposals"("id", "organization_id");

-- CreateIndex
CREATE INDEX "rule_proposal_evidence_organization_id_idx" ON "rule_proposal_evidence"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "rule_proposal_evidence_proposal_evidence_key" ON "rule_proposal_evidence"("proposal_id", "source_evidence_id");

-- CreateIndex
CREATE UNIQUE INDEX "rule_proposal_evidence_proposal_observation_key" ON "rule_proposal_evidence"("proposal_id", "template_observation_id");

-- CreateIndex
CREATE UNIQUE INDEX "rule_proposal_decisions_proposal_id_key" ON "rule_proposal_decisions"("proposal_id");

-- CreateIndex
CREATE INDEX "rule_proposal_decisions_organization_id_decision_idx" ON "rule_proposal_decisions"("organization_id", "decision");

-- CreateIndex
CREATE INDEX "standard_rule_provenance_standard_rule_id_idx" ON "standard_rule_provenance"("standard_rule_id");

-- CreateIndex
CREATE INDEX "standard_rule_provenance_organization_id_idx" ON "standard_rule_provenance"("organization_id");

-- CreateIndex
CREATE INDEX "standard_rule_provenance_source_asset_id_idx" ON "standard_rule_provenance"("source_asset_id");

-- AddForeignKey
ALTER TABLE "standard_source_assets" ADD CONSTRAINT "standard_source_assets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standard_source_assets" ADD CONSTRAINT "standard_source_assets_standard_version_id_fkey" FOREIGN KEY ("standard_version_id") REFERENCES "standard_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standard_source_assets" ADD CONSTRAINT "standard_source_assets_uploaded_by_user_id_fkey" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_ai_consents" ADD CONSTRAINT "organization_ai_consents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_ai_consents" ADD CONSTRAINT "organization_ai_consents_accepted_by_user_id_fkey" FOREIGN KEY ("accepted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_ai_consents" ADD CONSTRAINT "organization_ai_consents_revoked_by_user_id_fkey" FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_extraction_runs" ADD CONSTRAINT "rule_extraction_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_extraction_runs" ADD CONSTRAINT "rule_extraction_runs_standard_version_id_fkey" FOREIGN KEY ("standard_version_id") REFERENCES "standard_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_extraction_runs" ADD CONSTRAINT "rule_extraction_runs_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_extraction_run_sources" ADD CONSTRAINT "rule_extraction_run_sources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_extraction_run_sources" ADD CONSTRAINT "rule_extraction_run_sources_extraction_run_id_fkey" FOREIGN KEY ("extraction_run_id") REFERENCES "rule_extraction_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_extraction_run_sources" ADD CONSTRAINT "rule_extraction_run_sources_source_asset_id_fkey" FOREIGN KEY ("source_asset_id") REFERENCES "standard_source_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extraction_invocations" ADD CONSTRAINT "extraction_invocations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extraction_invocations" ADD CONSTRAINT "extraction_invocations_extraction_run_id_fkey" FOREIGN KEY ("extraction_run_id") REFERENCES "rule_extraction_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_evidence" ADD CONSTRAINT "source_evidence_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_evidence" ADD CONSTRAINT "source_evidence_extraction_run_id_fkey" FOREIGN KEY ("extraction_run_id") REFERENCES "rule_extraction_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_evidence" ADD CONSTRAINT "source_evidence_source_asset_id_fkey" FOREIGN KEY ("source_asset_id") REFERENCES "standard_source_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_observations" ADD CONSTRAINT "template_observations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_observations" ADD CONSTRAINT "template_observations_extraction_run_id_fkey" FOREIGN KEY ("extraction_run_id") REFERENCES "rule_extraction_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_observations" ADD CONSTRAINT "template_observations_source_asset_id_fkey" FOREIGN KEY ("source_asset_id") REFERENCES "standard_source_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_proposals" ADD CONSTRAINT "rule_proposals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_proposals" ADD CONSTRAINT "rule_proposals_extraction_run_id_fkey" FOREIGN KEY ("extraction_run_id") REFERENCES "rule_extraction_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_proposal_evidence" ADD CONSTRAINT "rule_proposal_evidence_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_proposal_evidence" ADD CONSTRAINT "rule_proposal_evidence_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "rule_proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_proposal_evidence" ADD CONSTRAINT "rule_proposal_evidence_source_evidence_id_fkey" FOREIGN KEY ("source_evidence_id") REFERENCES "source_evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_proposal_evidence" ADD CONSTRAINT "rule_proposal_evidence_template_observation_id_fkey" FOREIGN KEY ("template_observation_id") REFERENCES "template_observations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_proposal_decisions" ADD CONSTRAINT "rule_proposal_decisions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_proposal_decisions" ADD CONSTRAINT "rule_proposal_decisions_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "rule_proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_proposal_decisions" ADD CONSTRAINT "rule_proposal_decisions_resulting_rule_id_fkey" FOREIGN KEY ("resulting_rule_id") REFERENCES "standard_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_proposal_decisions" ADD CONSTRAINT "rule_proposal_decisions_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standard_rule_provenance" ADD CONSTRAINT "standard_rule_provenance_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standard_rule_provenance" ADD CONSTRAINT "standard_rule_provenance_standard_rule_id_fkey" FOREIGN KEY ("standard_rule_id") REFERENCES "standard_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standard_rule_provenance" ADD CONSTRAINT "standard_rule_provenance_extraction_run_id_fkey" FOREIGN KEY ("extraction_run_id") REFERENCES "rule_extraction_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standard_rule_provenance" ADD CONSTRAINT "standard_rule_provenance_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "rule_proposals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standard_rule_provenance" ADD CONSTRAINT "standard_rule_provenance_source_asset_id_fkey" FOREIGN KEY ("source_asset_id") REFERENCES "standard_source_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- 2. Processing job wiring
--
--    Phase 9 reuses the Phase 5 ledger and outbox rather than inventing a
--    queue (§112). Two new resource types, and nothing else changes.
-- ===========================================================================
-- A job that processes organization-owned work carries the tenant, so a worker
-- can re-establish its scope from the persisted row rather than from the queue
-- message -- exactly as it already does from `owner_user_id` (ADR-0018). Null
-- for the user-private work of Phases 5-8, which is unchanged.
ALTER TABLE "processing_jobs" ADD COLUMN "organization_id" UUID;

ALTER TABLE "processing_jobs"
    ADD CONSTRAINT "processing_jobs_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Organization work carries an organization; user-private work does not. A job
-- claiming neither would be a job no worker could scope correctly.
ALTER TABLE "processing_jobs"
    ADD CONSTRAINT "processing_jobs_tenancy_matches_type" CHECK (
        ("resource_type" IN ('STANDARD_SOURCE_ASSET', 'RULE_EXTRACTION_RUN')
            AND "organization_id" IS NOT NULL)
        OR ("resource_type" NOT IN ('STANDARD_SOURCE_ASSET', 'RULE_EXTRACTION_RUN')
            AND "organization_id" IS NULL)
    );

ALTER TABLE "processing_jobs" DROP CONSTRAINT "processing_jobs_resource_type_known";
ALTER TABLE "processing_jobs"
    ADD CONSTRAINT "processing_jobs_resource_type_known"
    CHECK ("resource_type" IN (
        'DOCUMENT_VERSION', 'DOCUMENT', 'DOCUMENT_ANALYSIS', 'CHECK_RUN', 'AI_REVIEW',
        'STANDARD_SOURCE_ASSET', 'RULE_EXTRACTION_RUN'));

-- ===========================================================================
-- 3. Composite tenancy keys
--
--    Every child carries its organization explicitly *and* is bound to a
--    parent with the same one, so "Organization A's run against Organization
--    B's standard version" is refused by the database rather than by a code
--    path somebody could forget (§116).
-- ===========================================================================
-- `standard_rules` never needed a composite key of its own until now: an
-- accepted proposal points at the rule it created, and that rule must belong
-- to the same organization. Additive, and it changes nothing about the table.
CREATE UNIQUE INDEX "standard_rules_id_org_key" ON "standard_rules"("id", "organization_id");

ALTER TABLE "standard_source_assets"
    ADD CONSTRAINT "standard_source_assets_version_org_fkey"
    FOREIGN KEY ("standard_version_id", "organization_id")
    REFERENCES "standard_versions" ("id", "organization_id") ON DELETE CASCADE;

ALTER TABLE "rule_extraction_runs"
    ADD CONSTRAINT "rule_extraction_runs_version_org_fkey"
    FOREIGN KEY ("standard_version_id", "organization_id")
    REFERENCES "standard_versions" ("id", "organization_id") ON DELETE CASCADE;

ALTER TABLE "rule_extraction_run_sources"
    ADD CONSTRAINT "rule_extraction_run_sources_run_org_fkey"
    FOREIGN KEY ("extraction_run_id", "organization_id")
    REFERENCES "rule_extraction_runs" ("id", "organization_id") ON DELETE CASCADE;

ALTER TABLE "rule_extraction_run_sources"
    ADD CONSTRAINT "rule_extraction_run_sources_source_org_fkey"
    FOREIGN KEY ("source_asset_id", "organization_id")
    REFERENCES "standard_source_assets" ("id", "organization_id") ON DELETE RESTRICT;

ALTER TABLE "extraction_invocations"
    ADD CONSTRAINT "extraction_invocations_run_org_fkey"
    FOREIGN KEY ("extraction_run_id", "organization_id")
    REFERENCES "rule_extraction_runs" ("id", "organization_id") ON DELETE CASCADE;

ALTER TABLE "source_evidence"
    ADD CONSTRAINT "source_evidence_run_org_fkey"
    FOREIGN KEY ("extraction_run_id", "organization_id")
    REFERENCES "rule_extraction_runs" ("id", "organization_id") ON DELETE CASCADE;

ALTER TABLE "source_evidence"
    ADD CONSTRAINT "source_evidence_source_org_fkey"
    FOREIGN KEY ("source_asset_id", "organization_id")
    REFERENCES "standard_source_assets" ("id", "organization_id") ON DELETE RESTRICT;

ALTER TABLE "template_observations"
    ADD CONSTRAINT "template_observations_run_org_fkey"
    FOREIGN KEY ("extraction_run_id", "organization_id")
    REFERENCES "rule_extraction_runs" ("id", "organization_id") ON DELETE CASCADE;

ALTER TABLE "template_observations"
    ADD CONSTRAINT "template_observations_source_org_fkey"
    FOREIGN KEY ("source_asset_id", "organization_id")
    REFERENCES "standard_source_assets" ("id", "organization_id") ON DELETE RESTRICT;

ALTER TABLE "rule_proposals"
    ADD CONSTRAINT "rule_proposals_run_org_fkey"
    FOREIGN KEY ("extraction_run_id", "organization_id")
    REFERENCES "rule_extraction_runs" ("id", "organization_id") ON DELETE CASCADE;

ALTER TABLE "rule_proposal_evidence"
    ADD CONSTRAINT "rule_proposal_evidence_proposal_org_fkey"
    FOREIGN KEY ("proposal_id", "organization_id")
    REFERENCES "rule_proposals" ("id", "organization_id") ON DELETE CASCADE;

ALTER TABLE "rule_proposal_decisions"
    ADD CONSTRAINT "rule_proposal_decisions_proposal_org_fkey"
    FOREIGN KEY ("proposal_id", "organization_id")
    REFERENCES "rule_proposals" ("id", "organization_id") ON DELETE CASCADE;

-- An accepted rule and the decision that created it must belong to the same
-- organization as the proposal. Three composite keys, one property.
ALTER TABLE "rule_proposal_decisions"
    ADD CONSTRAINT "rule_proposal_decisions_rule_org_fkey"
    FOREIGN KEY ("resulting_rule_id", "organization_id")
    REFERENCES "standard_rules" ("id", "organization_id") ON DELETE SET NULL;

ALTER TABLE "standard_rule_provenance"
    ADD CONSTRAINT "standard_rule_provenance_rule_org_fkey"
    FOREIGN KEY ("standard_rule_id", "organization_id")
    REFERENCES "standard_rules" ("id", "organization_id") ON DELETE CASCADE;

ALTER TABLE "standard_rule_provenance"
    ADD CONSTRAINT "standard_rule_provenance_run_org_fkey"
    FOREIGN KEY ("extraction_run_id", "organization_id")
    REFERENCES "rule_extraction_runs" ("id", "organization_id") ON DELETE RESTRICT;

ALTER TABLE "standard_rule_provenance"
    ADD CONSTRAINT "standard_rule_provenance_proposal_org_fkey"
    FOREIGN KEY ("proposal_id", "organization_id")
    REFERENCES "rule_proposals" ("id", "organization_id") ON DELETE RESTRICT;

ALTER TABLE "standard_rule_provenance"
    ADD CONSTRAINT "standard_rule_provenance_source_org_fkey"
    FOREIGN KEY ("source_asset_id", "organization_id")
    REFERENCES "standard_source_assets" ("id", "organization_id") ON DELETE RESTRICT;

-- ===========================================================================
-- 4. Invariants
--
--    The properties the phase claims, written where no service can forget them.
-- ===========================================================================

-- Digests are digests.
ALTER TABLE "standard_source_assets"
    ADD CONSTRAINT "standard_source_assets_hash_formats" CHECK (
        ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$')
        AND ("client_sha256" IS NULL OR "client_sha256" ~ '^[0-9a-f]{64}$')
    );

-- A READY source has the identity everything downstream depends on. Anything
-- less is not READY, whatever a service believed.
ALTER TABLE "standard_source_assets"
    ADD CONSTRAINT "standard_source_assets_ready_identity" CHECK (
        "status" <> 'READY'
        OR ("sha256" IS NOT NULL AND "size_bytes" IS NOT NULL
            AND "clean_object_key" IS NOT NULL AND "detected_format" IS NOT NULL
            AND "ready_at" IS NOT NULL)
    );

-- The declared kind and the format must agree: a "guideline PDF" that is a
-- DOCX is a mislabelled row, and downstream code reads the kind.
ALTER TABLE "standard_source_assets"
    ADD CONSTRAINT "standard_source_assets_kind_format" CHECK (
        ("source_kind" = 'GUIDELINE_PDF' AND "expected_format" = 'PDF')
        OR ("source_kind" IN ('GUIDELINE_DOCX', 'TEMPLATE_DOCX') AND "expected_format" = 'DOCX')
    );

ALTER TABLE "rule_extraction_runs"
    ADD CONSTRAINT "rule_extraction_runs_hash_formats" CHECK (
        "source_set_hash" ~ '^[0-9a-f]{64}$'
        AND "prompt_hash" ~ '^[0-9a-f]{64}$'
        AND ("extraction_run_hash" IS NULL OR "extraction_run_hash" ~ '^[0-9a-f]{64}$')
    );

-- A completed run has an identity and counters; a failed one has a reason.
ALTER TABLE "rule_extraction_runs"
    ADD CONSTRAINT "rule_extraction_runs_completion_identity" CHECK (
        "status" <> 'COMPLETED'
        OR ("completed_at" IS NOT NULL AND "extraction_run_hash" IS NOT NULL
            AND "sources_processed" IS NOT NULL AND "failure_kind" IS NULL)
    );

ALTER TABLE "rule_extraction_runs"
    ADD CONSTRAINT "rule_extraction_runs_failure_identity" CHECK (
        "status" <> 'FAILED' OR ("failed_at" IS NOT NULL AND "failure_kind" IS NOT NULL)
    );

ALTER TABLE "source_evidence"
    ADD CONSTRAINT "source_evidence_hash_format"
    CHECK ("excerpt_hash" ~ '^[0-9a-f]{64}$');

-- A locator must actually locate. PDF evidence carries pages, DOCX evidence
-- carries node ids, character evidence carries offsets — and only VISUAL
-- evidence is allowed to carry nothing, because pretending a visual reading has
-- a precise text citation is the dishonesty §88 forbids.
ALTER TABLE "source_evidence"
    ADD CONSTRAINT "source_evidence_locator_complete" CHECK (
        ("locator_type" = 'PDF_PAGE' AND "start_page" IS NOT NULL AND "end_page" IS NOT NULL
            AND "end_page" >= "start_page")
        OR ("locator_type" = 'DOCX_NODE' AND array_length("node_ids", 1) >= 1)
        OR ("locator_type" = 'TEXT_CHAR' AND "start_char_index" IS NOT NULL
            AND "end_char_index" IS NOT NULL AND "end_char_index" >= "start_char_index")
        OR ("locator_type" = 'FACT_SCOPE')
        OR ("locator_type" = 'NONE' AND "evidence_kind" = 'VISUAL_EVIDENCE')
    );

ALTER TABLE "template_observations"
    ADD CONSTRAINT "template_observations_counts_sane" CHECK (
        "occurrence_count" >= 0
        AND "matching_count" >= 0
        AND "matching_count" <= "occurrence_count"
        AND "distinct_value_count" >= 0
    );

ALTER TABLE "template_observations"
    ADD CONSTRAINT "template_observations_hash_format"
    CHECK ("observation_hash" ~ '^[0-9a-f]{64}$');

-- The central safety constraint of the phase.
--
-- Only a proposal that says the source *states* a requirement may claim to be
-- an explicit institutional requirement, and it may say so only with a rule
-- definition attached. A template inference is likewise required to carry one.
-- An ambiguous, conflicting or unrepresentable proposal carries none: it is
-- information for a reviewer, not a rule waiting to be clicked (§44, §54).
ALTER TABLE "rule_proposals"
    ADD CONSTRAINT "rule_proposals_kind_shape" CHECK (
        ("kind" IN ('EXPLICIT_REQUIREMENT', 'TEMPLATE_INFERENCE')
            AND "suggested_rule" IS NOT NULL
            AND "suggested_rule_code" IS NOT NULL
            AND "validation_status" <> 'NOT_APPLICABLE')
        OR ("kind" IN ('AMBIGUOUS_REQUIREMENT', 'CONFLICTING_REQUIREMENT',
                       'UNREPRESENTABLE_REQUIREMENT'))
    );

-- A proposal that is not pending has been decided by a person, and a decided
-- one has a decision row. The trigger below enforces the second half; this
-- refuses the obvious half up front.
ALTER TABLE "rule_proposals"
    ADD CONSTRAINT "rule_proposals_conflict_shape" CHECK (
        ("conflict_status" = 'NONE' AND "conflict_existing_rule_id" IS NULL)
        OR "conflict_status" <> 'NONE'
    );

-- Exactly one link, never both and never neither: a row pointing at nothing is
-- a proposal resting on nothing.
ALTER TABLE "rule_proposal_evidence"
    ADD CONSTRAINT "rule_proposal_evidence_exactly_one" CHECK (
        ("source_evidence_id" IS NOT NULL) <> ("template_observation_id" IS NOT NULL)
    );

-- An acceptance produces a rule; a rejection produces a reason and no rule.
-- Recording an acceptance with nothing to show for it would make the audit
-- trail a fiction (§66).
ALTER TABLE "rule_proposal_decisions"
    ADD CONSTRAINT "rule_proposal_decisions_outcome_shape" CHECK (
        ("decision" IN ('ACCEPTED', 'MODIFIED_AND_ACCEPTED') AND "resulting_rule_id" IS NOT NULL)
        OR ("decision" = 'REJECTED' AND "resulting_rule_id" IS NULL)
        OR ("decision" = 'SUPERSEDED' AND "resulting_rule_id" IS NULL)
    );

-- A human edit is recorded as an edit. Claiming MODIFIED_AND_ACCEPTED while
-- storing nothing that differs would hide what the person actually chose (§68).
ALTER TABLE "rule_proposal_decisions"
    ADD CONSTRAINT "rule_proposal_decisions_edit_recorded" CHECK (
        "decision" <> 'MODIFIED_AND_ACCEPTED' OR "accepted_rule" IS NOT NULL
    );

ALTER TABLE "standard_rule_provenance"
    ADD CONSTRAINT "standard_rule_provenance_hash_format"
    CHECK ("source_sha256" ~ '^[0-9a-f]{64}$');

-- ===========================================================================
-- 5. Immutability
--
--    A completed extraction is a historical record. Someone may have read a
--    proposal, decided against it, and written that decision down; rewriting
--    the proposal afterwards would make that decision unintelligible.
--
--    Enforced by trigger rather than by service discipline, for the same
--    reason Phase 3 freezes published versions: the guarantee has to survive
--    the next person who writes an UPDATE (§153).
-- ===========================================================================

-- A source's bytes and identity are written once (§8).
CREATE OR REPLACE FUNCTION standard_source_assets_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW."organization_id" <> OLD."organization_id"
        OR NEW."standard_version_id" <> OLD."standard_version_id"
        OR NEW."source_kind" <> OLD."source_kind"
        OR NEW."quarantine_object_key" <> OLD."quarantine_object_key"
        OR (OLD."sha256" IS NOT NULL AND NEW."sha256" IS DISTINCT FROM OLD."sha256")
        OR (OLD."clean_object_key" IS NOT NULL
            AND NEW."clean_object_key" IS DISTINCT FROM OLD."clean_object_key")
    THEN
        RAISE EXCEPTION 'standard source identity is immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;
    -- A settled source stays settled. Only the retention lock and the
    -- quarantine tombstone may move afterwards, because both are operational
    -- facts about storage rather than claims about the document.
    IF OLD."status" IN ('READY', 'REJECTED', 'FAILED', 'CANCELLED', 'UPLOAD_EXPIRED')
        AND NEW."status" <> OLD."status"
    THEN
        RAISE EXCEPTION 'standard source % is already settled', OLD."id"
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER standard_source_assets_guard
    BEFORE UPDATE ON "standard_source_assets"
    FOR EACH ROW EXECUTE FUNCTION standard_source_assets_guard();

-- A run's bindings are written once, and a finished run does not move.
CREATE OR REPLACE FUNCTION rule_extraction_runs_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW."organization_id" <> OLD."organization_id"
        OR NEW."standard_version_id" <> OLD."standard_version_id"
        OR NEW."source_set_hash" <> OLD."source_set_hash"
        OR NEW."base_standard_revision" <> OLD."base_standard_revision"
        OR NEW."prompt_hash" <> OLD."prompt_hash"
        OR NEW."proposal_schema_version" <> OLD."proposal_schema_version"
        OR (OLD."extraction_run_hash" IS NOT NULL
            AND NEW."extraction_run_hash" IS DISTINCT FROM OLD."extraction_run_hash")
    THEN
        RAISE EXCEPTION 'extraction run identity is immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" IN ('COMPLETED', 'FAILED', 'CANCELLED') AND NEW."status" <> OLD."status" THEN
        RAISE EXCEPTION 'extraction run % is already settled', OLD."id"
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER rule_extraction_runs_guard
    BEFORE UPDATE ON "rule_extraction_runs"
    FOR EACH ROW EXECUTE FUNCTION rule_extraction_runs_guard();

-- Evidence and observations are written, never edited. What the provider cited
-- and what PalCert measured are facts about a moment.
CREATE OR REPLACE FUNCTION extraction_output_append_only() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER source_evidence_append_only
    BEFORE UPDATE ON "source_evidence"
    FOR EACH ROW EXECUTE FUNCTION extraction_output_append_only();

CREATE TRIGGER template_observations_append_only
    BEFORE UPDATE ON "template_observations"
    FOR EACH ROW EXECUTE FUNCTION extraction_output_append_only();

CREATE TRIGGER rule_proposal_evidence_append_only
    BEFORE UPDATE ON "rule_proposal_evidence"
    FOR EACH ROW EXECUTE FUNCTION extraction_output_append_only();

CREATE TRIGGER standard_rule_provenance_append_only
    BEFORE UPDATE ON "standard_rule_provenance"
    FOR EACH ROW EXECUTE FUNCTION extraction_output_append_only();

-- A proposal's AI content is immutable; only its review status moves, and only
-- away from PENDING_REVIEW. This is the structural half of "do not mutate AI
-- history to look like the human chose what the AI proposed" (§66).
CREATE OR REPLACE FUNCTION rule_proposals_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW."organization_id" <> OLD."organization_id"
        OR NEW."extraction_run_id" <> OLD."extraction_run_id"
        OR NEW."proposal_key" <> OLD."proposal_key"
        OR NEW."kind" <> OLD."kind"
        OR NEW."suggested_rule" IS DISTINCT FROM OLD."suggested_rule"
        OR NEW."suggested_rule_code" IS DISTINCT FROM OLD."suggested_rule_code"
        OR NEW."interpretation_en" <> OLD."interpretation_en"
        OR NEW."interpretation_ar" <> OLD."interpretation_ar"
        OR NEW."validation_status" <> OLD."validation_status"
    THEN
        RAISE EXCEPTION 'proposal content is immutable; a human decision is a separate row'
            USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" <> 'PENDING_REVIEW' AND NEW."status" <> OLD."status" THEN
        RAISE EXCEPTION 'proposal % has already been decided', OLD."id"
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER rule_proposals_guard
    BEFORE UPDATE ON "rule_proposals"
    FOR EACH ROW EXECUTE FUNCTION rule_proposals_guard();

-- A decision is a record of what someone did. It is not revised.
CREATE OR REPLACE FUNCTION rule_proposal_decisions_append_only() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    RAISE EXCEPTION 'a review decision is a historical record and cannot be changed'
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER rule_proposal_decisions_append_only
    BEFORE UPDATE ON "rule_proposal_decisions"
    FOR EACH ROW EXECUTE FUNCTION rule_proposal_decisions_append_only();

-- Nothing in Phase 9 may reach a published version.
--
-- The Phase 3 freeze triggers already refuse to change a published version or
-- its rules, which is the guarantee that matters. This adds the other half: a
-- source or run cannot be *attached* to a version that is no longer a draft,
-- so "extract into a published standard" fails at the first write rather than
-- at the last one (§72, §117).
CREATE OR REPLACE FUNCTION extraction_requires_draft_version() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    version_status TEXT;
BEGIN
    SELECT "status"::text INTO version_status
    FROM "standard_versions" WHERE "id" = NEW."standard_version_id";

    IF version_status IS DISTINCT FROM 'DRAFT' THEN
        RAISE EXCEPTION 'standard version % is % and cannot take new % rows',
            NEW."standard_version_id", COALESCE(version_status, 'missing'), TG_TABLE_NAME
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER standard_source_assets_requires_draft
    BEFORE INSERT ON "standard_source_assets"
    FOR EACH ROW EXECUTE FUNCTION extraction_requires_draft_version();

CREATE TRIGGER rule_extraction_runs_requires_draft
    BEFORE INSERT ON "rule_extraction_runs"
    FOR EACH ROW EXECUTE FUNCTION extraction_requires_draft_version();

-- ===========================================================================
-- 6. Isolation classification
--
--    Every private table registered, so the catalogue-driven coverage test
--    fails if one is ever added without a policy (§114).
-- ===========================================================================
INSERT INTO "table_isolation_classification" ("table_name", "classification", "tenant_column", "notes")
VALUES
    ('standard_source_assets',      'TENANT_SCOPED', 'organization_id', 'An institution''s own guidelines and templates. Unlike student documents these are organization-owned, and the two authorization models are never mixed.'),
    ('organization_ai_consents',    'TENANT_SCOPED', 'organization_id', 'The organization''s agreement to external AI processing of its own documents. Never the personal Phase 8 consent.'),
    ('rule_extraction_runs',        'TENANT_SCOPED', 'organization_id', 'One reading of one exact source set, bound to a draft version.'),
    ('rule_extraction_run_sources', 'TENANT_SCOPED', 'organization_id', 'Exactly which sources a run read, and the bytes they were.'),
    ('extraction_invocations',      'TENANT_SCOPED', 'organization_id', 'Provider-call metadata. Never the prompt, the response or the API key.'),
    ('source_evidence',             'TENANT_SCOPED', 'organization_id', 'Provider-grounded citations of an organization''s own guideline. Append-only.'),
    ('template_observations',       'TENANT_SCOPED', 'organization_id', 'Deterministic measurements of an organization''s own template. Append-only.'),
    ('rule_proposals',              'TENANT_SCOPED', 'organization_id', 'What the AI suggested. Immutable; the human decision is a separate table.'),
    ('rule_proposal_evidence',      'TENANT_SCOPED', 'organization_id', 'What a proposal rests on. Exactly one of evidence or observation.'),
    ('rule_proposal_decisions',     'TENANT_SCOPED', 'organization_id', 'What a person decided. The only place an acceptance is recorded.'),
    ('standard_rule_provenance',    'TENANT_SCOPED', 'organization_id', 'Where an accepted rule came from. Metadata only: it is deliberately not part of the Phase 3 canonical snapshot, so it changes no content hash.');

-- ===========================================================================
-- 7. Row-level security
--
--    Same shape as Phases 2 and 3, and for the same reason: application
--    authorization decides every request, and these policies are what stops a
--    bug there from becoming a cross-tenant leak. Cross-tenant access to an
--    institution's unpublished guidelines is a critical failure (§11, §12).
--
--    Each policy is a single-column comparison. No policy joins to a parent:
--    resolving the tenant through `standard_versions` would make this table's
--    safety depend on that one's policy being right.
-- ===========================================================================
ALTER TABLE "standard_source_assets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "standard_source_assets" FORCE ROW LEVEL SECURITY;
CREATE POLICY "standard_source_assets_all" ON "standard_source_assets" FOR ALL
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin() OR "organization_id" = app_current_organization());

ALTER TABLE "organization_ai_consents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_ai_consents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_ai_consents_all" ON "organization_ai_consents" FOR ALL
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin() OR "organization_id" = app_current_organization());

ALTER TABLE "rule_extraction_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rule_extraction_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "rule_extraction_runs_all" ON "rule_extraction_runs" FOR ALL
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin() OR "organization_id" = app_current_organization());

ALTER TABLE "rule_extraction_run_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rule_extraction_run_sources" FORCE ROW LEVEL SECURITY;
CREATE POLICY "rule_extraction_run_sources_all" ON "rule_extraction_run_sources" FOR ALL
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin() OR "organization_id" = app_current_organization());

ALTER TABLE "extraction_invocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "extraction_invocations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "extraction_invocations_all" ON "extraction_invocations" FOR ALL
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin() OR "organization_id" = app_current_organization());

ALTER TABLE "source_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_evidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY "source_evidence_all" ON "source_evidence" FOR ALL
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin() OR "organization_id" = app_current_organization());

ALTER TABLE "template_observations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "template_observations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "template_observations_all" ON "template_observations" FOR ALL
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin() OR "organization_id" = app_current_organization());

ALTER TABLE "rule_proposals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rule_proposals" FORCE ROW LEVEL SECURITY;
CREATE POLICY "rule_proposals_all" ON "rule_proposals" FOR ALL
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin() OR "organization_id" = app_current_organization());

ALTER TABLE "rule_proposal_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rule_proposal_evidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY "rule_proposal_evidence_all" ON "rule_proposal_evidence" FOR ALL
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin() OR "organization_id" = app_current_organization());

ALTER TABLE "rule_proposal_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rule_proposal_decisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "rule_proposal_decisions_all" ON "rule_proposal_decisions" FOR ALL
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin() OR "organization_id" = app_current_organization());

ALTER TABLE "standard_rule_provenance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "standard_rule_provenance" FORCE ROW LEVEL SECURITY;
CREATE POLICY "standard_rule_provenance_all" ON "standard_rule_provenance" FOR ALL
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin() OR "organization_id" = app_current_organization());

-- ===========================================================================
-- 8. Permissions
--
--    Uploading a guideline, asking PalCert to read it, and deciding that what
--    it found becomes a rule are three different acts (§13).
--
--    Two separations matter most. Accepting a proposal is not publishing: the
--    Phase 3 publish permission is untouched and nothing here grants it (§73).
--    And agreeing to external AI processing on the organization's behalf is
--    its own permission, held only by owners and admins, so a template manager
--    doing their job cannot accept data-processing terms for the institution
--    (§16).
-- ===========================================================================
INSERT INTO "permissions" ("id", "code", "description") VALUES
    (gen_random_uuid(), 'standard:source:read',           'Read the guideline and template sources of a standard version'),
    (gen_random_uuid(), 'standard:source:create',         'Upload a guideline or template source'),
    (gen_random_uuid(), 'standard:source:delete',         'Remove an unused source'),
    (gen_random_uuid(), 'standard:extraction:read',       'Read extraction runs and their results'),
    (gen_random_uuid(), 'standard:extraction:run',        'Ask PalCert to read sources and propose rules'),
    (gen_random_uuid(), 'standard:proposal:review',       'Read and comment on rule proposals'),
    (gen_random_uuid(), 'standard:proposal:decide',       'Accept, edit-and-accept or reject a rule proposal'),
    (gen_random_uuid(), 'organization:ai-consent:manage', 'Agree, for the organization, to external AI processing of its documents');

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON TRUE
WHERE
    -- Everyone who can read a standard can see what it was built from, and a
    -- reviewer's job is exactly to read proposals.
    (r."code" IN ('ORGANIZATION_OWNER', 'ORGANIZATION_ADMIN', 'ORGANIZATION_REVIEWER', 'TEMPLATE_MANAGER')
        AND p."code" IN ('standard:source:read', 'standard:extraction:read',
                         'standard:proposal:review'))
    -- Authoring, for the roles whose job it is. A template manager uploads
    -- sources, runs extraction and decides on proposals — all of which produce
    -- draft rules, which they may already write.
 OR (r."code" IN ('ORGANIZATION_OWNER', 'ORGANIZATION_ADMIN', 'TEMPLATE_MANAGER')
        AND p."code" IN ('standard:source:create', 'standard:source:delete',
                         'standard:extraction:run', 'standard:proposal:decide'))
    -- Committing the organization to external processing is not an authoring
    -- act, and is deliberately not granted to a template manager.
 OR (r."code" IN ('ORGANIZATION_OWNER', 'ORGANIZATION_ADMIN')
        AND p."code" = 'organization:ai-consent:manage');

-- ===========================================================================
-- 9. Grants
--
--    Data only. The application role can read and write these rows; it cannot
--    drop a policy, disable RLS, or remove the triggers above from itself.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON
    "standard_source_assets", "organization_ai_consents", "rule_extraction_runs",
    "rule_extraction_run_sources", "extraction_invocations", "source_evidence",
    "template_observations", "rule_proposals", "rule_proposal_evidence",
    "rule_proposal_decisions", "standard_rule_provenance"
    TO palcert_app;

GRANT EXECUTE ON FUNCTION standard_source_assets_guard() TO palcert_app;
GRANT EXECUTE ON FUNCTION rule_extraction_runs_guard() TO palcert_app;
GRANT EXECUTE ON FUNCTION extraction_output_append_only() TO palcert_app;
GRANT EXECUTE ON FUNCTION rule_proposals_guard() TO palcert_app;
GRANT EXECUTE ON FUNCTION rule_proposal_decisions_append_only() TO palcert_app;
GRANT EXECUTE ON FUNCTION extraction_requires_draft_version() TO palcert_app;
