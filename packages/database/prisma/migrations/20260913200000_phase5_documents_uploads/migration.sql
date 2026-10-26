-- ===========================================================================
-- Phase 5 — Documents, versions, uploads, processing jobs and retention locks
--
-- Documents are USER-PRIVATE (ADR-0031). A person uploads a thesis to check it
-- privately; the university learns nothing until a future, explicit Submission
-- grants access. So nothing here carries organization_id, and every row is
-- confined to its owner by row-level security on owner_user_id — the same
-- mechanism Phase 2 uses for tenants, pointed at a user instead.
--
-- A DocumentVersion is immutable content: once PalCert has measured the bytes
-- (SHA-256, size, format) and promoted them to clean storage, those columns
-- are frozen by trigger. The workflow columns (status, timestamps, codes)
-- keep changing; the identity never does (ADR-0038).
--
-- As with Phase 3, `prisma migrate diff` regenerates DROP statements for the
-- composite foreign keys and the classification catalogue it cannot model.
-- Those were removed from section 0; nothing in this migration drops anything.
-- ===========================================================================

-- ===========================================================================
-- 0. Generated DDL
-- ===========================================================================

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('ACTIVE', 'DELETED');

-- CreateEnum
CREATE TYPE "DocumentVersionStatus" AS ENUM ('AWAITING_UPLOAD', 'UPLOADED', 'VALIDATING', 'SCANNING', 'READY', 'REJECTED', 'FAILED', 'UPLOAD_EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DocumentFormat" AS ENUM ('DOCX', 'PDF');

-- CreateEnum
CREATE TYPE "UploadSessionStatus" AS ENUM ('CREATED', 'FINALIZED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProcessingJobType" AS ENUM ('DOCUMENT_INGEST', 'DOCUMENT_PURGE');

-- CreateEnum
CREATE TYPE "ProcessingJobStatus" AS ENUM ('PENDING', 'DISPATCHED', 'RUNNING', 'SUCCEEDED', 'RETRY_PENDING', 'DEAD');

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "purged_at" TIMESTAMP(3),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "status" "DocumentVersionStatus" NOT NULL DEFAULT 'AWAITING_UPLOAD',
    "original_filename" TEXT NOT NULL,
    "declared_mime_type" TEXT,
    "expected_format" "DocumentFormat" NOT NULL,
    "detected_format" "DocumentFormat",
    "detected_mime_type" TEXT,
    "declared_size_bytes" INTEGER NOT NULL,
    "size_bytes" INTEGER,
    "sha256" TEXT,
    "client_sha256" TEXT,
    "quarantine_object_key" TEXT NOT NULL,
    "quarantine_object_version_id" TEXT,
    "quarantine_object_etag" TEXT,
    "quarantine_deleted_at" TIMESTAMP(3),
    "clean_object_key" TEXT,
    "clean_object_version_id" TEXT,
    "clean_object_etag" TEXT,
    "purged_at" TIMESTAMP(3),
    "rejection_code" TEXT,
    "failure_code" TEXT,
    "failure_detail" TEXT,
    "scan_engine" TEXT,
    "scan_signature" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "uploaded_at" TIMESTAMP(3),
    "validated_at" TIMESTAMP(3),
    "scanned_at" TIMESTAMP(3),
    "ready_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_sessions" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "document_version_id" UUID NOT NULL,
    "status" "UploadSessionStatus" NOT NULL DEFAULT 'CREATED',
    "storage_key" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "declared_size_bytes" INTEGER NOT NULL,
    "declared_mime_type" TEXT,
    "client_sha256" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "finalized_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "expired_at" TIMESTAMP(3),

    CONSTRAINT "upload_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_jobs" (
    "id" UUID NOT NULL,
    "job_type" "ProcessingJobType" NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" "ProcessingJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "lease_expires_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "dead_at" TIMESTAMP(3),
    "last_failure_code" TEXT,
    "last_failure_message" TEXT,
    "worker_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "processing_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_retention_locks" (
    "id" UUID NOT NULL,
    "document_version_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "lock_type" TEXT NOT NULL,
    "reference" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_retention_locks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "documents_owner_user_id_status_updated_at_idx" ON "documents"("owner_user_id", "status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_clean_object_key_key" ON "document_versions"("clean_object_key");

-- CreateIndex
CREATE INDEX "document_versions_owner_user_id_status_idx" ON "document_versions"("owner_user_id", "status");

-- CreateIndex
CREATE INDEX "document_versions_status_updated_at_idx" ON "document_versions"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_document_id_version_number_key" ON "document_versions"("document_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "upload_sessions_document_version_id_key" ON "upload_sessions"("document_version_id");

-- CreateIndex
CREATE INDEX "upload_sessions_status_expires_at_idx" ON "upload_sessions"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "upload_sessions_owner_user_id_idempotency_key_key" ON "upload_sessions"("owner_user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "processing_jobs_idempotency_key_key" ON "processing_jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "processing_jobs_status_available_at_idx" ON "processing_jobs"("status", "available_at");

-- CreateIndex
CREATE INDEX "processing_jobs_resource_type_resource_id_idx" ON "processing_jobs"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "document_retention_locks_document_version_id_idx" ON "document_retention_locks"("document_version_id");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_document_version_id_fkey" FOREIGN KEY ("document_version_id") REFERENCES "document_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_retention_locks" ADD CONSTRAINT "document_retention_locks_document_version_id_fkey" FOREIGN KEY ("document_version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_retention_locks" ADD CONSTRAINT "document_retention_locks_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- 1. Composite ownership keys
--
--    A version's owner is its document's owner, a session's owner is its
--    version's owner, and a retention lock's owner is its version's owner —
--    as a matter of *schema*, not of controller discipline. A row that says
--    "document A, owner B" cannot be inserted, so an application bug cannot
--    quietly hand one person's file to another's account (§49).
-- ===========================================================================
ALTER TABLE "documents"
    ADD CONSTRAINT "documents_id_owner_key" UNIQUE ("id", "owner_user_id");

ALTER TABLE "document_versions"
    ADD CONSTRAINT "document_versions_id_owner_key" UNIQUE ("id", "owner_user_id");

ALTER TABLE "document_versions"
    ADD CONSTRAINT "document_versions_document_owner_fkey"
    FOREIGN KEY ("document_id", "owner_user_id")
    REFERENCES "documents" ("id", "owner_user_id") ON DELETE CASCADE;

ALTER TABLE "upload_sessions"
    ADD CONSTRAINT "upload_sessions_document_owner_fkey"
    FOREIGN KEY ("document_id", "owner_user_id")
    REFERENCES "documents" ("id", "owner_user_id") ON DELETE CASCADE;

ALTER TABLE "upload_sessions"
    ADD CONSTRAINT "upload_sessions_version_owner_fkey"
    FOREIGN KEY ("document_version_id", "owner_user_id")
    REFERENCES "document_versions" ("id", "owner_user_id") ON DELETE CASCADE;

ALTER TABLE "document_retention_locks"
    ADD CONSTRAINT "document_retention_locks_version_owner_fkey"
    FOREIGN KEY ("document_version_id", "owner_user_id")
    REFERENCES "document_versions" ("id", "owner_user_id") ON DELETE RESTRICT;

-- ===========================================================================
-- 2. Check constraints
--
--    The invariants a row must satisfy at rest. Each is also enforced by the
--    application; here they are what stops a bug from persisting nonsense
--    such as a READY version with no hash.
-- ===========================================================================
ALTER TABLE "documents"
    ADD CONSTRAINT "documents_display_name_length"
    CHECK (char_length("display_name") BETWEEN 1 AND 200);

ALTER TABLE "documents"
    ADD CONSTRAINT "documents_deleted_consistency"
    CHECK (("status" = 'DELETED') = ("deleted_at" IS NOT NULL));

ALTER TABLE "document_versions"
    ADD CONSTRAINT "document_versions_number_positive" CHECK ("version_number" >= 1);

ALTER TABLE "document_versions"
    ADD CONSTRAINT "document_versions_sizes_non_negative"
    CHECK ("declared_size_bytes" >= 0 AND ("size_bytes" IS NULL OR "size_bytes" >= 0));

ALTER TABLE "document_versions"
    ADD CONSTRAINT "document_versions_sha256_format"
    CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$');

ALTER TABLE "document_versions"
    ADD CONSTRAINT "document_versions_client_sha256_format"
    CHECK ("client_sha256" IS NULL OR "client_sha256" ~ '^[0-9a-f]{64}$');

ALTER TABLE "document_versions"
    ADD CONSTRAINT "document_versions_rejection_code_known"
    CHECK ("rejection_code" IS NULL OR "rejection_code" IN (
        'FILE_EXTENSION_UNSUPPORTED', 'FILE_TYPE_UNSUPPORTED', 'FILE_TYPE_MISMATCH',
        'FILE_TOO_LARGE', 'FILE_EMPTY', 'FILE_CONTAINER_INVALID', 'FILE_ARCHIVE_UNSAFE',
        'FILE_MACRO_UNSUPPORTED', 'FILE_EMBEDDED_OBJECT_UNSUPPORTED',
        'FILE_EXTERNAL_CONTENT_UNSUPPORTED', 'FILE_MALWARE_DETECTED', 'FILE_CHECKSUM_MISMATCH'
    ));

ALTER TABLE "document_versions"
    ADD CONSTRAINT "document_versions_failure_code_known"
    CHECK ("failure_code" IS NULL OR "failure_code" IN (
        'SCANNER_UNAVAILABLE', 'STORAGE_UNAVAILABLE', 'QUARANTINE_OBJECT_MISSING',
        'QUARANTINE_OBJECT_CHANGED', 'PROCESSING_TIMEOUT', 'WORKER_ERROR'
    ));

-- A version is READY only with its whole identity present. Nothing downloads,
-- and nothing later binds a report or certificate, to a version without a hash.
ALTER TABLE "document_versions"
    ADD CONSTRAINT "document_versions_ready_identity"
    CHECK ("status" <> 'READY' OR (
        "sha256" IS NOT NULL AND "size_bytes" IS NOT NULL AND "detected_format" IS NOT NULL
        AND "clean_object_key" IS NOT NULL AND "ready_at" IS NOT NULL AND "uploaded_at" IS NOT NULL
    ));

ALTER TABLE "document_versions"
    ADD CONSTRAINT "document_versions_rejected_reason"
    CHECK ("status" <> 'REJECTED' OR ("rejection_code" IS NOT NULL AND "rejected_at" IS NOT NULL));

ALTER TABLE "document_versions"
    ADD CONSTRAINT "document_versions_failed_reason"
    CHECK ("status" <> 'FAILED' OR ("failure_code" IS NOT NULL AND "failed_at" IS NOT NULL));

-- Clean storage holds only what passed. A clean key on anything but a READY
-- version would be a scanned-and-approved object for content that was not.
ALTER TABLE "document_versions"
    ADD CONSTRAINT "document_versions_clean_requires_ready"
    CHECK ("clean_object_key" IS NULL OR "status" = 'READY');

ALTER TABLE "document_versions"
    ADD CONSTRAINT "document_versions_finalized_has_upload_time"
    CHECK ("status" IN ('AWAITING_UPLOAD', 'UPLOAD_EXPIRED', 'CANCELLED') OR "uploaded_at" IS NOT NULL);

ALTER TABLE "upload_sessions"
    ADD CONSTRAINT "upload_sessions_expiry_after_creation" CHECK ("expires_at" > "created_at");

ALTER TABLE "upload_sessions"
    ADD CONSTRAINT "upload_sessions_size_non_negative" CHECK ("declared_size_bytes" >= 0);

ALTER TABLE "upload_sessions"
    ADD CONSTRAINT "upload_sessions_status_timestamps"
    CHECK (
        ("status" <> 'FINALIZED' OR "finalized_at" IS NOT NULL)
        AND ("status" <> 'CANCELLED' OR "cancelled_at" IS NOT NULL)
        AND ("status" <> 'EXPIRED' OR "expired_at" IS NOT NULL)
    );

ALTER TABLE "processing_jobs"
    ADD CONSTRAINT "processing_jobs_attempts_sane"
    CHECK ("attempt_count" >= 0 AND "max_attempts" >= 1);

ALTER TABLE "processing_jobs"
    ADD CONSTRAINT "processing_jobs_resource_type_known"
    CHECK ("resource_type" IN ('DOCUMENT_VERSION', 'DOCUMENT'));

ALTER TABLE "processing_jobs"
    ADD CONSTRAINT "processing_jobs_status_timestamps"
    CHECK (
        ("status" <> 'SUCCEEDED' OR "completed_at" IS NOT NULL)
        AND ("status" <> 'DEAD' OR "dead_at" IS NOT NULL)
        AND ("status" <> 'RUNNING' OR ("started_at" IS NOT NULL AND "lease_expires_at" IS NOT NULL))
    );

ALTER TABLE "document_retention_locks"
    ADD CONSTRAINT "document_retention_locks_type_known"
    CHECK ("lock_type" IN ('CHECK', 'REPORT', 'CERTIFICATE', 'FINANCIAL_RECORD', 'SUBMISSION', 'LEGAL_HOLD'));

-- ===========================================================================
-- 3. Immutability and lifecycle triggers
--
--    Content identity is frozen once set; workflow state moves only along the
--    transitions the application defines (mirrored here verbatim from
--    @palcert/contracts DOCUMENT_VERSION_TRANSITIONS). A raw UPDATE that skips
--    the application cannot rewrite a hash, retarget a clean object, or jump a
--    version to READY.
-- ===========================================================================
CREATE OR REPLACE FUNCTION document_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    allowed boolean;
BEGIN
    -- Identity never changes.
    IF NEW."document_id" <> OLD."document_id"
       OR NEW."owner_user_id" <> OLD."owner_user_id"
       OR NEW."version_number" <> OLD."version_number"
       OR NEW."quarantine_object_key" <> OLD."quarantine_object_key"
       OR NEW."expected_format" <> OLD."expected_format"
       OR NEW."original_filename" <> OLD."original_filename"
       OR NEW."created_at" <> OLD."created_at" THEN
        RAISE EXCEPTION 'document_version % identity is immutable', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- Measured and finalized values are write-once.
    IF (OLD."sha256" IS NOT NULL AND NEW."sha256" IS DISTINCT FROM OLD."sha256")
       OR (OLD."size_bytes" IS NOT NULL AND NEW."size_bytes" IS DISTINCT FROM OLD."size_bytes")
       OR (OLD."detected_format" IS NOT NULL AND NEW."detected_format" IS DISTINCT FROM OLD."detected_format")
       OR (OLD."clean_object_key" IS NOT NULL AND NEW."clean_object_key" IS DISTINCT FROM OLD."clean_object_key")
       OR (OLD."clean_object_version_id" IS NOT NULL AND NEW."clean_object_version_id" IS DISTINCT FROM OLD."clean_object_version_id")
       OR (OLD."quarantine_object_version_id" IS NOT NULL AND NEW."quarantine_object_version_id" IS DISTINCT FROM OLD."quarantine_object_version_id") THEN
        RAISE EXCEPTION 'document_version % content identity is write-once', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- Lifecycle: only the transitions the product defines.
    IF NEW."status" <> OLD."status" THEN
        allowed := CASE OLD."status"
            WHEN 'AWAITING_UPLOAD' THEN NEW."status" IN ('UPLOADED', 'UPLOAD_EXPIRED', 'CANCELLED')
            WHEN 'UPLOADED'        THEN NEW."status" IN ('VALIDATING', 'REJECTED', 'FAILED')
            WHEN 'VALIDATING'      THEN NEW."status" IN ('SCANNING', 'REJECTED', 'FAILED')
            -- A retried attempt starts over at validation, so SCANNING may re-enter VALIDATING.
            WHEN 'SCANNING'        THEN NEW."status" IN ('VALIDATING', 'READY', 'REJECTED', 'FAILED')
            WHEN 'FAILED'          THEN NEW."status" IN ('UPLOADED')
            ELSE false
        END;
        IF NOT allowed THEN
            RAISE EXCEPTION 'document_version % cannot move from % to %', OLD."id", OLD."status", NEW."status"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "document_versions_guard"
    BEFORE UPDATE ON "document_versions"
    FOR EACH ROW EXECUTE FUNCTION document_versions_guard();

CREATE OR REPLACE FUNCTION documents_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."owner_user_id" <> OLD."owner_user_id" OR NEW."created_at" <> OLD."created_at" THEN
        RAISE EXCEPTION 'document % ownership is immutable', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- A deleted document is not restored: its objects may already be gone.
    IF OLD."status" = 'DELETED' AND NEW."status" <> 'DELETED' THEN
        RAISE EXCEPTION 'document % is deleted and cannot be restored', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "documents_guard"
    BEFORE UPDATE ON "documents"
    FOR EACH ROW EXECUTE FUNCTION documents_guard();

CREATE OR REPLACE FUNCTION upload_sessions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    allowed boolean;
BEGIN
    IF NEW."owner_user_id" <> OLD."owner_user_id"
       OR NEW."document_id" <> OLD."document_id"
       OR NEW."document_version_id" <> OLD."document_version_id"
       OR NEW."storage_key" <> OLD."storage_key"
       OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key" THEN
        RAISE EXCEPTION 'upload_session % identity is immutable', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."status" <> OLD."status" THEN
        allowed := OLD."status" = 'CREATED' AND NEW."status" IN ('FINALIZED', 'EXPIRED', 'CANCELLED');
        IF NOT allowed THEN
            RAISE EXCEPTION 'upload_session % cannot move from % to %', OLD."id", OLD."status", NEW."status"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "upload_sessions_guard"
    BEFORE UPDATE ON "upload_sessions"
    FOR EACH ROW EXECUTE FUNCTION upload_sessions_guard();

CREATE OR REPLACE FUNCTION processing_jobs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    allowed boolean;
BEGIN
    IF NEW."job_type" <> OLD."job_type"
       OR NEW."resource_type" <> OLD."resource_type"
       OR NEW."resource_id" <> OLD."resource_id"
       OR NEW."owner_user_id" <> OLD."owner_user_id"
       OR NEW."idempotency_key" <> OLD."idempotency_key" THEN
        RAISE EXCEPTION 'processing_job % identity is immutable', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."status" <> OLD."status" THEN
        allowed := CASE OLD."status"
            WHEN 'PENDING'       THEN NEW."status" IN ('DISPATCHED', 'RUNNING', 'DEAD')
            WHEN 'DISPATCHED'    THEN NEW."status" IN ('RUNNING', 'PENDING', 'DEAD')
            WHEN 'RUNNING'       THEN NEW."status" IN ('SUCCEEDED', 'RETRY_PENDING', 'DEAD', 'PENDING')
            WHEN 'RETRY_PENDING' THEN NEW."status" IN ('DISPATCHED', 'RUNNING', 'DEAD', 'PENDING')
            WHEN 'DEAD'          THEN NEW."status" IN ('PENDING')
            ELSE false
        END;
        IF NOT allowed THEN
            RAISE EXCEPTION 'processing_job % cannot move from % to %', OLD."id", OLD."status", NEW."status"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "processing_jobs_guard"
    BEFORE UPDATE ON "processing_jobs"
    FOR EACH ROW EXECUTE FUNCTION processing_jobs_guard();

-- A lock is a fact about a reference that exists; it is added or removed,
-- never edited.
CREATE OR REPLACE FUNCTION document_retention_locks_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'document_retention_locks are append-only'
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER "document_retention_locks_append_only"
    BEFORE UPDATE ON "document_retention_locks"
    FOR EACH ROW EXECUTE FUNCTION document_retention_locks_append_only();

-- ===========================================================================
-- 4. Isolation classification
--
--    USER_SCOPED with an isolation column: the coverage test requires RLS to
--    be enabled, forced and policied on every such table, exactly as it does
--    for TENANT_SCOPED tables. processing_jobs is SYSTEM: the worker must
--    load a job by id *before* it knows which user's scope to enter (§56).
-- ===========================================================================
INSERT INTO "table_isolation_classification" ("table_name", "classification", "tenant_column", "notes") VALUES
    ('documents',                'USER_SCOPED', 'owner_user_id', 'User-private (ADR-0031). RLS confines every row to its owner; never organization-owned.'),
    ('document_versions',        'USER_SCOPED', 'owner_user_id', 'Immutable uploaded content; owner carried by composite FK from documents.'),
    ('upload_sessions',          'USER_SCOPED', 'owner_user_id', 'Upload authority; expired by app_expire_upload_sessions() without a user context.'),
    ('document_retention_locks', 'USER_SCOPED', 'owner_user_id', 'Reasons a version must be kept; append-only.'),
    ('processing_jobs',          'SYSTEM',      NULL,            'Transactional outbox and job ledger. Carries only identifiers; the worker re-enters the owner scope from owner_user_id.');

-- ===========================================================================
-- 5. Row-level security
--
--    The Phase 2 mechanism, pointed at the owner. app_current_user_id() is
--    set transaction-locally by TenantPrismaService.withUser(); with no user
--    context every one of these tables reads and writes as empty.
-- ===========================================================================
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "documents_owner" ON "documents" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "document_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "document_versions_owner" ON "document_versions" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "upload_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "upload_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "upload_sessions_owner" ON "upload_sessions" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "document_retention_locks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_retention_locks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "document_retention_locks_owner" ON "document_retention_locks" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

-- ===========================================================================
-- 6. Expiry sweep, without a user context
--
--    Abandoned uploads belong to many users and must expire regardless of who
--    is logged in. Rather than granting the sweeper cross-user elevation, one
--    SECURITY DEFINER function does exactly one narrow thing: it expires
--    sessions whose deadline has passed, expires their versions, and returns
--    what the caller needs to delete the staged objects. It reads nothing
--    else and returns no document content.
-- ===========================================================================
CREATE OR REPLACE FUNCTION app_expire_upload_sessions(p_now timestamp(3), p_limit integer)
RETURNS TABLE ("session_id" uuid, "document_version_id" uuid, "owner_user_id" uuid, "storage_key" text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    RETURN QUERY
    WITH due AS (
        SELECT s."id", s."document_version_id", s."owner_user_id", s."storage_key"
        FROM "upload_sessions" s
        WHERE s."status" = 'CREATED' AND s."expires_at" <= p_now
        ORDER BY s."expires_at"
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    ),
    expired_sessions AS (
        UPDATE "upload_sessions" s
        SET "status" = 'EXPIRED', "expired_at" = p_now, "updated_at" = p_now
        FROM due WHERE s."id" = due."id"
        RETURNING due."id", due."document_version_id", due."owner_user_id", due."storage_key"
    ),
    expired_versions AS (
        UPDATE "document_versions" v
        SET "status" = 'UPLOAD_EXPIRED', "updated_at" = p_now
        FROM expired_sessions e
        WHERE v."id" = e."document_version_id" AND v."status" = 'AWAITING_UPLOAD'
    )
    SELECT e."id", e."document_version_id", e."owner_user_id", e."storage_key" FROM expired_sessions e;
END;
$$;

REVOKE ALL ON FUNCTION app_expire_upload_sessions(timestamp(3), integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_expire_upload_sessions(timestamp(3), integer) TO palcert_app;

-- ===========================================================================
-- 7. Permissions
--
--    Self-scoped: every person who can sign in may keep private documents.
--    Granted to exactly the roles that hold the other self-service
--    permissions, derived from the catalogue rather than re-listed.
-- ===========================================================================
INSERT INTO "permissions" ("id", "code", "description") VALUES
    (gen_random_uuid(), 'document:read:self',     'List and read your own documents and versions'),
    (gen_random_uuid(), 'document:write:self',    'Create documents and upload versions'),
    (gen_random_uuid(), 'document:download:self', 'Download your own ready document versions'),
    (gen_random_uuid(), 'document:delete:self',   'Delete your own documents');

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT DISTINCT r."id", p."id"
FROM "roles" r
JOIN "role_permissions" held ON held."role_id" = r."id"
JOIN "permissions" anchor ON anchor."id" = held."permission_id" AND anchor."code" = 'profile:read:self'
JOIN "permissions" p ON p."code" IN (
    'document:read:self', 'document:write:self', 'document:download:self', 'document:delete:self'
);

-- ===========================================================================
-- 8. Grants
--
--    Default privileges from Phase 2 already cover new tables; stated
--    explicitly so the request role's surface is legible in one place.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON
    "documents", "document_versions", "upload_sessions", "processing_jobs", "document_retention_locks"
    TO palcert_app;
GRANT EXECUTE ON FUNCTION document_versions_guard(), documents_guard(), upload_sessions_guard(),
    processing_jobs_guard(), document_retention_locks_append_only() TO palcert_app;

COMMENT ON TABLE "documents" IS
    'User-private logical documents (ADR-0031). Never organization-scoped; a future Submission grants an organization access explicitly.';
COMMENT ON TABLE "document_versions" IS
    'Immutable uploaded content. sha256, size_bytes, detected_format and the clean object are write-once (ADR-0038).';
COMMENT ON TABLE "processing_jobs" IS
    'Transactional outbox and job ledger (ADR-0036). The queue carries the row id only.';
