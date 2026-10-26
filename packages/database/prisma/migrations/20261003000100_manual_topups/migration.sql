-- =============================================================================
-- Manual top-ups and human payment verification
--
-- A person sends money to a PalCert bank account or mobile wallet outside
-- PalCert, reports the transfer here, and a PalCert finance reviewer credits
-- their balance once the transfer is matched against the receiving account.
--
-- Additive in effect. Every change to an existing object either adds a new
-- object, widens a rule so that every existing row still satisfies it, or
-- adds a rule that only new kinds of row can trip. No existing row is
-- written, moved or deleted by this migration:
--
--   * five new tables, two new upload tables' worth of machinery, new enums;
--   * `credit_ledger_entries.ledger_entries_sign_matches_type` is replaced by
--     the same rule plus one new positive type — strictly wider, so every
--     existing entry satisfies it, checked as part of the replacement;
--   * `domain_events.organization_id` and `user_notifications.organization_id`
--     drop NOT NULL, and a CHECK in the same transaction confines NULL to the
--     three new platform-scoped notification types. Every existing row has an
--     organization and an older type, so every existing row passes, and no
--     existing type can ever be written without an organization;
--   * the Phase 16 audience functions gain one platform-staff branch; their
--     existing branches are reproduced unchanged.
--
--    1. Vocabulary
--    2. Payment methods
--    3. Payment method logos
--    4. Requests
--    5. Receipts
--    6. Request history
--    7. Integrity triggers
--    8. The ledger: one new credit type, confined
--    9. Row-level security, privileges, classification
--   10. Notifications — Phase 16, extended to platform-scoped events
--   11. Durable jobs
--   12. Permissions
--   13. Function privileges
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Vocabulary
-- -----------------------------------------------------------------------------
CREATE TYPE "ManualPaymentMethodType" AS ENUM ('MOBILE_WALLET', 'BANK_ACCOUNT', 'OTHER');

CREATE TYPE "ManualTopUpStatus" AS ENUM (
    'DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED');

CREATE TYPE "ManualTopUpRejectionReason" AS ENUM (
    'REFERENCE_NOT_FOUND', 'AMOUNT_MISMATCH', 'DUPLICATE_REFERENCE', 'RECEIPT_UNCLEAR',
    'PAYMENT_NOT_RECEIVED', 'INVALID_PAYMENT_METHOD', 'OTHER');

CREATE TYPE "ManualTopUpEventType" AS ENUM (
    'CREATED', 'UPDATED', 'RECEIPT_ATTACHED', 'SUBMITTED', 'REVIEW_STARTED',
    'APPROVED', 'REJECTED', 'CANCELLED');

CREATE TYPE "ManualTopUpActorSide" AS ENUM ('OWNER', 'FINANCE');

CREATE TYPE "ManualTopUpFileStatus" AS ENUM (
    'AWAITING_UPLOAD', 'UPLOADED', 'VALIDATING', 'SCANNING', 'READY',
    'REJECTED', 'FAILED', 'UPLOAD_EXPIRED');

CREATE TYPE "ManualTopUpFileFormat" AS ENUM ('PDF', 'PNG', 'JPEG', 'WEBP');

-- -----------------------------------------------------------------------------
-- 2. Payment methods — where PalCert asks people to send money
--
-- Configured by platform administrators. Never hard-deleted: a request names
-- the method it was made against, and the application role holds no DELETE.
-- Archiving is the end of a method's life, and it is permanent.
-- -----------------------------------------------------------------------------
CREATE TABLE "manual_payment_methods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(40) NOT NULL,
    "type" "ManualPaymentMethodType" NOT NULL,
    "name_en" VARCHAR(120) NOT NULL,
    "name_ar" VARCHAR(120) NOT NULL,
    "description_en" VARCHAR(500),
    "description_ar" VARCHAR(500),
    "currency" CHAR(3) NOT NULL,

    -- The destination. Which of these a method needs depends on its type.
    "recipient_name" VARCHAR(140),
    "mobile_number" VARCHAR(16),
    "iban" VARCHAR(34),
    "bank_name" VARCHAR(140),
    "account_number" VARCHAR(40),
    "branch_name" VARCHAR(140),

    "instructions_en" VARCHAR(2000),
    "instructions_ar" VARCHAR(2000),

    "min_amount_minor" BIGINT NOT NULL,
    "max_amount_minor" BIGINT NOT NULL,

    "logo_id" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    -- Optimistic concurrency: every edit is `WHERE version = <read>` and bumps it.
    "version" INTEGER NOT NULL DEFAULT 1,

    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "manual_payment_methods_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "manual_payment_methods_code_key" UNIQUE ("code"),
    CONSTRAINT "manual_payment_methods_code_shape" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,39}$'),
    CONSTRAINT "manual_payment_methods_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "manual_payment_methods_names" CHECK (
        length(btrim("name_en")) >= 1 AND length(btrim("name_ar")) >= 1),
    CONSTRAINT "manual_payment_methods_amounts" CHECK (
        "min_amount_minor" > 0
        AND "max_amount_minor" >= "min_amount_minor"
        AND "max_amount_minor" <= 1000000000000000),
    CONSTRAINT "manual_payment_methods_mobile_shape" CHECK (
        "mobile_number" IS NULL OR "mobile_number" ~ '^\+?[0-9]{7,15}$'),
    CONSTRAINT "manual_payment_methods_iban_shape" CHECK (
        "iban" IS NULL OR "iban" ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'),
    CONSTRAINT "manual_payment_methods_account_shape" CHECK (
        "account_number" IS NULL OR "account_number" ~ '^[A-Za-z0-9-]{1,40}$'),
    -- A wallet is a phone number and the name it is registered to; an account
    -- is a bank and an IBAN or account number. "Other" must at least say how.
    CONSTRAINT "manual_payment_methods_type_fields" CHECK (
        ("type" = 'MOBILE_WALLET' AND "mobile_number" IS NOT NULL AND "recipient_name" IS NOT NULL)
        OR ("type" = 'BANK_ACCOUNT' AND "bank_name" IS NOT NULL AND "recipient_name" IS NOT NULL
            AND ("iban" IS NOT NULL OR "account_number" IS NOT NULL))
        OR ("type" = 'OTHER' AND "instructions_en" IS NOT NULL AND "instructions_ar" IS NOT NULL)),
    CONSTRAINT "manual_payment_methods_archived_disabled" CHECK (
        "archived_at" IS NULL OR NOT "enabled"),
    CONSTRAINT "manual_payment_methods_display_order" CHECK ("display_order" BETWEEN 0 AND 9999),
    CONSTRAINT "manual_payment_methods_version_positive" CHECK ("version" >= 1)
);

CREATE INDEX "manual_payment_methods_catalogue_idx"
    ON "manual_payment_methods"("display_order", "code") WHERE "enabled" AND "archived_at" IS NULL;

ALTER TABLE "manual_payment_methods"
    ADD CONSTRAINT "manual_payment_methods_created_by_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
ALTER TABLE "manual_payment_methods"
    ADD CONSTRAINT "manual_payment_methods_updated_by_fkey"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- 3. Payment method logos
--
-- The same secure ingestion as every other upload — server-generated
-- quarantine key, finalize against the exact object version, signature
-- detection, malware scan, immutable promotion — and raster formats only.
-- -----------------------------------------------------------------------------
CREATE TABLE "manual_payment_method_logos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payment_method_id" UUID NOT NULL,
    "uploaded_by_user_id" UUID,
    "status" "ManualTopUpFileStatus" NOT NULL DEFAULT 'AWAITING_UPLOAD',

    "original_filename" TEXT NOT NULL,
    "declared_mime_type" TEXT,
    "expected_format" "ManualTopUpFileFormat" NOT NULL,
    "detected_format" "ManualTopUpFileFormat",
    "detected_mime_type" TEXT,

    "declared_size_bytes" INTEGER NOT NULL,
    "max_file_bytes" INTEGER NOT NULL,
    "size_bytes" INTEGER,
    "client_sha256" CHAR(64),
    "sha256" CHAR(64),

    "quarantine_object_key" TEXT NOT NULL,
    "quarantine_object_version_id" TEXT,
    "quarantine_object_etag" TEXT,
    "quarantine_deleted_at" TIMESTAMPTZ(6),

    "clean_object_key" TEXT,
    "clean_object_version_id" TEXT,
    "clean_object_etag" TEXT,

    "scan_engine" TEXT,
    "scan_signature" TEXT,
    "rejection_code" TEXT,
    "failure_code" TEXT,
    "failure_detail" TEXT,

    "idempotency_key" VARCHAR(200),
    "upload_expires_at" TIMESTAMPTZ(6) NOT NULL,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_at" TIMESTAMPTZ(6),
    "validated_at" TIMESTAMPTZ(6),
    "scanned_at" TIMESTAMPTZ(6),
    "ready_at" TIMESTAMPTZ(6),
    "rejected_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),

    CONSTRAINT "manual_payment_method_logos_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "manual_payment_method_logos_id_method_key" UNIQUE ("id", "payment_method_id"),
    CONSTRAINT "manual_payment_method_logos_clean_key" UNIQUE ("clean_object_key"),
    CONSTRAINT "manual_payment_method_logos_raster_only" CHECK (
        "expected_format" IN ('PNG', 'JPEG', 'WEBP')
        AND ("detected_format" IS NULL OR "detected_format" IN ('PNG', 'JPEG', 'WEBP'))),
    CONSTRAINT "manual_payment_method_logos_sizes" CHECK (
        "declared_size_bytes" BETWEEN 1 AND 1048576
        AND "max_file_bytes" BETWEEN 1024 AND 1048576
        AND ("size_bytes" IS NULL OR "size_bytes" BETWEEN 1 AND 1048576)),
    CONSTRAINT "manual_payment_method_logos_digest_shape" CHECK (
        ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$')
        AND ("client_sha256" IS NULL OR "client_sha256" ~ '^[0-9a-f]{64}$')),
    CONSTRAINT "manual_payment_method_logos_ready_shape" CHECK (
        "status" <> 'READY' OR ("sha256" IS NOT NULL AND "size_bytes" IS NOT NULL
            AND "detected_format" IS NOT NULL AND "detected_mime_type" IS NOT NULL
            AND "clean_object_key" IS NOT NULL AND "ready_at" IS NOT NULL)),
    CONSTRAINT "manual_payment_method_logos_filename" CHECK (
        length("original_filename") BETWEEN 1 AND 255)
);

CREATE UNIQUE INDEX "manual_payment_method_logos_uploader_idempotency"
    ON "manual_payment_method_logos"("uploaded_by_user_id", "idempotency_key");
CREATE INDEX "manual_payment_method_logos_method_idx"
    ON "manual_payment_method_logos"("payment_method_id", "created_at");

ALTER TABLE "manual_payment_method_logos"
    ADD CONSTRAINT "manual_payment_method_logos_method_fkey"
    FOREIGN KEY ("payment_method_id") REFERENCES "manual_payment_methods"("id") ON DELETE RESTRICT;
ALTER TABLE "manual_payment_method_logos"
    ADD CONSTRAINT "manual_payment_method_logos_uploader_fkey"
    FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;

-- A method's logo must be one of its own.
ALTER TABLE "manual_payment_methods"
    ADD CONSTRAINT "manual_payment_methods_logo_fkey"
    FOREIGN KEY ("logo_id", "id")
    REFERENCES "manual_payment_method_logos"("id", "payment_method_id") ON DELETE RESTRICT;

-- -----------------------------------------------------------------------------
-- 4. Requests
--
-- One person's report of one transfer. The amount is minor units as BIGINT;
-- the currency is the method's, never the client's. The snapshot freezes the
-- destination the person was shown, so editing a method later never changes
-- where a reviewer believes this person paid.
-- -----------------------------------------------------------------------------
CREATE TABLE "manual_topup_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_user_id" UUID NOT NULL,
    "payment_method_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount_minor" BIGINT,
    -- What the person typed, for display, and the form it is compared in.
    "reference_original" VARCHAR(100),
    "reference_normalized" VARCHAR(64),
    "status" "ManualTopUpStatus" NOT NULL DEFAULT 'DRAFT',
    "payment_method_snapshot" JSONB NOT NULL,
    "customer_note" VARCHAR(500),
    "receipt_id" UUID,
    "idempotency_key" VARCHAR(200),

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMPTZ(6),
    "review_started_at" TIMESTAMPTZ(6),
    "review_started_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "approved_by_user_id" UUID,
    "rejected_by_user_id" UUID,
    "rejection_reason" "ManualTopUpRejectionReason",
    "rejection_note" VARCHAR(1000),
    "cancelled_at" TIMESTAMPTZ(6),
    -- The one ledger entry an approval wrote. Write-once.
    "credit_entry_id" UUID,

    CONSTRAINT "manual_topup_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "manual_topup_requests_id_owner_key" UNIQUE ("id", "owner_user_id"),
    CONSTRAINT "manual_topup_requests_credit_entry_key" UNIQUE ("credit_entry_id"),
    CONSTRAINT "manual_topup_requests_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "manual_topup_requests_amount_bounded" CHECK (
        "amount_minor" IS NULL OR ("amount_minor" > 0 AND "amount_minor" <= 1000000000000000)),
    CONSTRAINT "manual_topup_requests_reference_shape" CHECK (
        ("reference_original" IS NULL) = ("reference_normalized" IS NULL)
        AND ("reference_normalized" IS NULL OR "reference_normalized" ~ '^[A-Z0-9]{4,64}$')),
    CONSTRAINT "manual_topup_requests_snapshot_is_object" CHECK (
        jsonb_typeof("payment_method_snapshot") = 'object'),
    -- Anything that has left DRAFT (other than by cancelling a draft) is a
    -- complete report: an amount, a reference and the time it was submitted.
    CONSTRAINT "manual_topup_requests_submitted_complete" CHECK (
        "status" = 'DRAFT'
        OR ("status" = 'CANCELLED' AND "submitted_at" IS NULL)
        OR ("amount_minor" IS NOT NULL AND "reference_normalized" IS NOT NULL
            AND "submitted_at" IS NOT NULL)),
    CONSTRAINT "manual_topup_requests_approved_shape" CHECK (
        ("status" = 'APPROVED') = ("credit_entry_id" IS NOT NULL)
        AND ("status" <> 'APPROVED' OR ("approved_by_user_id" IS NOT NULL AND "decided_at" IS NOT NULL))),
    CONSTRAINT "manual_topup_requests_rejected_shape" CHECK (
        ("status" = 'REJECTED') = ("rejection_reason" IS NOT NULL)
        AND ("status" <> 'REJECTED' OR ("rejected_by_user_id" IS NOT NULL AND "decided_at" IS NOT NULL))),
    CONSTRAINT "manual_topup_requests_cancelled_shape" CHECK (
        ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)),
    -- A request is cancelled only before anyone has started to review it.
    CONSTRAINT "manual_topup_requests_cancel_before_review" CHECK (
        "status" <> 'CANCELLED' OR "review_started_at" IS NULL),
    CONSTRAINT "manual_topup_requests_review_pair" CHECK (
        ("review_started_at" IS NULL) = ("review_started_by_user_id" IS NULL)),
    CONSTRAINT "manual_topup_requests_customer_note_bounded" CHECK (
        "customer_note" IS NULL OR length("customer_note") <= 500)
);

-- One transfer credits one balance once. Scoped to the method, because two
-- banks may issue the same reference string; scoped to the requests that are
-- still live or were credited, so a reference finance rejected (an amount
-- typed wrong, say) can be corrected and reported again, and a cancelled
-- report does not burn it. A pending or approved reference can never be
-- reported a second time, by anybody.
CREATE UNIQUE INDEX "manual_topup_requests_method_reference_key"
    ON "manual_topup_requests"("payment_method_id", "reference_normalized")
    WHERE "status" IN ('PENDING_REVIEW', 'APPROVED');

CREATE UNIQUE INDEX "manual_topup_requests_owner_idempotency"
    ON "manual_topup_requests"("owner_user_id", "idempotency_key");
CREATE INDEX "manual_topup_requests_owner_idx"
    ON "manual_topup_requests"("owner_user_id", "created_at" DESC, "id");
CREATE INDEX "manual_topup_requests_queue_idx"
    ON "manual_topup_requests"("status", "submitted_at", "id");

ALTER TABLE "manual_topup_requests"
    ADD CONSTRAINT "manual_topup_requests_owner_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "manual_topup_requests"
    ADD CONSTRAINT "manual_topup_requests_method_fkey"
    FOREIGN KEY ("payment_method_id") REFERENCES "manual_payment_methods"("id") ON DELETE RESTRICT;
ALTER TABLE "manual_topup_requests"
    ADD CONSTRAINT "manual_topup_requests_review_started_by_fkey"
    FOREIGN KEY ("review_started_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "manual_topup_requests"
    ADD CONSTRAINT "manual_topup_requests_approved_by_fkey"
    FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "manual_topup_requests"
    ADD CONSTRAINT "manual_topup_requests_rejected_by_fkey"
    FOREIGN KEY ("rejected_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
-- The credit is the same person's entry.
ALTER TABLE "manual_topup_requests"
    ADD CONSTRAINT "manual_topup_requests_credit_entry_fkey"
    FOREIGN KEY ("credit_entry_id", "owner_user_id")
    REFERENCES "credit_ledger_entries"("id", "owner_user_id") ON DELETE RESTRICT;

-- -----------------------------------------------------------------------------
-- 5. Receipts — optional proof of payment
--
-- Private to the owner and to PalCert finance. Never public, never emailed,
-- never shown to an organization. Served only by a short-lived signed URL
-- after the bytes have been scanned.
-- -----------------------------------------------------------------------------
CREATE TABLE "manual_topup_receipts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "status" "ManualTopUpFileStatus" NOT NULL DEFAULT 'AWAITING_UPLOAD',

    "original_filename" TEXT NOT NULL,
    "declared_mime_type" TEXT,
    "expected_format" "ManualTopUpFileFormat" NOT NULL,
    "detected_format" "ManualTopUpFileFormat",
    "detected_mime_type" TEXT,

    "declared_size_bytes" INTEGER NOT NULL,
    "max_file_bytes" INTEGER NOT NULL,
    "size_bytes" INTEGER,
    "client_sha256" CHAR(64),
    "sha256" CHAR(64),

    "quarantine_object_key" TEXT NOT NULL,
    "quarantine_object_version_id" TEXT,
    "quarantine_object_etag" TEXT,
    "quarantine_deleted_at" TIMESTAMPTZ(6),

    "clean_object_key" TEXT,
    "clean_object_version_id" TEXT,
    "clean_object_etag" TEXT,

    "scan_engine" TEXT,
    "scan_signature" TEXT,
    "rejection_code" TEXT,
    "failure_code" TEXT,
    "failure_detail" TEXT,

    "idempotency_key" VARCHAR(200),
    "upload_expires_at" TIMESTAMPTZ(6) NOT NULL,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_at" TIMESTAMPTZ(6),
    "validated_at" TIMESTAMPTZ(6),
    "scanned_at" TIMESTAMPTZ(6),
    "ready_at" TIMESTAMPTZ(6),
    "rejected_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),

    CONSTRAINT "manual_topup_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "manual_topup_receipts_id_request_key" UNIQUE ("id", "request_id"),
    CONSTRAINT "manual_topup_receipts_clean_key" UNIQUE ("clean_object_key"),
    CONSTRAINT "manual_topup_receipts_sizes" CHECK (
        "declared_size_bytes" BETWEEN 1 AND 5242880
        AND "max_file_bytes" BETWEEN 1024 AND 5242880
        AND ("size_bytes" IS NULL OR "size_bytes" BETWEEN 1 AND 5242880)),
    CONSTRAINT "manual_topup_receipts_digest_shape" CHECK (
        ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$')
        AND ("client_sha256" IS NULL OR "client_sha256" ~ '^[0-9a-f]{64}$')),
    CONSTRAINT "manual_topup_receipts_ready_shape" CHECK (
        "status" <> 'READY' OR ("sha256" IS NOT NULL AND "size_bytes" IS NOT NULL
            AND "detected_format" IS NOT NULL AND "detected_mime_type" IS NOT NULL
            AND "clean_object_key" IS NOT NULL AND "ready_at" IS NOT NULL)),
    CONSTRAINT "manual_topup_receipts_filename" CHECK (
        length("original_filename") BETWEEN 1 AND 255)
);

CREATE UNIQUE INDEX "manual_topup_receipts_owner_idempotency"
    ON "manual_topup_receipts"("owner_user_id", "idempotency_key");
CREATE INDEX "manual_topup_receipts_request_idx"
    ON "manual_topup_receipts"("request_id", "created_at");
CREATE INDEX "manual_topup_receipts_status_idx"
    ON "manual_topup_receipts"("status", "upload_expires_at");

ALTER TABLE "manual_topup_receipts"
    ADD CONSTRAINT "manual_topup_receipts_request_owner_fkey"
    FOREIGN KEY ("request_id", "owner_user_id")
    REFERENCES "manual_topup_requests"("id", "owner_user_id") ON DELETE RESTRICT;

-- The request's attached receipt must be one of its own.
ALTER TABLE "manual_topup_requests"
    ADD CONSTRAINT "manual_topup_requests_receipt_fkey"
    FOREIGN KEY ("receipt_id", "id")
    REFERENCES "manual_topup_receipts"("id", "request_id") ON DELETE RESTRICT;

-- -----------------------------------------------------------------------------
-- 6. Request history — append-only
--
-- The timeline a reviewer and the owner read, and the source row every
-- notification about a request is derived from.
-- -----------------------------------------------------------------------------
CREATE TABLE "manual_topup_request_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "event_type" "ManualTopUpEventType" NOT NULL,
    "actor_side" "ManualTopUpActorSide" NOT NULL,
    "actor_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manual_topup_request_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "manual_topup_request_events_side_matches_type" CHECK (
        ("actor_side" = 'OWNER' AND "event_type" IN
            ('CREATED', 'UPDATED', 'RECEIPT_ATTACHED', 'SUBMITTED', 'CANCELLED'))
        OR ("actor_side" = 'FINANCE' AND "event_type" IN
            ('REVIEW_STARTED', 'APPROVED', 'REJECTED')))
);

CREATE INDEX "manual_topup_request_events_request_idx"
    ON "manual_topup_request_events"("request_id", "created_at", "id");

ALTER TABLE "manual_topup_request_events"
    ADD CONSTRAINT "manual_topup_request_events_request_owner_fkey"
    FOREIGN KEY ("request_id", "owner_user_id")
    REFERENCES "manual_topup_requests"("id", "owner_user_id") ON DELETE RESTRICT;
ALTER TABLE "manual_topup_request_events"
    ADD CONSTRAINT "manual_topup_request_events_actor_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL;

-- =============================================================================
-- 7. Integrity triggers
-- =============================================================================

-- A method's code is its identity in every report; archiving is permanent;
-- every edit bumps the version it was made against.
CREATE OR REPLACE FUNCTION manual_payment_methods_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."code" IS DISTINCT FROM OLD."code"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
    THEN
        RAISE EXCEPTION 'manual_payment_method % identity is immutable', OLD."id";
    END IF;

    IF OLD."archived_at" IS NOT NULL THEN
        RAISE EXCEPTION 'manual_payment_method % is archived', OLD."id";
    END IF;

    IF NEW."version" <> OLD."version" + 1 THEN
        RAISE EXCEPTION 'manual_payment_method % must advance its version by one', OLD."id";
    END IF;

    -- Requests already made against this method keep the currency they were
    -- made in; changing a live method's currency would make its history lie.
    IF NEW."currency" IS DISTINCT FROM OLD."currency"
       AND EXISTS (SELECT 1 FROM "manual_topup_requests" r WHERE r."payment_method_id" = OLD."id")
    THEN
        RAISE EXCEPTION 'manual_payment_method % has requests; its currency is fixed', OLD."id";
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "manual_payment_methods_guard"
    BEFORE UPDATE ON "manual_payment_methods"
    FOR EACH ROW EXECUTE FUNCTION manual_payment_methods_guard();

-- An uploaded file's identity is fixed from the start, and once it has been
-- scanned and promoted, so is everything that describes the bytes.
CREATE OR REPLACE FUNCTION manual_topup_files_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."quarantine_object_key" IS DISTINCT FROM OLD."quarantine_object_key"
       OR NEW."expected_format" IS DISTINCT FROM OLD."expected_format"
       OR NEW."declared_size_bytes" IS DISTINCT FROM OLD."declared_size_bytes"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
        RAISE EXCEPTION '% % identity is immutable', TG_TABLE_NAME, OLD."id";
    END IF;

    IF OLD."status" = 'READY' AND (
        NEW."status" IS DISTINCT FROM OLD."status"
        OR NEW."sha256" IS DISTINCT FROM OLD."sha256"
        OR NEW."size_bytes" IS DISTINCT FROM OLD."size_bytes"
        OR NEW."detected_format" IS DISTINCT FROM OLD."detected_format"
        OR NEW."clean_object_key" IS DISTINCT FROM OLD."clean_object_key"
        OR NEW."clean_object_version_id" IS DISTINCT FROM OLD."clean_object_version_id")
    THEN
        RAISE EXCEPTION '% % is ready and its content is frozen', TG_TABLE_NAME, OLD."id";
    END IF;

    IF OLD."status" IN ('REJECTED', 'FAILED', 'UPLOAD_EXPIRED')
       AND NEW."status" IS DISTINCT FROM OLD."status"
    THEN
        RAISE EXCEPTION '% % is % and cannot change state', TG_TABLE_NAME, OLD."id", OLD."status";
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "manual_payment_method_logos_guard"
    BEFORE UPDATE ON "manual_payment_method_logos"
    FOR EACH ROW EXECUTE FUNCTION manual_topup_files_guard();

CREATE TRIGGER "manual_topup_receipts_guard"
    BEFORE UPDATE ON "manual_topup_receipts"
    FOR EACH ROW EXECUTE FUNCTION manual_topup_files_guard();

-- The request state machine, enforced where no service can route around it.
--
--   DRAFT          -> PENDING_REVIEW   owner submits a complete report
--   DRAFT          -> CANCELLED        owner abandons a draft
--   PENDING_REVIEW -> CANCELLED        owner withdraws, only before review starts
--   PENDING_REVIEW -> APPROVED         finance, with the credit entry
--   PENDING_REVIEW -> REJECTED         finance, with a reason
--
-- Terminal states never change again. What the person reported is frozen
-- the moment it leaves DRAFT, and the snapshot is frozen from creation.
CREATE OR REPLACE FUNCTION manual_topup_requests_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_finance boolean := app_is_platform_admin();
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."owner_user_id" IS DISTINCT FROM OLD."owner_user_id"
       OR NEW."payment_method_id" IS DISTINCT FROM OLD."payment_method_id"
       OR NEW."currency" IS DISTINCT FROM OLD."currency"
       OR NEW."payment_method_snapshot" IS DISTINCT FROM OLD."payment_method_snapshot"
       OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
        RAISE EXCEPTION 'manual_topup_request % identity is immutable', OLD."id";
    END IF;

    IF OLD."status" IN ('APPROVED', 'REJECTED', 'CANCELLED') THEN
        RAISE EXCEPTION 'manual_topup_request % is % and final', OLD."id", OLD."status";
    END IF;

    IF OLD."status" <> 'DRAFT' AND (
        NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
        OR NEW."reference_original" IS DISTINCT FROM OLD."reference_original"
        OR NEW."reference_normalized" IS DISTINCT FROM OLD."reference_normalized"
        OR NEW."receipt_id" IS DISTINCT FROM OLD."receipt_id"
        OR NEW."customer_note" IS DISTINCT FROM OLD."customer_note"
        OR NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at")
    THEN
        RAISE EXCEPTION 'manual_topup_request % was submitted; what was reported is frozen', OLD."id";
    END IF;

    -- Review bookkeeping is finance's, and written once.
    IF NEW."review_started_at" IS DISTINCT FROM OLD."review_started_at"
       OR NEW."review_started_by_user_id" IS DISTINCT FROM OLD."review_started_by_user_id"
    THEN
        IF NOT v_finance OR OLD."review_started_at" IS NOT NULL OR OLD."status" <> 'PENDING_REVIEW' THEN
            RAISE EXCEPTION 'manual_topup_request % review start is not writable here', OLD."id";
        END IF;
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
        IF OLD."status" = 'DRAFT' AND NEW."status" = 'PENDING_REVIEW' THEN
            NULL;
        ELSIF OLD."status" IN ('DRAFT', 'PENDING_REVIEW') AND NEW."status" = 'CANCELLED' THEN
            IF OLD."review_started_at" IS NOT NULL OR NEW."review_started_at" IS NOT NULL THEN
                RAISE EXCEPTION 'manual_topup_request % is under review and cannot be cancelled', OLD."id";
            END IF;
        ELSIF OLD."status" = 'PENDING_REVIEW' AND NEW."status" IN ('APPROVED', 'REJECTED') THEN
            IF NOT v_finance THEN
                RAISE EXCEPTION 'only PalCert finance decides manual_topup_request %', OLD."id"
                    USING ERRCODE = 'insufficient_privilege';
            END IF;
        ELSE
            RAISE EXCEPTION 'manual_topup_request % cannot move from % to %',
                OLD."id", OLD."status", NEW."status";
        END IF;
    END IF;

    -- Decision fields move only with the decision itself.
    IF NEW."status" = OLD."status" AND (
        NEW."decided_at" IS DISTINCT FROM OLD."decided_at"
        OR NEW."approved_by_user_id" IS DISTINCT FROM OLD."approved_by_user_id"
        OR NEW."rejected_by_user_id" IS DISTINCT FROM OLD."rejected_by_user_id"
        OR NEW."rejection_reason" IS DISTINCT FROM OLD."rejection_reason"
        OR NEW."rejection_note" IS DISTINCT FROM OLD."rejection_note"
        OR NEW."credit_entry_id" IS DISTINCT FROM OLD."credit_entry_id"
        OR NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at")
    THEN
        RAISE EXCEPTION 'manual_topup_request % decision fields move only with a decision', OLD."id";
    END IF;

    -- The credit, when there is one, must be exactly this request's credit:
    -- the right person, type, class, currency, amount and reference.
    IF NEW."credit_entry_id" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "credit_ledger_entries" e
         WHERE e."id" = NEW."credit_entry_id"
           AND e."owner_user_id" = NEW."owner_user_id"
           AND e."entry_type" = 'MANUAL_TOPUP_CREDIT'
           AND e."credit_class" = 'CASH'
           AND e."currency" = NEW."currency"
           AND e."amount_minor_signed" = NEW."amount_minor"
           AND e."reference_type" = 'MANUAL_TOPUP_REQUEST'
           AND e."reference_id" = NEW."id")
    THEN
        RAISE EXCEPTION 'manual_topup_request % credit entry does not match the request', OLD."id";
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "manual_topup_requests_guard"
    BEFORE UPDATE ON "manual_topup_requests"
    FOR EACH ROW EXECUTE FUNCTION manual_topup_requests_guard();

-- A request is born a draft, by its owner, against an enabled method.
CREATE OR REPLACE FUNCTION manual_topup_requests_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."status" <> 'DRAFT' OR NEW."credit_entry_id" IS NOT NULL
       OR NEW."review_started_at" IS NOT NULL OR NEW."decided_at" IS NOT NULL
       OR NEW."submitted_at" IS NOT NULL OR NEW."receipt_id" IS NOT NULL
    THEN
        RAISE EXCEPTION 'a manual_topup_request is created as an empty DRAFT';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "manual_topup_requests_insert_guard"
    BEFORE INSERT ON "manual_topup_requests"
    FOR EACH ROW EXECUTE FUNCTION manual_topup_requests_insert_guard();

-- History is append-only, and each side writes only as itself.
CREATE OR REPLACE FUNCTION manual_topup_request_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'manual_topup_request_events rows are immutable once written';
END;
$$;

CREATE TRIGGER "manual_topup_request_events_append_only"
    BEFORE UPDATE OR DELETE ON "manual_topup_request_events"
    FOR EACH ROW EXECUTE FUNCTION manual_topup_request_events_append_only();

CREATE OR REPLACE FUNCTION manual_topup_request_events_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF app_is_platform_admin() THEN
        IF NEW."actor_side" <> 'FINANCE' OR NEW."actor_user_id" IS DISTINCT FROM app_current_user_id() THEN
            RAISE EXCEPTION 'finance history is written by the acting reviewer as FINANCE';
        END IF;
    ELSE
        IF NEW."actor_side" <> 'OWNER'
           OR NEW."actor_user_id" IS DISTINCT FROM app_current_user_id()
           OR NEW."owner_user_id" IS DISTINCT FROM app_current_user_id()
        THEN
            RAISE EXCEPTION 'an owner writes history only about their own request, as OWNER';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "manual_topup_request_events_insert_guard"
    BEFORE INSERT ON "manual_topup_request_events"
    FOR EACH ROW EXECUTE FUNCTION manual_topup_request_events_insert_guard();

-- =============================================================================
-- 8. The ledger: one new credit type, confined
--
-- The sign rule is replaced by the same rule with `MANUAL_TOPUP_CREDIT` added
-- to the positive side. It is strictly wider than the rule it replaces, so
-- every existing entry satisfies it; PostgreSQL re-checks them all when the
-- constraint is added, inside this transaction, so there is no moment
-- without a sign rule.
-- =============================================================================
ALTER TABLE "credit_ledger_entries" DROP CONSTRAINT "ledger_entries_sign_matches_type";
ALTER TABLE "credit_ledger_entries"
    ADD CONSTRAINT "ledger_entries_sign_matches_type" CHECK (
        ("entry_type" IN ('TOP_UP_CREDIT', 'SERVICE_REFUND', 'PROMOTIONAL_CREDIT',
                          'ADMIN_CREDIT', 'CHARGEBACK_REVERSAL', 'MANUAL_TOPUP_CREDIT')
            AND "amount_minor_signed" > 0)
        OR ("entry_type" IN ('SERVICE_CHARGE', 'PAYMENT_REFUND_DEBIT', 'ADMIN_DEBIT',
                             'CHARGEBACK_DEBIT')
            AND "amount_minor_signed" < 0)
    );

-- A manual top-up credit is cash, points at its request, names its approver,
-- and carries the approval reason. No existing entry has this type, so no
-- existing entry can fail it.
ALTER TABLE "credit_ledger_entries"
    ADD CONSTRAINT "ledger_entries_manual_topup_shape" CHECK (
        ("entry_type" = 'MANUAL_TOPUP_CREDIT') = ("reference_type" IS NOT DISTINCT FROM 'MANUAL_TOPUP_REQUEST')
        AND ("entry_type" <> 'MANUAL_TOPUP_CREDIT' OR (
            "credit_class" = 'CASH'
            AND "reference_id" IS NOT NULL
            AND "created_by_user_id" IS NOT NULL
            AND "reason_code" IS NOT DISTINCT FROM 'MANUAL_TOPUP_APPROVED'))
    );

-- Exactly one credit per request, whatever the application does: a second
-- approval, a retried transaction, two reviewers at once.
CREATE UNIQUE INDEX "ledger_entries_one_manual_topup_credit"
    ON "credit_ledger_entries"("reference_id")
    WHERE "entry_type" = 'MANUAL_TOPUP_CREDIT';

-- =============================================================================
-- 9. Row-level security, privileges, classification
--
--   manual_payment_methods, manual_payment_method_logos     SYSTEM
--   manual_topup_requests, _receipts, _request_events       USER_SCOPED (owner)
--
-- No organization appears anywhere in this feature. An organization role
-- reaches none of these rows: the owner policies are on the person, and the
-- elevation is PalCert's own audited platform path.
-- =============================================================================
ALTER TABLE "manual_payment_methods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "manual_payment_methods" FORCE ROW LEVEL SECURITY;
-- Anybody signed in may read the catalogue — enabled, unarchived methods
-- only. Configuration is PalCert's.
CREATE POLICY "manual_payment_methods_read" ON "manual_payment_methods" FOR SELECT
    USING (app_is_platform_admin() OR ("enabled" AND "archived_at" IS NULL));
CREATE POLICY "manual_payment_methods_admin_write" ON "manual_payment_methods" FOR ALL
    USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());

ALTER TABLE "manual_payment_method_logos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "manual_payment_method_logos" FORCE ROW LEVEL SECURITY;
-- A scanned logo of a listed method is public to the catalogue; nothing else is.
CREATE POLICY "manual_payment_method_logos_read" ON "manual_payment_method_logos" FOR SELECT
    USING (app_is_platform_admin()
        OR ("status" = 'READY' AND EXISTS (
            SELECT 1 FROM "manual_payment_methods" m
             WHERE m."logo_id" = "manual_payment_method_logos"."id"
               AND m."enabled" AND m."archived_at" IS NULL)));
CREATE POLICY "manual_payment_method_logos_admin_write" ON "manual_payment_method_logos" FOR ALL
    USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());

ALTER TABLE "manual_topup_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "manual_topup_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "manual_topup_requests_owner" ON "manual_topup_requests" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "manual_topup_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "manual_topup_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "manual_topup_receipts_owner" ON "manual_topup_receipts" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "manual_topup_request_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "manual_topup_request_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "manual_topup_request_events_owner" ON "manual_topup_request_events" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

-- Nothing here is ever hard-deleted by the application, and history is not
-- even updatable. (Phase 2's default privileges would otherwise grant both.)
GRANT SELECT, INSERT, UPDATE ON "manual_payment_methods" TO "palcert_app";
REVOKE DELETE, TRUNCATE ON "manual_payment_methods" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "manual_payment_method_logos" TO "palcert_app";
REVOKE DELETE, TRUNCATE ON "manual_payment_method_logos" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "manual_topup_requests" TO "palcert_app";
REVOKE DELETE, TRUNCATE ON "manual_topup_requests" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "manual_topup_receipts" TO "palcert_app";
REVOKE DELETE, TRUNCATE ON "manual_topup_receipts" FROM "palcert_app";
GRANT SELECT, INSERT ON "manual_topup_request_events" TO "palcert_app";
REVOKE UPDATE, DELETE, TRUNCATE ON "manual_topup_request_events" FROM "palcert_app";

INSERT INTO "table_isolation_classification" ("table_name", "classification", "tenant_column", "notes")
VALUES
    ('manual_payment_methods', 'SYSTEM', NULL,
     'Where PalCert asks people to send money for a manual top-up. Configured by platform administrators; readable when enabled. Never deleted.'),
    ('manual_payment_method_logos', 'SYSTEM', NULL,
     'Scanned raster logos for manual payment methods. Written by platform administrators only.'),
    ('manual_topup_requests', 'USER_SCOPED', 'owner_user_id',
     'One person''s report of one transfer, and finance''s decision on it. An organization never sees it.'),
    ('manual_topup_receipts', 'USER_SCOPED', 'owner_user_id',
     'Optional proof of payment. Private to its owner and PalCert finance; never public, never emailed.'),
    ('manual_topup_request_events', 'USER_SCOPED', 'owner_user_id',
     'Append-only history of a manual top-up request. Each side writes only as itself.')
ON CONFLICT ("table_name") DO UPDATE
    SET "classification" = EXCLUDED."classification",
        "tenant_column" = EXCLUDED."tenant_column",
        "notes" = EXCLUDED."notes";

-- =============================================================================
-- 10. Notifications — Phase 16, extended to platform-scoped events
--
-- A manual top-up happens to a person and to PalCert, never to an
-- organization. Its three notification types are therefore the only ones
-- whose events and copies carry no organization, and the database says so in
-- both directions: those types must have none, and every other type must
-- still have one. Existing rows all carry an organization and an older type,
-- so dropping NOT NULL and adding the CHECK changes none of them.
-- =============================================================================
ALTER TABLE "domain_events" ALTER COLUMN "organization_id" DROP NOT NULL;
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_organization_scope" CHECK (
    ("organization_id" IS NULL) =
        ("event_type" IN ('MANUAL_TOPUP_SUBMITTED', 'MANUAL_TOPUP_APPROVED', 'MANUAL_TOPUP_REJECTED'))
);
-- Platform-scoped events have no webhook contract and never reach one.
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_platform_not_webhook" CHECK (
    "organization_id" IS NOT NULL OR NOT "webhook_eligible"
);

ALTER TABLE "user_notifications" ALTER COLUMN "organization_id" DROP NOT NULL;
ALTER TABLE "user_notifications" ADD CONSTRAINT "user_notifications_organization_scope" CHECK (
    ("organization_id" IS NULL) =
        ("notification_type" IN ('MANUAL_TOPUP_SUBMITTED', 'MANUAL_TOPUP_APPROVED', 'MANUAL_TOPUP_REJECTED'))
);

ALTER TABLE "domain_events" DROP CONSTRAINT "domain_events_source_matches_type";
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_source_matches_type" CHECK (
    ("source_type" = 'SUBMISSION_REVISION' AND "event_type" IN
        ('SUBMISSION_READY', 'SUBMISSION_REVISION_READY'))
    OR ("source_type" = 'SUBMISSION_DECISION_EVENT' AND "event_type" IN
        ('SUBMISSION_UNDER_REVIEW', 'SUBMISSION_APPROVED',
         'SUBMISSION_REJECTED', 'SUBMISSION_REVISION_REQUESTED'))
    OR ("source_type" = 'SUBMISSION_COMMENT' AND "event_type" = 'SUBMISSION_COMMENT_ADDED')
    OR ("source_type" = 'CERTIFICATE_EVENT' AND "event_type" IN
        ('CERTIFICATE_ISSUED', 'CERTIFICATE_REVOKED'))
    OR ("source_type" = 'ATTESTATION_REQUEST_EVENT' AND "event_type" IN
        ('ATTESTATION_SUBMITTED', 'ATTESTATION_READY_FOR_REVIEW',
         'ATTESTATION_INFORMATION_REQUESTED', 'ATTESTATION_INFORMATION_PROVIDED',
         'ATTESTATION_APPROVED', 'ATTESTATION_REJECTED', 'ATTESTATION_REVOKED'))
    OR ("source_type" = 'ATTESTATION_REMINDER' AND "event_type" IN
        ('ATTESTATION_EXPIRING', 'ATTESTATION_EXPIRED'))
    OR ("source_type" = 'MANUAL_TOPUP_REQUEST_EVENT' AND "event_type" IN
        ('MANUAL_TOPUP_SUBMITTED', 'MANUAL_TOPUP_APPROVED', 'MANUAL_TOPUP_REJECTED'))
);

ALTER TABLE "domain_events" DROP CONSTRAINT "domain_events_aggregate_matches_type";
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_aggregate_matches_type" CHECK (
    ("event_type" IN ('CERTIFICATE_ISSUED', 'CERTIFICATE_REVOKED')
        AND "aggregate_type" = 'COMPLIANCE_CERTIFICATE')
    OR ("event_type"::text LIKE 'ATTESTATION\_%' AND "aggregate_type" = 'ATTESTATION_REQUEST')
    OR ("event_type"::text LIKE 'MANUAL\_TOPUP\_%' AND "aggregate_type" = 'MANUAL_TOPUP_REQUEST')
    OR ("event_type" NOT IN ('CERTIFICATE_ISSUED', 'CERTIFICATE_REVOKED')
        AND "event_type"::text NOT LIKE 'ATTESTATION\_%'
        AND "event_type"::text NOT LIKE 'MANUAL\_TOPUP\_%'
        AND "aggregate_type" = 'OFFICIAL_SUBMISSION')
);

-- The audience rule, one place. Every earlier branch is unchanged.
CREATE OR REPLACE FUNCTION app_notification_audience(p_event_type "NotificationType")
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_event_type IN ('SUBMISSION_READY', 'SUBMISSION_REVISION_READY')
            THEN 'ORGANIZATION_REVIEWERS'
        WHEN p_event_type IN ('CERTIFICATE_ISSUED', 'CERTIFICATE_REVOKED')
            THEN 'CERTIFICATE_OWNER'
        WHEN p_event_type IN ('ATTESTATION_READY_FOR_REVIEW', 'ATTESTATION_INFORMATION_PROVIDED')
            THEN 'ATTESTATION_REVIEWERS'
        WHEN p_event_type::text LIKE 'ATTESTATION\_%'
            THEN 'ATTESTATION_OWNER'
        WHEN p_event_type = 'MANUAL_TOPUP_SUBMITTED'
            THEN 'PLATFORM_FINANCE_REVIEWERS'
        WHEN p_event_type IN ('MANUAL_TOPUP_APPROVED', 'MANUAL_TOPUP_REJECTED')
            THEN 'MANUAL_TOPUP_OWNER'
        ELSE 'SUBMISSION_OWNER'
    END;
$$;

CREATE OR REPLACE FUNCTION app_notification_reviewer_permission(p_audience text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE p_audience
        WHEN 'ORGANIZATION_REVIEWERS' THEN 'submission:review:read'
        WHEN 'ATTESTATION_REVIEWERS' THEN 'attestation:request:review'
        WHEN 'PLATFORM_FINANCE_REVIEWERS' THEN 'finance:manual-topup:review'
        ELSE NULL
    END;
$$;

-- Whether an audience is resolved from PalCert's own staff. Platform staff
-- hold their authority through GLOBAL roles, which carry no organization, so
-- membership of an organization neither grants nor is required for it.
CREATE OR REPLACE FUNCTION app_notification_is_platform_audience(p_audience text)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT p_audience = 'PLATFORM_FINANCE_REVIEWERS';
$$;

-- PalCert staff who hold `p_permission` through a GLOBAL role, now. An
-- organization-scoped grant of the same code never counts.
CREATE OR REPLACE FUNCTION app_notification_is_platform_reviewer(
    p_user_id uuid, p_permission text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1
          FROM "user_roles" ur
          JOIN "role_permissions" rp ON rp."role_id" = ur."role_id"
          JOIN "permissions" perm ON perm."id" = rp."permission_id" AND perm."code" = p_permission
          JOIN "users" u ON u."id" = ur."user_id"
         WHERE ur."user_id" = p_user_id
           AND ur."scope" = 'GLOBAL'
           AND ur."organization_id" IS NULL
           AND u."status" = 'ACTIVE'
    );
$$;

CREATE OR REPLACE FUNCTION app_notification_is_audience_reviewer(
    p_organization_id uuid, p_user_id uuid, p_audience text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT CASE
        WHEN app_notification_is_platform_audience(p_audience) THEN
            -- A platform audience is never resolved against an organization:
            -- an event that carried one would be a different kind of event.
            p_organization_id IS NULL
            AND app_notification_is_platform_reviewer(
                p_user_id, app_notification_reviewer_permission(p_audience))
        ELSE EXISTS (
            SELECT 1
              FROM "organization_memberships" m
              JOIN "user_roles" ur
                ON ur."user_id" = m."user_id" AND ur."organization_id" = m."organization_id"
              JOIN "role_permissions" rp ON rp."role_id" = ur."role_id"
              JOIN "permissions" perm
                ON perm."id" = rp."permission_id"
               AND perm."code" = app_notification_reviewer_permission(p_audience)
              JOIN "users" u ON u."id" = m."user_id"
             WHERE m."organization_id" = p_organization_id
               AND m."user_id" = p_user_id
               AND m."status" = 'ACTIVE'
               AND u."status" = 'ACTIVE'
        )
    END;
$$;

-- The reviewer resolver. Organization audiences are resolved exactly as
-- before; the platform audience from GLOBAL role holders, keyset-paged the
-- same way.
CREATE OR REPLACE FUNCTION app_notification_submission_reviewers(
    p_event_id uuid,
    p_limit integer DEFAULT 100,
    p_after uuid DEFAULT NULL
) RETURNS TABLE ("user_id" uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    event_row "domain_events"%ROWTYPE;
    v_limit integer;
    v_audience text;
    v_permission text;
BEGIN
    IF NOT app_is_notification_fanout_context() THEN
        RAISE EXCEPTION 'resolving notification recipients is system work'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO event_row FROM "domain_events" WHERE "id" = p_event_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'domain_event % does not exist', p_event_id;
    END IF;

    v_audience := app_notification_audience(event_row."event_type");
    v_permission := app_notification_reviewer_permission(v_audience);
    IF v_permission IS NULL THEN
        RAISE EXCEPTION 'domain_event % is not a reviewer-audience event', p_event_id
            USING ERRCODE = 'check_violation';
    END IF;

    v_limit := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);

    IF app_notification_is_platform_audience(v_audience) THEN
        IF event_row."organization_id" IS NOT NULL THEN
            RAISE EXCEPTION 'domain_event % names an organization but is platform-scoped', p_event_id
                USING ERRCODE = 'check_violation';
        END IF;

        RETURN QUERY
        SELECT DISTINCT ur."user_id"
          FROM "user_roles" ur
          JOIN "role_permissions" rp ON rp."role_id" = ur."role_id"
          JOIN "permissions" perm
            ON perm."id" = rp."permission_id" AND perm."code" = v_permission
          JOIN "users" u ON u."id" = ur."user_id"
         WHERE ur."scope" = 'GLOBAL'
           AND ur."organization_id" IS NULL
           AND u."status" = 'ACTIVE'
           AND (p_after IS NULL OR ur."user_id" > p_after)
         ORDER BY ur."user_id"
         LIMIT v_limit;
        RETURN;
    END IF;

    RETURN QUERY
    SELECT DISTINCT m."user_id"
      FROM "organization_memberships" m
      JOIN "user_roles" ur
        ON ur."user_id" = m."user_id" AND ur."organization_id" = m."organization_id"
      JOIN "role_permissions" rp ON rp."role_id" = ur."role_id"
      JOIN "permissions" perm
        ON perm."id" = rp."permission_id" AND perm."code" = v_permission
      JOIN "users" u ON u."id" = m."user_id"
     WHERE m."organization_id" = event_row."organization_id"
       AND m."status" = 'ACTIVE'
       AND u."status" = 'ACTIVE'
       AND (p_after IS NULL OR m."user_id" > p_after)
     ORDER BY m."user_id"
     LIMIT v_limit;
END;
$$;

-- Emitting from one manual top-up history row. The notification type is
-- derived from the row; a caller cannot ask for one the row did not produce.
-- Only the owner (for their own submission) or PalCert's elevated finance
-- path (for a decision) can emit, and the event carries no organization.
CREATE OR REPLACE FUNCTION app_domain_event_emit_manual_topup(p_request_event_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    history "manual_topup_request_events"%ROWTYPE;
    v_event_type "NotificationType";
    v_id uuid;
BEGIN
    SELECT * INTO history FROM "manual_topup_request_events" WHERE "id" = p_request_event_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'manual_topup_request_event % does not exist', p_request_event_id;
    END IF;

    IF NOT COALESCE(
        app_is_platform_admin()
        OR (app_current_user_id() IS NOT NULL AND history."owner_user_id" = app_current_user_id()),
        false)
    THEN
        RAISE EXCEPTION 'manual_topup_request_event % is not the caller''s to report', p_request_event_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    v_event_type := CASE history."event_type"
        WHEN 'SUBMITTED' THEN 'MANUAL_TOPUP_SUBMITTED'::"NotificationType"
        WHEN 'APPROVED' THEN 'MANUAL_TOPUP_APPROVED'::"NotificationType"
        WHEN 'REJECTED' THEN 'MANUAL_TOPUP_REJECTED'::"NotificationType"
        ELSE NULL
    END;
    IF v_event_type IS NULL THEN
        -- Drafts, edits, receipts, review starts and cancellations tell nobody.
        RETURN NULL;
    END IF;

    INSERT INTO "domain_events" (
        "id", "event_type", "event_schema_version", "source_type", "source_id",
        "aggregate_type", "aggregate_id", "owner_user_id", "organization_id",
        "occurred_at", "payload", "webhook_eligible"
    ) VALUES (
        gen_random_uuid(), v_event_type, 1, 'MANUAL_TOPUP_REQUEST_EVENT', history."id",
        'MANUAL_TOPUP_REQUEST', history."request_id",
        history."owner_user_id", NULL,
        history."created_at",
        jsonb_build_object('manualTopUpRequestId', history."request_id"),
        false
    )
    ON CONFLICT ("source_type", "source_id", "event_type") DO NOTHING
    RETURNING "id" INTO v_id;

    IF v_id IS NULL THEN
        SELECT "id" INTO v_id FROM "domain_events"
         WHERE "source_type" = 'MANUAL_TOPUP_REQUEST_EVENT'
           AND "source_id" = history."id"
           AND "event_type" = v_event_type;
    END IF;

    RETURN v_id;
END;
$$;

-- The typed facts a manual top-up notification may show its recipient: the
-- amount, the currency, the method's name, the reference the person typed,
-- and (for a rejection) the reason code. Nothing else — no receipt, no IBAN,
-- no phone number, no customer address — and only to a caller entitled to
-- the copy: the fan-out system path, or the notification's own recipient.
CREATE OR REPLACE FUNCTION app_manual_topup_notification_facts(
    p_event_id uuid, p_recipient_user_id uuid
) RETURNS TABLE (
    "amount_minor" bigint,
    "currency" text,
    "method_name_en" text,
    "method_name_ar" text,
    "reference" text,
    "rejection_reason" text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    event_row "domain_events"%ROWTYPE;
BEGIN
    SELECT * INTO event_row FROM "domain_events" WHERE "id" = p_event_id;
    IF NOT FOUND OR event_row."aggregate_type" <> 'MANUAL_TOPUP_REQUEST' THEN
        RETURN;
    END IF;

    IF NOT app_is_notification_fanout_context() THEN
        IF app_current_user_id() IS NULL
           OR app_current_user_id() <> p_recipient_user_id
           OR NOT EXISTS (
                SELECT 1 FROM "user_notifications" n
                 WHERE n."source_event_id" = p_event_id
                   AND n."recipient_user_id" = p_recipient_user_id)
        THEN
            RAISE EXCEPTION 'manual top-up notification facts are for their recipient'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;

    RETURN QUERY
    SELECT r."amount_minor",
           r."currency"::text,
           r."payment_method_snapshot"->>'nameEn',
           r."payment_method_snapshot"->>'nameAr',
           r."reference_original"::text,
           r."rejection_reason"::text
      FROM "manual_topup_requests" r
     WHERE r."id" = event_row."aggregate_id";
END;
$$;

-- =============================================================================
-- 11. Durable jobs
--
-- A receipt's scan is its owner's work, as a document ingest is. A logo's is
-- filed under the administrator who uploaded it. Both are the existing
-- "owner, no organization" branch, so only the vocabulary widens.
-- =============================================================================
ALTER TABLE "processing_jobs" DROP CONSTRAINT "processing_jobs_resource_type_known";
ALTER TABLE "processing_jobs"
    ADD CONSTRAINT "processing_jobs_resource_type_known"
    CHECK ("resource_type" IN (
        'DOCUMENT_VERSION', 'DOCUMENT', 'DOCUMENT_ANALYSIS', 'DOCUMENT_CHECK', 'CHECK_RUN', 'AI_REVIEW',
        'STANDARD_SOURCE_ASSET', 'RULE_EXTRACTION_RUN',
        'PAYMENT_PROVIDER_EVENT', 'PAYMENT_RECONCILIATION',
        'SMARTFIX_REQUEST', 'SUBMISSION_REVISION', 'COMPLIANCE_CERTIFICATE',
        'DOMAIN_EVENT', 'NOTIFICATION_DELIVERY',
        'WEBHOOK_DELIVERY', 'WEBHOOK_VERIFICATION_OPERATION',
        'ATTESTATION_ARTIFACT', 'ATTESTATION_REQUEST',
        'MANUAL_TOPUP_RECEIPT', 'MANUAL_PAYMENT_METHOD_LOGO'));

-- =============================================================================
-- 12. Permissions
--
-- Configuring where people pay and deciding that a payment arrived are held
-- by different roles. PALCERT_ADMIN configures methods and reads the queue;
-- PALCERT_FINANCE reviews, approves and rejects; PALCERT_AUDITOR reads. No
-- organization role receives any of these.
-- =============================================================================
INSERT INTO "permissions" ("id", "code", "description") VALUES
    (gen_random_uuid(), 'admin:payment-method:read',
     'Read the configured manual payment methods, enabled or not'),
    (gen_random_uuid(), 'admin:payment-method:manage',
     'Create, edit, enable, disable and archive manual payment methods'),
    (gen_random_uuid(), 'finance:manual-topup:read',
     'Read manual top-up requests, their receipts and their history'),
    (gen_random_uuid(), 'finance:manual-topup:review',
     'Open a manual top-up request for review'),
    (gen_random_uuid(), 'finance:manual-topup:approve',
     'Approve a manual top-up request, crediting the customer''s cash balance'),
    (gen_random_uuid(), 'finance:manual-topup:reject',
     'Reject a manual top-up request with a stated reason')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r CROSS JOIN "permissions" p
WHERE (r."code" = 'PALCERT_ADMIN' AND p."code" IN
        ('admin:payment-method:read', 'admin:payment-method:manage', 'finance:manual-topup:read'))
   OR (r."code" = 'PALCERT_FINANCE' AND p."code" IN
        ('admin:payment-method:read', 'finance:manual-topup:read', 'finance:manual-topup:review',
         'finance:manual-topup:approve', 'finance:manual-topup:reject'))
   OR (r."code" = 'PALCERT_AUDITOR' AND p."code" IN
        ('admin:payment-method:read', 'finance:manual-topup:read'))
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- =============================================================================
-- 13. Function privileges
-- =============================================================================
REVOKE ALL ON FUNCTION app_notification_is_platform_audience(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_notification_is_platform_reviewer(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_domain_event_emit_manual_topup(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_manual_topup_notification_facts(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION manual_payment_methods_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION manual_topup_files_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION manual_topup_requests_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION manual_topup_requests_insert_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION manual_topup_request_events_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION manual_topup_request_events_insert_guard() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_notification_is_platform_audience(text) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_notification_is_platform_reviewer(uuid, text) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_domain_event_emit_manual_topup(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_manual_topup_notification_facts(uuid, uuid) TO "palcert_app";

COMMENT ON TABLE "manual_topup_requests" IS
    'A person''s report of a bank or wallet transfer to PalCert. Credit is created only by a finance approval, as exactly one MANUAL_TOPUP_CREDIT entry in credit_ledger_entries.';
COMMENT ON COLUMN "manual_topup_requests"."payment_method_snapshot" IS
    'The destination the person was shown when the request was created. Frozen; editing the method never changes it.';
