-- =============================================================================
-- Phase 8 — AI review, assessments, invocations and supplement
--
-- A separate, immutable AI layer beside the Phase 7 deterministic one. Nothing
-- here touches a check, a report, a rule result or a violation: the whole
-- point of the phase is that an AI opinion can be added to a compliance record
-- without being able to alter it (§9).
--
-- Sections 1-3 are generated DDL. Everything after is hand-written, because
-- Prisma's schema language cannot model it and re-emits DROPs for it on every
-- diff (docs/architecture/development-setup.md).
-- =============================================================================

-- =============================================================================
-- 1. Enums, tables, indexes, keys
-- =============================================================================
-- CreateEnum
CREATE TYPE "AIReviewStatus" AS ENUM ('CREATED', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AIAssessment" AS ENUM ('SATISFIED', 'NOT_SATISFIED', 'INSUFFICIENT_EVIDENCE');

-- CreateTable
CREATE TABLE "ai_consents" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "consent_version" TEXT NOT NULL,
    "provider_category" TEXT NOT NULL,
    "consented_at" TIMESTAMP(3) NOT NULL,
    "withdrawn_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_reviews" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "check_id" UUID NOT NULL,
    "check_run_id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "report_hash" TEXT NOT NULL,
    "evaluation_hash" TEXT NOT NULL,
    "document_version_id" UUID NOT NULL,
    "document_sha256" TEXT NOT NULL,
    "analysis_id" UUID NOT NULL,
    "analysis_artifact_sha256" TEXT NOT NULL,
    "standard_version_id" UUID NOT NULL,
    "standard_content_hash" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "configured_model" TEXT NOT NULL,
    "provider_returned_model" TEXT,
    "prompt_version" TEXT NOT NULL,
    "prompt_hash" TEXT NOT NULL,
    "context_builder_version" TEXT NOT NULL,
    "context_schema_version" INTEGER NOT NULL,
    "context_hash" TEXT,
    "rules_hash" TEXT,
    "ai_review_schema_version" INTEGER NOT NULL,
    "ai_review_canonicalization_version" INTEGER NOT NULL,
    "status" "AIReviewStatus" NOT NULL DEFAULT 'CREATED',
    "ai_review_hash" TEXT,
    "assessment_count" INTEGER,
    "human_review_required_count" INTEGER,
    "insufficient_evidence_count" INTEGER,
    "context_truncated" BOOLEAN NOT NULL DEFAULT false,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cache_read_tokens" INTEGER,
    "cache_write_tokens" INTEGER,
    "failure_kind" TEXT,
    "failure_detail" TEXT,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_invocations" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "ai_review_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "configured_model" TEXT NOT NULL,
    "provider_returned_model" TEXT,
    "prompt_version" TEXT NOT NULL,
    "prompt_hash" TEXT NOT NULL,
    "context_builder_version" TEXT NOT NULL,
    "context_hash" TEXT NOT NULL,
    "rules_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "provider_request_id" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cache_read_tokens" INTEGER,
    "cache_write_tokens" INTEGER,
    "started_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "latency_ms" INTEGER,
    "failure_kind" TEXT,
    "failure_detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_invocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_rule_assessments" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "ai_review_id" UUID NOT NULL,
    "rule_code" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "blocking" BOOLEAN NOT NULL,
    "assessment" "AIAssessment" NOT NULL,
    "reason_code" TEXT NOT NULL,
    "evidence_sufficiency" TEXT NOT NULL,
    "uncertainty_reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "evidence_node_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "explanation_en" TEXT NOT NULL,
    "explanation_ar" TEXT NOT NULL,
    "requires_human_review" BOOLEAN NOT NULL,
    "deterministic_outcome" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_rule_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_report_supplements" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "ai_review_id" UUID NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "summary_en" TEXT NOT NULL,
    "summary_ar" TEXT NOT NULL,
    "priority_recommendations" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_report_supplements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_consents_owner_user_id_key" ON "ai_consents"("owner_user_id");

-- CreateIndex
CREATE INDEX "ai_reviews_owner_user_id_created_at_id_idx" ON "ai_reviews"("owner_user_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "ai_reviews_check_id_created_at_idx" ON "ai_reviews"("check_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_reviews_status_idx" ON "ai_reviews"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ai_reviews_owner_idempotency_key" ON "ai_reviews"("owner_user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "ai_invocations_owner_user_id_idx" ON "ai_invocations"("owner_user_id");

-- CreateIndex
CREATE INDEX "ai_invocations_ai_review_id_started_at_idx" ON "ai_invocations"("ai_review_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_invocations_ai_review_id_purpose_attempt_key" ON "ai_invocations"("ai_review_id", "purpose", "attempt");

-- CreateIndex
CREATE INDEX "ai_rule_assessments_owner_user_id_idx" ON "ai_rule_assessments"("owner_user_id");

-- CreateIndex
CREATE INDEX "ai_rule_assessments_ai_review_id_assessment_idx" ON "ai_rule_assessments"("ai_review_id", "assessment");

-- CreateIndex
CREATE UNIQUE INDEX "ai_rule_assessments_ai_review_id_rule_code_key" ON "ai_rule_assessments"("ai_review_id", "rule_code");

-- CreateIndex
CREATE UNIQUE INDEX "ai_report_supplements_ai_review_id_key" ON "ai_report_supplements"("ai_review_id");

-- CreateIndex
CREATE INDEX "ai_report_supplements_owner_user_id_idx" ON "ai_report_supplements"("owner_user_id");

-- AddForeignKey
ALTER TABLE "ai_consents" ADD CONSTRAINT "ai_consents_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_reviews" ADD CONSTRAINT "ai_reviews_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_reviews" ADD CONSTRAINT "ai_reviews_check_id_fkey" FOREIGN KEY ("check_id") REFERENCES "document_checks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_reviews" ADD CONSTRAINT "ai_reviews_check_run_id_fkey" FOREIGN KEY ("check_run_id") REFERENCES "check_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_reviews" ADD CONSTRAINT "ai_reviews_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "check_reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_invocations" ADD CONSTRAINT "ai_invocations_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_invocations" ADD CONSTRAINT "ai_invocations_ai_review_id_fkey" FOREIGN KEY ("ai_review_id") REFERENCES "ai_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_rule_assessments" ADD CONSTRAINT "ai_rule_assessments_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_rule_assessments" ADD CONSTRAINT "ai_rule_assessments_ai_review_id_fkey" FOREIGN KEY ("ai_review_id") REFERENCES "ai_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_report_supplements" ADD CONSTRAINT "ai_report_supplements_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_report_supplements" ADD CONSTRAINT "ai_report_supplements_ai_review_id_fkey" FOREIGN KEY ("ai_review_id") REFERENCES "ai_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- 3b. The processing-job ledger learns about AI reviews
--
--     A fourth resource kind in the *same* ledger rather than a queue of its
--     own (§58).
-- =============================================================================
ALTER TABLE "processing_jobs" DROP CONSTRAINT "processing_jobs_resource_type_known";
ALTER TABLE "processing_jobs"
    ADD CONSTRAINT "processing_jobs_resource_type_known"
    CHECK ("resource_type" IN ('DOCUMENT_VERSION', 'DOCUMENT', 'DOCUMENT_ANALYSIS', 'CHECK_RUN', 'AI_REVIEW'));

-- =============================================================================
-- 4. Composite ownership keys
--
--    Every child row carries its owner explicitly *and* is bound to a parent
--    with the same owner, so a mislabelled row cannot exist even if service
--    code were wrong. Same construction as Phases 5-7.
-- =============================================================================
ALTER TABLE "ai_reviews" ADD CONSTRAINT "ai_reviews_owner_identity" UNIQUE ("id", "owner_user_id");
ALTER TABLE "document_checks" ADD CONSTRAINT "document_checks_ai_owner_identity" UNIQUE ("id", "owner_user_id");

ALTER TABLE "ai_reviews"
    ADD CONSTRAINT "ai_reviews_check_owner_fkey"
    FOREIGN KEY ("check_id", "owner_user_id")
    REFERENCES "document_checks" ("id", "owner_user_id") ON DELETE CASCADE;

ALTER TABLE "ai_invocations"
    ADD CONSTRAINT "ai_invocations_review_owner_fkey"
    FOREIGN KEY ("ai_review_id", "owner_user_id")
    REFERENCES "ai_reviews" ("id", "owner_user_id") ON DELETE CASCADE;

ALTER TABLE "ai_rule_assessments"
    ADD CONSTRAINT "ai_rule_assessments_review_owner_fkey"
    FOREIGN KEY ("ai_review_id", "owner_user_id")
    REFERENCES "ai_reviews" ("id", "owner_user_id") ON DELETE CASCADE;

ALTER TABLE "ai_report_supplements"
    ADD CONSTRAINT "ai_report_supplements_review_owner_fkey"
    FOREIGN KEY ("ai_review_id", "owner_user_id")
    REFERENCES "ai_reviews" ("id", "owner_user_id") ON DELETE CASCADE;

-- =============================================================================
-- 5. Invariants
--
--    The properties the phase claims, written where no service can forget them.
-- =============================================================================

-- Hashes are hashes, in the shapes the contracts define.
ALTER TABLE "ai_reviews"
    ADD CONSTRAINT "ai_reviews_hash_formats" CHECK (
        "report_hash" ~ '^[0-9a-f]{64}$'
        AND "evaluation_hash" ~ '^[0-9a-f]{64}$'
        AND "document_sha256" ~ '^[0-9a-f]{64}$'
        AND "analysis_artifact_sha256" ~ '^[0-9a-f]{64}$'
        AND "standard_content_hash" ~ '^sha256:[0-9a-f]{64}$'
        AND "prompt_hash" ~ '^[0-9a-f]{64}$'
        AND ("context_hash" IS NULL OR "context_hash" ~ '^[0-9a-f]{64}$')
        AND ("rules_hash" IS NULL OR "rules_hash" ~ '^[0-9a-f]{64}$')
        AND ("ai_review_hash" IS NULL OR "ai_review_hash" ~ '^[0-9a-f]{64}$')
    );

-- A completed review has an identity and counters; a failed one has a reason.
-- A review that is neither has no business claiming either.
ALTER TABLE "ai_reviews"
    ADD CONSTRAINT "ai_reviews_completion_identity" CHECK (
        ("status" <> 'COMPLETED')
        OR (
            "completed_at" IS NOT NULL
            AND "ai_review_hash" IS NOT NULL
            AND "context_hash" IS NOT NULL
            AND "rules_hash" IS NOT NULL
            AND "assessment_count" IS NOT NULL
            AND "failure_kind" IS NULL
        )
    );

ALTER TABLE "ai_reviews"
    ADD CONSTRAINT "ai_reviews_failure_identity" CHECK (
        ("status" <> 'FAILED') OR ("failed_at" IS NOT NULL AND "failure_kind" IS NOT NULL)
    );

-- Counters are counts, and the subsets never exceed the whole.
ALTER TABLE "ai_reviews"
    ADD CONSTRAINT "ai_reviews_counts_sane" CHECK (
        ("assessment_count" IS NULL OR "assessment_count" >= 0)
        AND ("human_review_required_count" IS NULL OR "human_review_required_count" >= 0)
        AND ("insufficient_evidence_count" IS NULL OR "insufficient_evidence_count" >= 0)
        AND ("input_tokens" IS NULL OR "input_tokens" >= 0)
        AND ("output_tokens" IS NULL OR "output_tokens" >= 0)
        AND (
            "assessment_count" IS NULL
            OR "human_review_required_count" IS NULL
            OR "human_review_required_count" <= "assessment_count"
        )
        AND (
            "assessment_count" IS NULL
            OR "insufficient_evidence_count" IS NULL
            OR "insufficient_evidence_count" <= "assessment_count"
        )
    );

-- Known vocabularies, so a typo cannot become a stored status.
ALTER TABLE "ai_reviews"
    ADD CONSTRAINT "ai_reviews_failure_kind_known" CHECK (
        "failure_kind" IS NULL OR "failure_kind" IN (
            'RATE_LIMITED', 'OVERLOADED', 'TIMEOUT', 'NETWORK', 'AUTHENTICATION',
            'INVALID_REQUEST', 'PROVIDER_REFUSAL', 'OUTPUT_INVALID',
            'MODEL_UNAVAILABLE', 'CONTEXT_TOO_LARGE', 'UNKNOWN_PROVIDER_ERROR'
        )
    );

ALTER TABLE "ai_invocations"
    ADD CONSTRAINT "ai_invocations_status_known"
    CHECK ("status" IN ('PENDING', 'SUCCEEDED', 'FAILED'));

ALTER TABLE "ai_invocations"
    ADD CONSTRAINT "ai_invocations_purpose_known"
    CHECK ("purpose" IN ('RULE_ASSESSMENT', 'REPORT_SUPPLEMENT', 'TOKEN_COUNT'));

ALTER TABLE "ai_invocations"
    ADD CONSTRAINT "ai_invocations_attempt_positive" CHECK ("attempt" >= 1);

-- THE Phase 8 invariant, in the schema rather than in a service method:
-- a blocking AI-assisted rule always requires a person, whatever the model
-- concluded. An AI provider is never given certification authority (§26).
ALTER TABLE "ai_rule_assessments"
    ADD CONSTRAINT "ai_rule_assessments_blocking_requires_human"
    CHECK (NOT "blocking" OR "requires_human_review");

ALTER TABLE "ai_rule_assessments"
    ADD CONSTRAINT "ai_rule_assessments_severity_known"
    CHECK ("severity" IN ('INFO', 'MINOR', 'MAJOR', 'CRITICAL'));

ALTER TABLE "ai_rule_assessments"
    ADD CONSTRAINT "ai_rule_assessments_sufficiency_known"
    CHECK ("evidence_sufficiency" IN ('SUFFICIENT', 'INSUFFICIENT'));

-- Bounded text, matching the shared contract. A model that returned an essay
-- must not be able to store one.
ALTER TABLE "ai_rule_assessments"
    ADD CONSTRAINT "ai_rule_assessments_text_bounded" CHECK (
        length("explanation_en") BETWEEN 1 AND 1200
        AND length("explanation_ar") BETWEEN 1 AND 1200
        AND array_length("evidence_node_ids", 1) IS NULL
        OR array_length("evidence_node_ids", 1) <= 20
    );

ALTER TABLE "ai_report_supplements"
    ADD CONSTRAINT "ai_report_supplements_text_bounded" CHECK (
        length("summary_en") BETWEEN 1 AND 2000
        AND length("summary_ar") BETWEEN 1 AND 2000
    );

-- One consent row per user, and the version is recorded so a changed notice
-- cannot silently inherit agreement given to an older one (§14).
ALTER TABLE "ai_consents"
    ADD CONSTRAINT "ai_consents_provider_category_known"
    CHECK ("provider_category" IN ('EXTERNAL_AI_PROVIDER'));

-- =============================================================================
-- 6. Immutability
--
--    A finished AI review is history, exactly as a finished report is. A
--    different model or prompt produces another review; it never edits this
--    one (§45).
-- =============================================================================
CREATE OR REPLACE FUNCTION ai_reviews_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    -- Bindings are captured once. Nothing may move a review onto different
    -- evidence after the fact (§12).
    IF NEW."owner_user_id" <> OLD."owner_user_id"
        OR NEW."check_id" <> OLD."check_id"
        OR NEW."check_run_id" <> OLD."check_run_id"
        OR NEW."report_id" <> OLD."report_id"
        OR NEW."report_hash" <> OLD."report_hash"
        OR NEW."evaluation_hash" <> OLD."evaluation_hash"
        OR NEW."document_version_id" <> OLD."document_version_id"
        OR NEW."document_sha256" <> OLD."document_sha256"
        OR NEW."analysis_id" <> OLD."analysis_id"
        OR NEW."analysis_artifact_sha256" <> OLD."analysis_artifact_sha256"
        OR NEW."standard_version_id" <> OLD."standard_version_id"
        OR NEW."standard_content_hash" <> OLD."standard_content_hash"
        OR NEW."provider" <> OLD."provider"
        OR NEW."configured_model" <> OLD."configured_model"
        OR NEW."prompt_version" <> OLD."prompt_version"
        OR NEW."prompt_hash" <> OLD."prompt_hash"
        OR NEW."context_builder_version" <> OLD."context_builder_version"
    THEN
        RAISE EXCEPTION 'ai_review % bindings are immutable', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF OLD."status" IN ('COMPLETED', 'FAILED', 'CANCELLED')
        AND NEW."status" IS DISTINCT FROM OLD."status"
    THEN
        RAISE EXCEPTION 'ai_review % cannot move from % to %', OLD."id", OLD."status", NEW."status"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF OLD."status" = 'COMPLETED' AND (
        NEW."ai_review_hash" IS DISTINCT FROM OLD."ai_review_hash"
        OR NEW."context_hash" IS DISTINCT FROM OLD."context_hash"
        OR NEW."rules_hash" IS DISTINCT FROM OLD."rules_hash"
        OR NEW."assessment_count" IS DISTINCT FROM OLD."assessment_count"
    ) THEN
        RAISE EXCEPTION 'ai_review % output is write-once', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "ai_reviews_guard"
    BEFORE UPDATE ON "ai_reviews"
    FOR EACH ROW EXECUTE FUNCTION ai_reviews_guard();

-- Assessments, invocations and the supplement are append-only. An AI opinion
-- that could be edited afterwards is not a record of what the model said.
CREATE OR REPLACE FUNCTION ai_output_is_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER "ai_rule_assessments_append_only"
    BEFORE UPDATE ON "ai_rule_assessments"
    FOR EACH ROW EXECUTE FUNCTION ai_output_is_append_only();

CREATE TRIGGER "ai_report_supplements_append_only"
    BEFORE UPDATE ON "ai_report_supplements"
    FOR EACH ROW EXECUTE FUNCTION ai_output_is_append_only();

-- An invocation may be completed once (PENDING -> terminal) and never revised.
CREATE OR REPLACE FUNCTION ai_invocations_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF OLD."status" <> 'PENDING' THEN
        RAISE EXCEPTION 'ai_invocation % is already settled', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."ai_review_id" <> OLD."ai_review_id"
        OR NEW."owner_user_id" <> OLD."owner_user_id"
        OR NEW."attempt" <> OLD."attempt"
        OR NEW."purpose" <> OLD."purpose"
        OR NEW."context_hash" <> OLD."context_hash"
        OR NEW."rules_hash" <> OLD."rules_hash"
        OR NEW."prompt_hash" <> OLD."prompt_hash"
    THEN
        RAISE EXCEPTION 'ai_invocation % identity is immutable', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ai_invocations_guard"
    BEFORE UPDATE ON "ai_invocations"
    FOR EACH ROW EXECUTE FUNCTION ai_invocations_guard();

-- =============================================================================
-- 7. Isolation classification
--
--    Every private table registered, so the Phase 2 catalogue-driven coverage
--    test fails if one is ever added without a policy (§100).
-- =============================================================================
INSERT INTO "table_isolation_classification" ("table_name", "classification", "tenant_column", "notes")
VALUES
    ('ai_consents',           'USER_SCOPED', 'owner_user_id', 'A user''s own agreement to external AI processing. An organization can never grant it on their behalf.'),
    ('ai_reviews',            'USER_SCOPED', 'owner_user_id', 'One AI review of a user''s own completed check. The organization whose standard was used has no access.'),
    ('ai_invocations',        'USER_SCOPED', 'owner_user_id', 'Provider-call metadata for a user''s AI review. Never the prompt, the response or the API key.'),
    ('ai_rule_assessments',   'USER_SCOPED', 'owner_user_id', 'Advisory per-rule AI assessments for a user''s review. Immutable once written.'),
    ('ai_report_supplements', 'USER_SCOPED', 'owner_user_id', 'The user-facing AI narrative for a user''s review. Immutable once written.');

-- =============================================================================
-- 8. Row-level security
-- =============================================================================
ALTER TABLE "ai_consents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_consents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ai_consents_owner" ON "ai_consents" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "ai_reviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_reviews" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ai_reviews_owner" ON "ai_reviews" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "ai_invocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_invocations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ai_invocations_owner" ON "ai_invocations" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "ai_rule_assessments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_rule_assessments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ai_rule_assessments_owner" ON "ai_rule_assessments" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "ai_report_supplements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_report_supplements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ai_report_supplements_owner" ON "ai_report_supplements" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

-- =============================================================================
-- 9. Permissions
--
--    Self-service only. There is deliberately no organization-scoped AI
--    permission: an institution cannot start, read or consent to an AI review
--    of somebody's private document (§61, §62, §63).
-- =============================================================================
INSERT INTO "permissions" ("id", "code", "description") VALUES
    (gen_random_uuid(), 'ai-review:read:self',   'Read your own AI reviews'),
    (gen_random_uuid(), 'ai-review:create:self', 'Start an AI review of your own check')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT rp."role_id", p."id"
FROM "role_permissions" rp
JOIN "permissions" baseline ON baseline."id" = rp."permission_id" AND baseline."code" = 'profile:read:self'
CROSS JOIN "permissions" p
WHERE p."code" IN ('ai-review:read:self', 'ai-review:create:self')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- =============================================================================
-- 10. Grants
-- =============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON
    "ai_consents", "ai_reviews", "ai_invocations", "ai_rule_assessments", "ai_report_supplements"
TO "palcert_app";
