-- =============================================================================
-- Phase 7 — Document checks, results and reports
--
-- The first end-to-end PalCert workflow: a user's document version, an
-- organization's published standard version, one analysis, one evaluation,
-- one immutable report.
--
-- Sections 1-3 are generated DDL. Everything after is hand-written, because
-- Prisma's schema language cannot model it and re-emits DROPs for it on every
-- diff (docs/architecture/development-setup.md).
-- =============================================================================

-- =============================================================================
-- 0. The processing-job ledger learns about check runs
--
--    Phase 5 constrained resource_type to the kinds that existed then, and
--    Phase 6 widened it once. A check run is another resource in the *same*
--    ledger rather than a queue of its own (§89).
-- =============================================================================
ALTER TABLE "processing_jobs" DROP CONSTRAINT "processing_jobs_resource_type_known";
ALTER TABLE "processing_jobs"
    ADD CONSTRAINT "processing_jobs_resource_type_known"
    CHECK ("resource_type" IN ('DOCUMENT_VERSION', 'DOCUMENT', 'DOCUMENT_ANALYSIS', 'CHECK_RUN'));

-- =============================================================================
-- 1. Enums, the standard availability column, tables, indexes, keys
-- =============================================================================
-- CreateEnum
CREATE TYPE "StandardCheckAvailability" AS ENUM ('PRIVATE', 'PUBLIC_CHECKABLE');

-- CreateEnum
CREATE TYPE "CheckStatus" AS ENUM ('CREATED', 'WAITING_ANALYSIS', 'EVALUATING', 'GENERATING_REPORT', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CheckRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "ComplianceDetermination" AS ENUM ('COMPLIANT', 'NON_COMPLIANT', 'REVIEW_REQUIRED', 'INDETERMINATE');

-- AlterTable
ALTER TABLE "document_analyses" ADD COLUMN     "artifact_purged_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "standards" ADD COLUMN     "check_availability" "StandardCheckAvailability" NOT NULL DEFAULT 'PRIVATE';

-- CreateTable
CREATE TABLE "document_checks" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "document_version_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "document_type_id" UUID NOT NULL,
    "standard_id" UUID NOT NULL,
    "standard_version_id" UUID NOT NULL,
    "document_sha256" TEXT NOT NULL,
    "standard_content_hash" TEXT NOT NULL,
    "organization_name" TEXT NOT NULL,
    "document_type_name" TEXT NOT NULL,
    "standard_code" TEXT NOT NULL,
    "standard_name" TEXT NOT NULL,
    "standard_version_label" TEXT NOT NULL,
    "status" "CheckStatus" NOT NULL DEFAULT 'CREATED',
    "current_run_id" UUID,
    "document_analysis_id" UUID,
    "idempotency_key" TEXT,
    "failure_code" TEXT,
    "failure_detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "check_runs" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "check_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "document_analysis_id" UUID,
    "analysis_artifact_sha256" TEXT,
    "rule_engine_name" TEXT,
    "rule_engine_version" TEXT,
    "rule_schema_version" INTEGER,
    "fact_schema_version" INTEGER,
    "orchestrator_version" TEXT NOT NULL,
    "status" "CheckRunStatus" NOT NULL DEFAULT 'PENDING',
    "determination" "ComplianceDetermination",
    "score_value" TEXT,
    "score_coverage" TEXT,
    "score_complete" BOOLEAN,
    "passed_weight" TEXT,
    "evaluated_weight" TEXT,
    "unresolved_weight" TEXT,
    "evaluation_hash" TEXT,
    "total_rules" INTEGER,
    "passed_rules" INTEGER,
    "failed_rules" INTEGER,
    "not_applicable_rules" INTEGER,
    "review_required_rules" INTEGER,
    "indeterminate_rules" INTEGER,
    "blocking_failures" INTEGER,
    "critical_failures" INTEGER,
    "major_failures" INTEGER,
    "minor_failures" INTEGER,
    "info_failures" INTEGER,
    "total_violations" INTEGER,
    "failure_code" TEXT,
    "failure_detail" TEXT,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "check_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "check_rule_results" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "check_run_id" UUID NOT NULL,
    "ruleCode" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "evaluation_mode" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "blocking" BOOLEAN NOT NULL,
    "display_order" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "evidence_level" TEXT NOT NULL,
    "requires_review" BOOLEAN NOT NULL,
    "operator" TEXT,
    "matched_fact_count" INTEGER NOT NULL DEFAULT 0,
    "evaluated_fact_count" INTEGER NOT NULL DEFAULT 0,
    "passed_fact_count" INTEGER NOT NULL DEFAULT 0,
    "failed_fact_count" INTEGER NOT NULL DEFAULT 0,
    "indeterminate_fact_count" INTEGER NOT NULL DEFAULT 0,
    "total_violation_count" INTEGER NOT NULL DEFAULT 0,
    "returned_violation_count" INTEGER NOT NULL DEFAULT 0,
    "violations_truncated" BOOLEAN NOT NULL DEFAULT false,
    "title_en" TEXT,
    "title_ar" TEXT,
    "guidance_en" TEXT,
    "guidance_ar" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "check_rule_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "check_violations" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "check_rule_result_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "reason_code" TEXT NOT NULL,
    "node_id" TEXT,
    "path" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "element_type" TEXT,
    "section_key" TEXT,
    "location_ordinal" INTEGER,
    "page" INTEGER,
    "expected_value" TEXT,
    "expected_unit" TEXT,
    "actual_value" TEXT,
    "actual_unit" TEXT,
    "tolerance" TEXT,

    CONSTRAINT "check_violations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "check_reports" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "check_id" UUID NOT NULL,
    "check_run_id" UUID NOT NULL,
    "report_schema_version" INTEGER NOT NULL,
    "report_canonicalization_version" INTEGER NOT NULL,
    "artifact_object_key" TEXT NOT NULL,
    "artifact_object_version_id" TEXT,
    "artifact_sha256" TEXT NOT NULL,
    "artifact_size_bytes" INTEGER NOT NULL,
    "report_hash" TEXT NOT NULL,
    "evaluation_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "check_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_checks_owner_user_id_created_at_id_idx" ON "document_checks"("owner_user_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "document_checks_document_version_id_idx" ON "document_checks"("document_version_id");

-- CreateIndex
CREATE INDEX "document_checks_status_document_analysis_id_idx" ON "document_checks"("status", "document_analysis_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_checks_owner_idempotency_key" ON "document_checks"("owner_user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "check_runs_owner_user_id_idx" ON "check_runs"("owner_user_id");

-- CreateIndex
CREATE INDEX "check_runs_check_id_created_at_idx" ON "check_runs"("check_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "check_runs_check_id_attempt_number_key" ON "check_runs"("check_id", "attempt_number");

-- CreateIndex
CREATE INDEX "check_rule_results_owner_user_id_idx" ON "check_rule_results"("owner_user_id");

-- CreateIndex
CREATE INDEX "check_rule_results_check_run_id_outcome_idx" ON "check_rule_results"("check_run_id", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "check_rule_results_check_run_id_ruleCode_key" ON "check_rule_results"("check_run_id", "ruleCode");

-- CreateIndex
CREATE INDEX "check_violations_owner_user_id_idx" ON "check_violations"("owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "check_violations_check_rule_result_id_ordinal_key" ON "check_violations"("check_rule_result_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "check_reports_check_run_id_key" ON "check_reports"("check_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "check_reports_artifact_object_key_key" ON "check_reports"("artifact_object_key");

-- CreateIndex
CREATE INDEX "check_reports_owner_user_id_created_at_idx" ON "check_reports"("owner_user_id", "created_at");

-- CreateIndex
CREATE INDEX "check_reports_check_id_idx" ON "check_reports"("check_id");

-- AddForeignKey
ALTER TABLE "document_checks" ADD CONSTRAINT "document_checks_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_checks" ADD CONSTRAINT "document_checks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_checks" ADD CONSTRAINT "document_checks_document_version_id_fkey" FOREIGN KEY ("document_version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_checks" ADD CONSTRAINT "document_checks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_checks" ADD CONSTRAINT "document_checks_standard_version_id_fkey" FOREIGN KEY ("standard_version_id") REFERENCES "standard_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_checks" ADD CONSTRAINT "document_checks_document_analysis_id_fkey" FOREIGN KEY ("document_analysis_id") REFERENCES "document_analyses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_check_id_fkey" FOREIGN KEY ("check_id") REFERENCES "document_checks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_document_analysis_id_fkey" FOREIGN KEY ("document_analysis_id") REFERENCES "document_analyses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_rule_results" ADD CONSTRAINT "check_rule_results_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_rule_results" ADD CONSTRAINT "check_rule_results_check_run_id_fkey" FOREIGN KEY ("check_run_id") REFERENCES "check_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_violations" ADD CONSTRAINT "check_violations_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_violations" ADD CONSTRAINT "check_violations_check_rule_result_id_fkey" FOREIGN KEY ("check_rule_result_id") REFERENCES "check_rule_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_reports" ADD CONSTRAINT "check_reports_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_reports" ADD CONSTRAINT "check_reports_check_id_fkey" FOREIGN KEY ("check_id") REFERENCES "document_checks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "check_reports" ADD CONSTRAINT "check_reports_check_run_id_fkey" FOREIGN KEY ("check_run_id") REFERENCES "check_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- =============================================================================
-- 4. Composite ownership
--
--    The Phase 5 defence, extended: a check cannot be attached to another
--    user's document version, and a run, result, violation or report cannot be
--    attached to another user's check. Row-level security is the policy; these
--    keys are the structure that makes a violation impossible rather than
--    merely denied.
-- =============================================================================
CREATE UNIQUE INDEX "document_checks_id_owner_key"
    ON "document_checks"("id", "owner_user_id");
CREATE UNIQUE INDEX "check_runs_id_owner_key"
    ON "check_runs"("id", "owner_user_id");
CREATE UNIQUE INDEX "check_rule_results_id_owner_key"
    ON "check_rule_results"("id", "owner_user_id");

ALTER TABLE "document_checks"
    ADD CONSTRAINT "document_checks_version_owner_fkey"
    FOREIGN KEY ("document_version_id", "owner_user_id")
    REFERENCES "document_versions"("id", "owner_user_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "check_runs"
    ADD CONSTRAINT "check_runs_check_owner_fkey"
    FOREIGN KEY ("check_id", "owner_user_id")
    REFERENCES "document_checks"("id", "owner_user_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "check_rule_results"
    ADD CONSTRAINT "check_rule_results_run_owner_fkey"
    FOREIGN KEY ("check_run_id", "owner_user_id")
    REFERENCES "check_runs"("id", "owner_user_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "check_violations"
    ADD CONSTRAINT "check_violations_result_owner_fkey"
    FOREIGN KEY ("check_rule_result_id", "owner_user_id")
    REFERENCES "check_rule_results"("id", "owner_user_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "check_reports"
    ADD CONSTRAINT "check_reports_check_owner_fkey"
    FOREIGN KEY ("check_id", "owner_user_id")
    REFERENCES "document_checks"("id", "owner_user_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "check_reports"
    ADD CONSTRAINT "check_reports_run_owner_fkey"
    FOREIGN KEY ("check_run_id", "owner_user_id")
    REFERENCES "check_runs"("id", "owner_user_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- 5. Invariants
-- =============================================================================
ALTER TABLE "document_checks"
    ADD CONSTRAINT "document_checks_hashes_format"
    CHECK (
        "document_sha256" ~ '^[0-9a-f]{64}$'
        AND "standard_content_hash" ~ '^sha256:[0-9a-f]{64}$'
    );

-- A completed check has a run and a completion time; a failed one has a reason.
ALTER TABLE "document_checks"
    ADD CONSTRAINT "document_checks_completed_identity"
    CHECK (
        "status" <> 'COMPLETED'
        OR ("current_run_id" IS NOT NULL AND "completed_at" IS NOT NULL)
    );

ALTER TABLE "document_checks"
    ADD CONSTRAINT "document_checks_failed_reason"
    CHECK ("status" <> 'FAILED' OR ("failure_code" IS NOT NULL AND "failed_at" IS NOT NULL));

-- A succeeded run carries everything a report is built from. Without this a
-- half-written success could be mistaken for a usable evaluation.
ALTER TABLE "check_runs"
    ADD CONSTRAINT "check_runs_succeeded_identity"
    CHECK (
        "status" <> 'SUCCEEDED'
        OR (
            "determination" IS NOT NULL
            AND "evaluation_hash" IS NOT NULL
            AND "document_analysis_id" IS NOT NULL
            AND "analysis_artifact_sha256" IS NOT NULL
            AND "rule_engine_name" IS NOT NULL
            AND "rule_engine_version" IS NOT NULL
            AND "total_rules" IS NOT NULL
            AND "completed_at" IS NOT NULL
        )
    );

ALTER TABLE "check_runs"
    ADD CONSTRAINT "check_runs_failed_reason"
    CHECK ("status" <> 'FAILED' OR ("failure_code" IS NOT NULL AND "failed_at" IS NOT NULL));

ALTER TABLE "check_runs"
    ADD CONSTRAINT "check_runs_attempt_positive"
    CHECK ("attempt_number" >= 1);

-- Score arithmetic is exact and stored as decimal strings, never floats (§12).
ALTER TABLE "check_runs"
    ADD CONSTRAINT "check_runs_score_format"
    CHECK (
        ("score_value" IS NULL OR "score_value" ~ '^[0-9]{1,3}(\.[0-9]{1,12})?$')
        AND ("score_coverage" IS NULL OR "score_coverage" ~ '^[01](\.[0-9]{1,12})?$')
        AND ("evaluation_hash" IS NULL OR "evaluation_hash" ~ '^[0-9a-f]{64}$')
    );

ALTER TABLE "check_rule_results"
    ADD CONSTRAINT "check_rule_results_counts_non_negative"
    CHECK (
        "matched_fact_count" >= 0 AND "evaluated_fact_count" >= 0
        AND "passed_fact_count" >= 0 AND "failed_fact_count" >= 0
        AND "indeterminate_fact_count" >= 0
        AND "total_violation_count" >= 0 AND "returned_violation_count" >= 0
        -- Truncation is what makes these differ; the stored list may be
        -- smaller than the truth but never larger (§39).
        AND "returned_violation_count" <= "total_violation_count"
    );

ALTER TABLE "check_rule_results"
    ADD CONSTRAINT "check_rule_results_known_vocabulary"
    CHECK (
        "outcome" IN ('PASS', 'FAIL', 'NOT_APPLICABLE', 'INDETERMINATE', 'ERROR')
        AND "severity" IN ('INFO', 'MINOR', 'MAJOR', 'CRITICAL')
        AND "evaluation_mode" IN ('DETERMINISTIC', 'AI_ASSISTED', 'MANUAL')
        AND "evidence_level" IN ('NONE', 'DETERMINISTIC', 'AI_PROVISIONAL', 'HUMAN_CONFIRMED')
    );

ALTER TABLE "check_reports"
    ADD CONSTRAINT "check_reports_hashes_format"
    CHECK (
        "artifact_sha256" ~ '^[0-9a-f]{64}$'
        AND "report_hash" ~ '^[0-9a-f]{64}$'
        AND "evaluation_hash" ~ '^[0-9a-f]{64}$'
        AND "artifact_size_bytes" > 0
    );

-- =============================================================================
-- 6. Immutability and lifecycle
--
--    A completed check is historical evidence. The trigger, not the service,
--    is what makes that true: the request role cannot drop it, so a defect in
--    application code becomes an error rather than a rewritten verdict that a
--    Phase 15 certificate still points at.
-- =============================================================================
CREATE OR REPLACE FUNCTION document_checks_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    allowed boolean;
BEGIN
    IF NEW."id" <> OLD."id"
       OR NEW."owner_user_id" <> OLD."owner_user_id"
       OR NEW."document_version_id" <> OLD."document_version_id"
       OR NEW."standard_version_id" <> OLD."standard_version_id"
       OR NEW."document_sha256" <> OLD."document_sha256"
       OR NEW."standard_content_hash" <> OLD."standard_content_hash" THEN
        RAISE EXCEPTION 'document_check % bindings are immutable', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF OLD."status" = 'COMPLETED' AND NEW."status" <> 'COMPLETED' THEN
        RAISE EXCEPTION 'document_check % has completed and cannot change', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF NEW."status" <> OLD."status" THEN
        allowed := CASE OLD."status"
            WHEN 'CREATED'          THEN NEW."status" IN ('WAITING_ANALYSIS', 'EVALUATING', 'FAILED', 'CANCELLED')
            WHEN 'WAITING_ANALYSIS' THEN NEW."status" IN ('EVALUATING', 'FAILED', 'CANCELLED')
            WHEN 'EVALUATING'       THEN NEW."status" IN ('GENERATING_REPORT', 'WAITING_ANALYSIS', 'FAILED', 'CANCELLED')
            WHEN 'GENERATING_REPORT' THEN NEW."status" IN ('COMPLETED', 'EVALUATING', 'FAILED')
            -- A retry restarts processing; the failed run stays as it is.
            WHEN 'FAILED'           THEN NEW."status" IN ('WAITING_ANALYSIS', 'EVALUATING')
            ELSE false
        END;
        IF NOT allowed THEN
            RAISE EXCEPTION 'document_check % cannot move from % to %',
                OLD."id", OLD."status", NEW."status"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER document_checks_guard
    BEFORE UPDATE ON "document_checks"
    FOR EACH ROW EXECUTE FUNCTION document_checks_guard();

CREATE OR REPLACE FUNCTION check_runs_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    allowed boolean;
BEGIN
    IF NEW."id" <> OLD."id"
       OR NEW."owner_user_id" <> OLD."owner_user_id"
       OR NEW."check_id" <> OLD."check_id"
       OR NEW."attempt_number" <> OLD."attempt_number" THEN
        RAISE EXCEPTION 'check_run % identity is immutable', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- A succeeded run is the evidence behind a report. An engine upgrade
    -- produces another run; it never rewrites this one (§37).
    IF OLD."status" = 'SUCCEEDED' THEN
        RAISE EXCEPTION 'check_run % has succeeded and is immutable', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF NEW."status" <> OLD."status" THEN
        allowed := CASE OLD."status"
            WHEN 'PENDING' THEN NEW."status" IN ('RUNNING', 'FAILED')
            WHEN 'RUNNING' THEN NEW."status" IN ('SUCCEEDED', 'FAILED')
            ELSE false
        END;
        IF NOT allowed THEN
            RAISE EXCEPTION 'check_run % cannot move from % to %',
                OLD."id", OLD."status", NEW."status"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER check_runs_guard
    BEFORE UPDATE ON "check_runs"
    FOR EACH ROW EXECUTE FUNCTION check_runs_guard();

-- Rule results, violations and reports are written once, inside the run's
-- finalizing transaction, and never updated afterwards (§37).
CREATE OR REPLACE FUNCTION check_evidence_is_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% rows are immutable once written', TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER check_rule_results_append_only
    BEFORE UPDATE ON "check_rule_results"
    FOR EACH ROW EXECUTE FUNCTION check_evidence_is_append_only();

CREATE TRIGGER check_violations_append_only
    BEFORE UPDATE ON "check_violations"
    FOR EACH ROW EXECUTE FUNCTION check_evidence_is_append_only();

CREATE TRIGGER check_reports_append_only
    BEFORE UPDATE ON "check_reports"
    FOR EACH ROW EXECUTE FUNCTION check_evidence_is_append_only();

-- =============================================================================
-- 7. The public checkable-standard catalogue
--
--    A student is not a member of the university whose standard they want to
--    check against, so the Phase 2 tenant policies correctly hide it from
--    them. The wrong fix is to loosen those policies; the right one is a
--    narrow, explicitly reviewed read path that exposes only catalogue fields
--    (§19, §20, ADR-0046).
--
--    Each function is SECURITY DEFINER with a fixed search_path, typed
--    parameters, no dynamic SQL and a minimal column list. Together the
--    WHERE clauses are the authorization boundary, so they are tested as one
--    (§21, §100).
--
--    The eligibility rules, in one place:
--      organization ACTIVE and VERIFIED
--      document type ACTIVE
--      standard ACTIVE and PUBLIC_CHECKABLE
--      a PUBLISHED version exists
-- =============================================================================

CREATE OR REPLACE FUNCTION app_catalogue_organizations()
RETURNS TABLE (
    "organization_id" uuid,
    "display_name" text,
    "slug" text,
    "verification_status" text,
    "standard_count" bigint
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT o."id",
           o."display_name",
           o."slug",
           o."verification_status"::text,
           count(DISTINCT s."id")
    FROM "organizations" o
    JOIN "standards" s ON s."organization_id" = o."id"
    JOIN "document_types" dt ON dt."id" = s."document_type_id"
    JOIN "standard_versions" sv ON sv."standard_id" = s."id"
    WHERE o."status" = 'ACTIVE'
      AND o."verification_status" = 'VERIFIED'
      AND dt."status" = 'ACTIVE'
      AND s."status" = 'ACTIVE'
      AND s."check_availability" = 'PUBLIC_CHECKABLE'
      AND sv."status" = 'PUBLISHED'
    GROUP BY o."id", o."display_name", o."slug", o."verification_status"
    ORDER BY o."display_name", o."id";
$$;

CREATE OR REPLACE FUNCTION app_catalogue_document_types(p_organization_id uuid)
RETURNS TABLE (
    "document_type_id" uuid,
    "organization_id" uuid,
    "name" text,
    "name_ar" text,
    "system_category" text,
    "standard_count" bigint
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT dt."id",
           dt."organization_id",
           dt."name",
           dt."name_ar",
           dt."system_category"::text,
           count(DISTINCT s."id")
    FROM "document_types" dt
    JOIN "organizations" o ON o."id" = dt."organization_id"
    JOIN "standards" s ON s."document_type_id" = dt."id"
    JOIN "standard_versions" sv ON sv."standard_id" = s."id"
    WHERE dt."organization_id" = p_organization_id
      AND o."status" = 'ACTIVE'
      AND o."verification_status" = 'VERIFIED'
      AND dt."status" = 'ACTIVE'
      AND s."status" = 'ACTIVE'
      AND s."check_availability" = 'PUBLIC_CHECKABLE'
      AND sv."status" = 'PUBLISHED'
    GROUP BY dt."id", dt."organization_id", dt."name", dt."name_ar", dt."system_category"
    ORDER BY dt."name", dt."id";
$$;

CREATE OR REPLACE FUNCTION app_catalogue_standards(p_document_type_id uuid)
RETURNS TABLE (
    "standard_id" uuid,
    "organization_id" uuid,
    "organization_name" text,
    "document_type_id" uuid,
    "document_type_name" text,
    "code" text,
    "name_en" text,
    "name_ar" text,
    "description_en" text,
    "description_ar" text,
    "standard_version_id" uuid,
    "version_label" text,
    "rule_count" integer,
    "effective_from" timestamp(3)
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT s."id",
           o."id",
           o."display_name",
           dt."id",
           dt."name",
           s."code",
           s."name_en",
           s."name_ar",
           s."description_en",
           s."description_ar",
           sv."id",
           sv."version_label",
           sv."rule_count",
           sv."effective_from"
    FROM "standards" s
    JOIN "organizations" o ON o."id" = s."organization_id"
    JOIN "document_types" dt ON dt."id" = s."document_type_id"
    -- The one version a new check may bind to: the most recently published.
    JOIN LATERAL (
        SELECT v."id", v."version_label", snap."rule_count", v."effective_from"
        FROM "standard_versions" v
        LEFT JOIN "standard_version_snapshots" snap ON snap."standard_version_id" = v."id"
        WHERE v."standard_id" = s."id" AND v."status" = 'PUBLISHED'
        ORDER BY v."published_at" DESC NULLS LAST, v."created_at" DESC, v."id" DESC
        LIMIT 1
    ) sv ON true
    WHERE s."document_type_id" = p_document_type_id
      AND o."status" = 'ACTIVE'
      AND o."verification_status" = 'VERIFIED'
      AND dt."status" = 'ACTIVE'
      AND s."status" = 'ACTIVE'
      AND s."check_availability" = 'PUBLIC_CHECKABLE'
    ORDER BY s."name_en", s."id";
$$;

-- One standard by id, used when a check is created. Returns a row only while
-- the standard is genuinely checkable, so creation and catalogue listing can
-- never disagree about eligibility (§101).
CREATE OR REPLACE FUNCTION app_catalogue_standard(p_standard_id uuid)
RETURNS TABLE (
    "standard_id" uuid,
    "organization_id" uuid,
    "organization_name" text,
    "organization_verification" text,
    "document_type_id" uuid,
    "document_type_name" text,
    "code" text,
    "name_en" text,
    "name_ar" text,
    "description_en" text,
    "description_ar" text,
    "standard_version_id" uuid,
    "version_label" text,
    "rule_count" integer,
    "content_hash" text,
    "canonicalization_version" integer,
    "rule_schema_version" integer,
    "effective_from" timestamp(3)
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT s."id",
           o."id",
           o."display_name",
           o."verification_status"::text,
           dt."id",
           dt."name",
           s."code",
           s."name_en",
           s."name_ar",
           s."description_en",
           s."description_ar",
           sv."id",
           sv."version_label",
           sv."rule_count",
           sv."content_hash",
           sv."canonicalization_version",
           sv."rule_schema_version",
           sv."effective_from"
    FROM "standards" s
    JOIN "organizations" o ON o."id" = s."organization_id"
    JOIN "document_types" dt ON dt."id" = s."document_type_id"
    JOIN LATERAL (
        SELECT v."id", v."version_label", snap."rule_count", v."content_hash",
               v."canonicalization_version", v."rule_schema_version", v."effective_from"
        FROM "standard_versions" v
        LEFT JOIN "standard_version_snapshots" snap ON snap."standard_version_id" = v."id"
        WHERE v."standard_id" = s."id" AND v."status" = 'PUBLISHED'
        ORDER BY v."published_at" DESC NULLS LAST, v."created_at" DESC, v."id" DESC
        LIMIT 1
    ) sv ON true
    WHERE s."id" = p_standard_id
      AND o."status" = 'ACTIVE'
      AND o."verification_status" = 'VERIFIED'
      AND dt."status" = 'ACTIVE'
      AND s."status" = 'ACTIVE'
      AND s."check_availability" = 'PUBLIC_CHECKABLE';
$$;

-- The immutable published snapshot for a version a check already captured.
--
-- Deliberately keyed on the *version* and not the standard: a check that
-- captured a version keeps evaluating against it even after the standard is
-- made private or archived (§24, §102). Eligibility was decided at creation;
-- re-deciding it here would silently break running checks.
CREATE OR REPLACE FUNCTION app_check_standard_snapshot(p_standard_version_id uuid)
RETURNS TABLE (
    "standard_version_id" uuid,
    "canonical" jsonb,
    "content_hash" text,
    "canonicalization_version" integer,
    "rule_schema_version" integer,
    "rule_count" integer
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT snap."standard_version_id",
           snap."canonical",
           snap."content_hash",
           snap."canonicalization_version",
           snap."rule_schema_version",
           snap."rule_count"
    FROM "standard_version_snapshots" snap
    JOIN "standard_versions" sv ON sv."id" = snap."standard_version_id"
    WHERE snap."standard_version_id" = p_standard_version_id
      -- A draft has no snapshot worth evaluating; only a version that reached
      -- PUBLISHED (and may since have been archived) does.
      AND sv."status" IN ('PUBLISHED', 'ARCHIVED');
$$;


-- The identity a report needs for a version the check already captured.
--
-- Separate from the snapshot function because a report must render for ever
-- without reading the owning organization's private tables, and because it is
-- keyed on the version rather than the standard: a standard made private after
-- a check completed must not erase the report that already cites it (§46, §52).
-- Public catalogue fields only; nothing an organization would consider internal.
CREATE OR REPLACE FUNCTION app_check_standard_identity(p_standard_version_id uuid)
RETURNS TABLE (
    "organization_id" uuid,
    "organization_name" text,
    "organization_verification" text,
    "document_type_id" uuid,
    "document_type_name" text,
    "standard_id" uuid,
    "standard_code" text,
    "standard_name_en" text,
    "standard_name_ar" text,
    "standard_version_id" uuid,
    "version_label" text,
    "content_hash" text,
    "canonicalization_version" integer,
    "rule_schema_version" integer
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT o."id",
           o."display_name",
           o."verification_status"::text,
           dt."id",
           dt."name",
           st."id",
           st."code",
           st."name_en",
           st."name_ar",
           sv."id",
           sv."version_label",
           snap."content_hash",
           snap."canonicalization_version",
           snap."rule_schema_version"
    FROM "standard_versions" sv
    JOIN "standards" st ON st."id" = sv."standard_id"
    JOIN "organizations" o ON o."id" = st."organization_id"
    JOIN "document_types" dt ON dt."id" = st."document_type_id"
    JOIN "standard_version_snapshots" snap ON snap."standard_version_id" = sv."id"
    WHERE sv."id" = p_standard_version_id
      AND sv."status" IN ('PUBLISHED', 'ARCHIVED');
$$;

-- The functions are owned by the schema owner and executable by the request
-- role. Nothing else is granted: the request role still cannot read the
-- underlying tenant tables (§19).
REVOKE ALL ON FUNCTION app_catalogue_organizations() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_catalogue_document_types(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_catalogue_standards(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_catalogue_standard(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_check_standard_snapshot(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_check_standard_identity(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_catalogue_organizations() TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_catalogue_document_types(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_catalogue_standards(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_catalogue_standard(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_check_standard_snapshot(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_check_standard_identity(uuid) TO "palcert_app";

-- =============================================================================
-- 8. Isolation classification
--
--    Every private table registered, so the Phase 2 catalogue-driven coverage
--    test fails if one is ever added without a policy (§110, §111).
-- =============================================================================
INSERT INTO "table_isolation_classification" ("table_name", "classification", "tenant_column", "notes")
VALUES
    ('document_checks',    'USER_SCOPED', 'owner_user_id', 'A user''s check of their own document. References an organization''s standard without granting that organization any access.'),
    ('check_runs',         'USER_SCOPED', 'owner_user_id', 'One technical evaluation attempt for a user''s check.'),
    ('check_rule_results', 'USER_SCOPED', 'owner_user_id', 'Per-rule outcomes for a user''s check run. Immutable once written.'),
    ('check_violations',   'USER_SCOPED', 'owner_user_id', 'Location-level evidence for a user''s rule result. Immutable once written.'),
    ('check_reports',      'USER_SCOPED', 'owner_user_id', 'Metadata and integrity for a user''s immutable machine report.');

-- =============================================================================
-- 9. Row-level security
-- =============================================================================
ALTER TABLE "document_checks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_checks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "document_checks_owner" ON "document_checks" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "check_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "check_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "check_runs_owner" ON "check_runs" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "check_rule_results" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "check_rule_results" FORCE ROW LEVEL SECURITY;
CREATE POLICY "check_rule_results_owner" ON "check_rule_results" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "check_violations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "check_violations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "check_violations_owner" ON "check_violations" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "check_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "check_reports" FORCE ROW LEVEL SECURITY;
CREATE POLICY "check_reports_owner" ON "check_reports" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

-- =============================================================================
-- 10. Permissions
-- =============================================================================
INSERT INTO "permissions" ("id", "code", "description") VALUES
    (gen_random_uuid(), 'check:read:self',   'List and read your own document checks and reports'),
    (gen_random_uuid(), 'check:create:self', 'Start a check of your own document'),
    (gen_random_uuid(), 'standard:check-availability:manage',
     'Expose a standard to people outside the organization')
ON CONFLICT ("code") DO NOTHING;

-- Self-service check permissions go to every role that already carries the
-- self-service baseline, exactly as the Phase 5 document permissions did.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT rp."role_id", p."id"
FROM "role_permissions" rp
JOIN "permissions" baseline ON baseline."id" = rp."permission_id" AND baseline."code" = 'profile:read:self'
CROSS JOIN "permissions" p
WHERE p."code" IN ('check:read:self', 'check:create:self')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- Exposing a standard publicly is an organization act, so it goes to the roles
-- that already administer the organization — not to every rule editor (§17).
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT rp."role_id", p."id"
FROM "role_permissions" rp
JOIN "permissions" baseline ON baseline."id" = rp."permission_id"
    AND baseline."code" = 'organization:profile:update'
CROSS JOIN "permissions" p
WHERE p."code" = 'standard:check-availability:manage'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- =============================================================================
-- 11. Grants
-- =============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON "document_checks" TO "palcert_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "check_runs" TO "palcert_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "check_rule_results" TO "palcert_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "check_violations" TO "palcert_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "check_reports" TO "palcert_app";
