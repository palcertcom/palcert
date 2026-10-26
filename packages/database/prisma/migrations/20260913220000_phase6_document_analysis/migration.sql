-- =============================================================================
-- Phase 6 — DOCX document analysis
--
-- One table: document_analyses. It records that a named analyzer version,
-- reading one immutable document version, produced one immutable artifact.
--
-- Sections 1–2 are generated DDL. Sections 3 onwards are hand-written, because
-- Prisma's schema language cannot model any of them and re-emits DROPs for
-- them on every diff (see docs/architecture/development-setup.md).
-- =============================================================================

-- =============================================================================
-- 0. The ledger learns a third resource kind
--
--    Phase 5 constrained resource_type to the two kinds that existed then.
--    Widening the constraint is how a new job type joins the *same* ledger
--    rather than getting one of its own (§89).
-- =============================================================================
ALTER TABLE "processing_jobs" DROP CONSTRAINT "processing_jobs_resource_type_known";
ALTER TABLE "processing_jobs"
    ADD CONSTRAINT "processing_jobs_resource_type_known"
    CHECK ("resource_type" IN ('DOCUMENT_VERSION', 'DOCUMENT', 'DOCUMENT_ANALYSIS'));

-- =============================================================================
-- 1. Table
-- =============================================================================
CREATE TABLE "document_analyses" (
    "id" UUID NOT NULL,
    "document_version_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "analyzer_name" TEXT NOT NULL,
    "analyzer_version" TEXT NOT NULL,
    "fact_schema_version" INTEGER NOT NULL,
    "analysis_schema_version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "source_sha256" TEXT NOT NULL,
    "artifact_object_key" TEXT,
    "artifact_object_version_id" TEXT,
    "artifact_sha256" TEXT,
    "artifact_size_bytes" INTEGER,
    "fact_count" INTEGER,
    "warning_count" INTEGER,
    "warning_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "summary" JSONB,
    "failure_code" TEXT,
    "failure_detail" TEXT,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_analyses_pkey" PRIMARY KEY ("id")
);

-- =============================================================================
-- 2. Indexes and foreign keys
-- =============================================================================
CREATE UNIQUE INDEX "document_analyses_artifact_object_key_key"
    ON "document_analyses"("artifact_object_key");

CREATE INDEX "document_analyses_document_version_id_status_idx"
    ON "document_analyses"("document_version_id", "status");

CREATE INDEX "document_analyses_owner_user_id_idx"
    ON "document_analyses"("owner_user_id");

ALTER TABLE "document_analyses" ADD CONSTRAINT "document_analyses_document_version_id_fkey"
    FOREIGN KEY ("document_version_id") REFERENCES "document_versions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "document_analyses" ADD CONSTRAINT "document_analyses_owner_user_id_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- 3. Composite ownership
--
--    The same defence Phase 5 uses: an analysis cannot be attached to another
--    user's document version even with a forged id, because the pair must
--    match a real (version, owner) pair. Row-level security is the policy;
--    this is the structure that makes a violation impossible rather than
--    merely denied.
-- =============================================================================
ALTER TABLE "document_analyses"
    ADD CONSTRAINT "document_analyses_version_owner_fkey"
    FOREIGN KEY ("document_version_id", "owner_user_id")
    REFERENCES "document_versions"("id", "owner_user_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================================
-- 4. One live analysis per compatibility identity (§8)
--
--    "Compatible" means the same version read by the same analyzer version
--    under the same fact schema. A partial unique index over the live states
--    makes ensureDocxAnalysis idempotent in the database rather than only in
--    application code: two concurrent callers race, one inserts, the other
--    reads the winner.
--
--    FAILED rows are deliberately outside the index. A failed analysis keeps
--    its record of what went wrong (§7) and must not block a retry.
-- =============================================================================
CREATE UNIQUE INDEX "document_analyses_compatibility_key"
    ON "document_analyses"(
        "document_version_id", "analyzer_name", "analyzer_version", "fact_schema_version"
    )
    WHERE "status" IN ('PENDING', 'RUNNING', 'SUCCEEDED');

-- =============================================================================
-- 5. Invariants
-- =============================================================================
ALTER TABLE "document_analyses"
    ADD CONSTRAINT "document_analyses_status_known"
    CHECK ("status" IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'));

-- A succeeded analysis has an artifact, a digest, a size and a fact count.
-- Without this a partially-written success could be mistaken for a usable one.
ALTER TABLE "document_analyses"
    ADD CONSTRAINT "document_analyses_succeeded_identity"
    CHECK (
        "status" <> 'SUCCEEDED'
        OR (
            "artifact_object_key" IS NOT NULL
            AND "artifact_sha256" IS NOT NULL
            AND "artifact_size_bytes" IS NOT NULL
            AND "fact_count" IS NOT NULL
            AND "completed_at" IS NOT NULL
        )
    );

ALTER TABLE "document_analyses"
    ADD CONSTRAINT "document_analyses_failed_reason"
    CHECK ("status" <> 'FAILED' OR ("failure_code" IS NOT NULL AND "failed_at" IS NOT NULL));

ALTER TABLE "document_analyses"
    ADD CONSTRAINT "document_analyses_sha256_format"
    CHECK (
        "source_sha256" ~ '^[0-9a-f]{64}$'
        AND ("artifact_sha256" IS NULL OR "artifact_sha256" ~ '^[0-9a-f]{64}$')
    );

ALTER TABLE "document_analyses"
    ADD CONSTRAINT "document_analyses_counts_non_negative"
    CHECK (
        ("fact_count" IS NULL OR "fact_count" >= 0)
        AND ("warning_count" IS NULL OR "warning_count" >= 0)
        AND ("artifact_size_bytes" IS NULL OR "artifact_size_bytes" > 0)
    );

-- =============================================================================
-- 6. Immutability and lifecycle
--
--    A successful analysis is immutable (§7). The trigger, not the service,
--    is what makes that true: the request role cannot drop it, and a defect
--    in application code becomes an error rather than a rewritten artifact
--    that some Phase 7 check still points at.
-- =============================================================================
CREATE OR REPLACE FUNCTION document_analyses_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    allowed boolean;
BEGIN
    IF NEW."id" <> OLD."id"
       OR NEW."document_version_id" <> OLD."document_version_id"
       OR NEW."owner_user_id" <> OLD."owner_user_id"
       OR NEW."analyzer_name" <> OLD."analyzer_name"
       OR NEW."analyzer_version" <> OLD."analyzer_version"
       OR NEW."fact_schema_version" <> OLD."fact_schema_version"
       OR NEW."source_sha256" <> OLD."source_sha256" THEN
        RAISE EXCEPTION 'document_analysis % identity is immutable', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- Artifact identity is write-once: it may be filled in on success and
    -- never changed afterwards.
    IF (OLD."artifact_object_key" IS NOT NULL
            AND NEW."artifact_object_key" IS DISTINCT FROM OLD."artifact_object_key")
       OR (OLD."artifact_sha256" IS NOT NULL
            AND NEW."artifact_sha256" IS DISTINCT FROM OLD."artifact_sha256")
       OR (OLD."artifact_object_version_id" IS NOT NULL
            AND NEW."artifact_object_version_id" IS DISTINCT FROM OLD."artifact_object_version_id") THEN
        RAISE EXCEPTION 'document_analysis % artifact is write-once', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF OLD."status" = 'SUCCEEDED' AND NEW."status" <> 'SUCCEEDED' THEN
        RAISE EXCEPTION 'document_analysis % has succeeded and cannot change', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF NEW."status" <> OLD."status" THEN
        allowed := CASE OLD."status"
            WHEN 'PENDING'   THEN NEW."status" IN ('RUNNING', 'FAILED')
            WHEN 'RUNNING'   THEN NEW."status" IN ('SUCCEEDED', 'FAILED')
            ELSE false
        END;
        IF NOT allowed THEN
            RAISE EXCEPTION 'document_analysis % cannot move from % to %',
                OLD."id", OLD."status", NEW."status"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER document_analyses_guard
    BEFORE UPDATE ON "document_analyses"
    FOR EACH ROW EXECUTE FUNCTION document_analyses_guard();

-- =============================================================================
-- 7. Isolation classification
--
--    USER_SCOPED, like every other document table. Organizations gain nothing
--    from a member's analysis (§92, ADR-0031); the catalogue is what the RLS
--    coverage test reads, so registering it here is what makes the guarantee
--    enforced rather than merely intended.
-- =============================================================================
INSERT INTO "table_isolation_classification" ("table_name", "classification", "tenant_column", "notes")
VALUES (
    'document_analyses',
    'USER_SCOPED',
    'owner_user_id',
    'Derived analysis of a user-private document version; inherits the source document''s privacy.'
);

-- =============================================================================
-- 8. Row-level security
-- =============================================================================
ALTER TABLE "document_analyses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_analyses" FORCE ROW LEVEL SECURITY;

CREATE POLICY "document_analyses_owner" ON "document_analyses" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

-- =============================================================================
-- 9. Grants
-- =============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON "document_analyses" TO "palcert_app";
