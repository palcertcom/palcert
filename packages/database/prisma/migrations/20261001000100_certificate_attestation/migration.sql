-- =============================================================================
-- Certificate attestation
--
-- A PalCert user uploads a certificate they already hold; an institution
-- reviews that exact file; on approval PalCert records an immutable
-- attestation over the file's SHA-256, with a public verification link.
--
-- PalCert attests a *submitted artifact*. It does not claim to have issued the
-- external certificate, and the institution is not re-issuing it.
--
-- Additive only. Every table below is new; every change to an existing object
-- is either a new enum value (previous migration), a widened CHECK constraint
-- that every existing row already satisfies, or a CREATE OR REPLACE of a
-- notification function whose behaviour for every existing event type is
-- unchanged. No existing row is read, rewritten or deleted.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Vocabulary
-- ---------------------------------------------------------------------------
CREATE TYPE "AttestationRequestStatus" AS ENUM (
    'DRAFT', 'SUBMITTED', 'IN_REVIEW', 'NEEDS_INFORMATION', 'APPROVED', 'REJECTED', 'CANCELLED'
);

CREATE TYPE "AttestationArtifactStatus" AS ENUM (
    'AWAITING_UPLOAD', 'UPLOADED', 'VALIDATING', 'SCANNING', 'READY',
    'REJECTED', 'FAILED', 'UPLOAD_EXPIRED', 'CANCELLED'
);

CREATE TYPE "AttestationArtifactFormat" AS ENUM ('PDF', 'PNG', 'JPEG', 'WEBP');

-- A projection for queues and receipts. The holds and the ledger are the
-- authority for money; this column is kept in step with them by the one job
-- that moves it.
CREATE TYPE "AttestationPaymentStatus" AS ENUM (
    'NOT_REQUIRED', 'UNPAID', 'RESERVED', 'SETTLED', 'RELEASED'
);

CREATE TYPE "AttestationRequestEventType" AS ENUM (
    'CREATED', 'SUBMITTED', 'REVIEW_STARTED', 'ASSIGNED',
    'INFORMATION_REQUESTED', 'INFORMATION_PROVIDED',
    'APPROVED', 'REJECTED', 'CANCELLED', 'REVOKED',
    'PAYMENT_RESERVED', 'PAYMENT_SETTLED', 'PAYMENT_RELEASED'
);

CREATE TYPE "AttestationActorSide" AS ENUM ('OWNER', 'ORGANIZATION', 'SYSTEM');

-- ---------------------------------------------------------------------------
-- 2. Attestation types — configured by each institution
--
-- Nothing here is global: a university's "Degree certificate" is its own row,
-- with its own fee, validity and instructions.
-- ---------------------------------------------------------------------------
CREATE TABLE "attestation_types" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,

    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "description_en" TEXT,
    "description_ar" TEXT,
    "instructions_en" TEXT,
    "instructions_ar" TEXT,

    "enabled" BOOLEAN NOT NULL DEFAULT true,

    -- Money in minor units with a currency, never a float (ADR-0068).
    "fee_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL,

    -- Null means the reviewer chooses. Explicit dates are stored on the
    -- attestation itself; this is only the default that fills them.
    "default_validity_days" INTEGER,
    "allow_no_expiry" BOOLEAN NOT NULL DEFAULT false,
    "reviewer_may_override_validity" BOOLEAN NOT NULL DEFAULT true,

    "required_fields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "allowed_formats" "AttestationArtifactFormat"[] NOT NULL
        DEFAULT ARRAY['PDF', 'PNG', 'JPEG', 'WEBP']::"AttestationArtifactFormat"[],
    "max_file_bytes" INTEGER NOT NULL DEFAULT 20971520,
    "reminder_days" INTEGER[] NOT NULL DEFAULT ARRAY[30, 14, 7, 1],

    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attestation_types_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attestation_types_id_org_key" UNIQUE ("id", "organization_id"),
    CONSTRAINT "attestation_types_names" CHECK (
        length(btrim("name_en")) BETWEEN 1 AND 200 AND length(btrim("name_ar")) BETWEEN 1 AND 200),
    CONSTRAINT "attestation_types_text_bounded" CHECK (
        coalesce(length("description_en"), 0) <= 2000 AND coalesce(length("description_ar"), 0) <= 2000
        AND coalesce(length("instructions_en"), 0) <= 4000
        AND coalesce(length("instructions_ar"), 0) <= 4000),
    CONSTRAINT "attestation_types_fee" CHECK ("fee_minor" >= 0 AND "fee_minor" <= 1000000000000000),
    CONSTRAINT "attestation_types_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "attestation_types_validity" CHECK (
        "default_validity_days" IS NULL OR "default_validity_days" BETWEEN 1 AND 36600),
    -- Somebody must be able to decide how long an attestation lasts.
    CONSTRAINT "attestation_types_validity_decidable" CHECK (
        "reviewer_may_override_validity" OR "default_validity_days" IS NOT NULL OR "allow_no_expiry"),
    CONSTRAINT "attestation_types_required_fields_known" CHECK (
        "required_fields" <@ ARRAY['certificateType', 'issuingOrganization', 'issueDate',
                                   'referenceNumber', 'recipientName', 'description']::TEXT[]),
    CONSTRAINT "attestation_types_formats_present" CHECK (cardinality("allowed_formats") BETWEEN 1 AND 4),
    CONSTRAINT "attestation_types_max_file" CHECK ("max_file_bytes" BETWEEN 1024 AND 20971520),
    CONSTRAINT "attestation_types_reminders" CHECK (
        cardinality("reminder_days") <= 8
        AND 1 <= ALL ("reminder_days") AND 365 >= ALL ("reminder_days"))
);

CREATE INDEX "attestation_types_org_idx" ON "attestation_types"("organization_id", "enabled");

ALTER TABLE "attestation_types"
    ADD CONSTRAINT "attestation_types_organization_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
ALTER TABLE "attestation_types"
    ADD CONSTRAINT "attestation_types_created_by_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
ALTER TABLE "attestation_types"
    ADD CONSTRAINT "attestation_types_updated_by_fkey"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 3. PalCert's commission, per institution, with history
--
-- Append-only. A change is a new row with its own effective date, author and
-- reason; the rate in force is the latest row already in effect. Requests copy
-- the rate at submission, so nothing here can reach back into one.
-- ---------------------------------------------------------------------------
CREATE TABLE "organization_attestation_commissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    -- Basis points: 1500 = 15.00%.
    "commission_bps" INTEGER NOT NULL,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "changed_by_user_id" UUID NOT NULL,
    "change_reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_attestation_commissions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organization_attestation_commissions_rate" CHECK ("commission_bps" BETWEEN 0 AND 10000),
    CONSTRAINT "organization_attestation_commissions_reason" CHECK (
        length(btrim("change_reason")) BETWEEN 1 AND 500)
);

CREATE INDEX "organization_attestation_commissions_current_idx"
    ON "organization_attestation_commissions"("organization_id", "effective_from" DESC, "created_at" DESC);

ALTER TABLE "organization_attestation_commissions"
    ADD CONSTRAINT "organization_attestation_commissions_organization_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
ALTER TABLE "organization_attestation_commissions"
    ADD CONSTRAINT "organization_attestation_commissions_changed_by_fkey"
    FOREIGN KEY ("changed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 4. Requests
--
-- Submitted metadata (the user's word) lives here. Confirmed metadata (the
-- institution's) lives on the attestation. They are never the same columns.
-- ---------------------------------------------------------------------------
CREATE TABLE "attestation_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "owner_user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "attestation_type_id" UUID NOT NULL,
    "status" "AttestationRequestStatus" NOT NULL DEFAULT 'DRAFT',

    -- Labels as they stood when the request was made, for the owner's list.
    "organization_name" TEXT NOT NULL,
    "type_name_en" TEXT NOT NULL,
    "type_name_ar" TEXT NOT NULL,

    -- Submitted metadata.
    "certificate_title" TEXT NOT NULL,
    "certificate_type" TEXT,
    "issuing_organization" TEXT,
    "issue_date" DATE,
    "reference_number" TEXT,
    "recipient_name" TEXT,
    "description" TEXT,
    "notes_for_reviewer" TEXT,

    "current_artifact_id" UUID,

    -- Policy snapshot, taken at submission.
    "default_validity_days" INTEGER,
    "allow_no_expiry" BOOLEAN,
    "reviewer_may_override_validity" BOOLEAN,
    "reminder_days" INTEGER[],

    -- Price snapshot, taken at submission and immutable from then on. A later
    -- fee or commission change cannot reach an existing request.
    "currency" VARCHAR(3),
    "gross_fee_minor" BIGINT,
    "platform_commission_bps" INTEGER,
    "platform_fee_minor" BIGINT,
    "institution_net_minor" BIGINT,
    "commission_id" UUID,
    "priced_at" TIMESTAMPTZ(6),

    "payment_status" "AttestationPaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "hold_id" UUID,
    "capture_entry_id" UUID,
    "payment_settled_at" TIMESTAMPTZ(6),
    "payment_released_at" TIMESTAMPTZ(6),

    "assigned_reviewer_user_id" UUID,
    "previous_attestation_id" UUID,

    "open_information_request" TEXT,
    "rejection_reason" TEXT,

    "idempotency_key" VARCHAR(200),

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMPTZ(6),
    "review_started_at" TIMESTAMPTZ(6),
    "decided_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),

    CONSTRAINT "attestation_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attestation_requests_id_owner_key" UNIQUE ("id", "owner_user_id"),
    CONSTRAINT "attestation_requests_id_org_key" UNIQUE ("id", "organization_id"),
    CONSTRAINT "attestation_requests_hold_key" UNIQUE ("hold_id"),
    CONSTRAINT "attestation_requests_text_bounded" CHECK (
        length(btrim("certificate_title")) BETWEEN 1 AND 300
        AND coalesce(length("certificate_type"), 0) <= 200
        AND coalesce(length("issuing_organization"), 0) <= 300
        AND coalesce(length("reference_number"), 0) <= 120
        AND coalesce(length("recipient_name"), 0) <= 200
        AND coalesce(length("description"), 0) <= 2000
        AND coalesce(length("notes_for_reviewer"), 0) <= 2000
        AND coalesce(length("open_information_request"), 0) <= 2000
        AND coalesce(length("rejection_reason"), 0) <= 2000),
    -- The price snapshot is all or nothing, and adds up.
    CONSTRAINT "attestation_requests_price_snapshot" CHECK (
        ("gross_fee_minor" IS NULL AND "currency" IS NULL AND "platform_commission_bps" IS NULL
            AND "platform_fee_minor" IS NULL AND "institution_net_minor" IS NULL AND "priced_at" IS NULL)
        OR ("gross_fee_minor" IS NOT NULL AND "currency" ~ '^[A-Z]{3}$'
            AND "platform_commission_bps" BETWEEN 0 AND 10000
            AND "platform_fee_minor" >= 0 AND "institution_net_minor" >= 0
            AND "gross_fee_minor" = "platform_fee_minor" + "institution_net_minor"
            AND "priced_at" IS NOT NULL)),
    -- Anything past DRAFT has been priced, and a draft has not.
    CONSTRAINT "attestation_requests_priced_when_submitted" CHECK (
        ("status" = 'DRAFT' AND "priced_at" IS NULL)
        OR ("status" = 'CANCELLED')
        OR ("status" NOT IN ('DRAFT', 'CANCELLED') AND "priced_at" IS NOT NULL AND "submitted_at" IS NOT NULL)),
    CONSTRAINT "attestation_requests_payment_shape" CHECK (
        ("payment_status" = 'UNPAID' AND "hold_id" IS NULL AND "capture_entry_id" IS NULL)
        OR ("payment_status" = 'NOT_REQUIRED' AND "hold_id" IS NULL AND "capture_entry_id" IS NULL)
        OR ("payment_status" = 'RESERVED' AND "hold_id" IS NOT NULL AND "capture_entry_id" IS NULL)
        OR ("payment_status" = 'SETTLED' AND "hold_id" IS NOT NULL AND "capture_entry_id" IS NOT NULL
            AND "payment_settled_at" IS NOT NULL)
        OR ("payment_status" = 'RELEASED' AND "hold_id" IS NOT NULL AND "capture_entry_id" IS NULL
            AND "payment_released_at" IS NOT NULL)),
    CONSTRAINT "attestation_requests_terminal_timestamps" CHECK (
        ("status" NOT IN ('APPROVED', 'REJECTED') OR "decided_at" IS NOT NULL)
        AND ("status" <> 'CANCELLED' OR "cancelled_at" IS NOT NULL)
        AND ("status" <> 'REJECTED' OR length(btrim(coalesce("rejection_reason", ''))) > 0))
);

CREATE UNIQUE INDEX "attestation_requests_owner_idempotency"
    ON "attestation_requests"("owner_user_id", "idempotency_key");
CREATE INDEX "attestation_requests_owner_idx"
    ON "attestation_requests"("owner_user_id", "updated_at" DESC, "id");
CREATE INDEX "attestation_requests_queue_idx"
    ON "attestation_requests"("organization_id", "status", "submitted_at", "id");
CREATE INDEX "attestation_requests_type_idx"
    ON "attestation_requests"("attestation_type_id");

ALTER TABLE "attestation_requests"
    ADD CONSTRAINT "attestation_requests_owner_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "attestation_requests"
    ADD CONSTRAINT "attestation_requests_organization_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
-- Same-tenant by construction: a request cannot point at another
-- organization's type.
ALTER TABLE "attestation_requests"
    ADD CONSTRAINT "attestation_requests_type_fkey"
    FOREIGN KEY ("attestation_type_id", "organization_id")
    REFERENCES "attestation_types"("id", "organization_id") ON DELETE RESTRICT;
ALTER TABLE "attestation_requests"
    ADD CONSTRAINT "attestation_requests_commission_fkey"
    FOREIGN KEY ("commission_id") REFERENCES "organization_attestation_commissions"("id") ON DELETE RESTRICT;
ALTER TABLE "attestation_requests"
    ADD CONSTRAINT "attestation_requests_hold_fkey"
    FOREIGN KEY ("hold_id", "owner_user_id") REFERENCES "credit_holds"("id", "owner_user_id") ON DELETE RESTRICT;
ALTER TABLE "attestation_requests"
    ADD CONSTRAINT "attestation_requests_capture_fkey"
    FOREIGN KEY ("capture_entry_id") REFERENCES "credit_ledger_entries"("id") ON DELETE RESTRICT;
ALTER TABLE "attestation_requests"
    ADD CONSTRAINT "attestation_requests_reviewer_fkey"
    FOREIGN KEY ("assigned_reviewer_user_id") REFERENCES "users"("id") ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 5. Artifacts — the exact submitted bytes
--
-- The same secure ingestion as every other upload: a server-generated
-- quarantine key, finalize against the exact object version, signature
-- detection, malware scan, digest, immutable promotion to the clean zone.
-- Once READY the identity columns are frozen, and once an attestation names
-- an artifact it can never be removed.
-- ---------------------------------------------------------------------------
CREATE TABLE "attestation_artifacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "status" "AttestationArtifactStatus" NOT NULL DEFAULT 'AWAITING_UPLOAD',

    -- Sanitized, user-facing only. Never a path, key or argument.
    "original_filename" TEXT NOT NULL,
    "declared_mime_type" TEXT,
    "expected_format" "AttestationArtifactFormat" NOT NULL,
    "detected_format" "AttestationArtifactFormat",
    "detected_mime_type" TEXT,

    "declared_size_bytes" INTEGER NOT NULL,
    "max_file_bytes" INTEGER NOT NULL,
    "size_bytes" INTEGER,
    "client_sha256" CHAR(64),
    -- Authoritative: computed by PalCert over the exact original bytes.
    "sha256" CHAR(64),

    "quarantine_object_key" TEXT NOT NULL,
    "quarantine_object_version_id" TEXT,
    "quarantine_object_etag" TEXT,
    "quarantine_deleted_at" TIMESTAMPTZ(6),

    "clean_object_key" TEXT,
    "clean_object_version_id" TEXT,
    "clean_object_etag" TEXT,
    -- Set when retention removes the clean object of a rejected or cancelled
    -- request. Never set for an artifact an attestation names.
    "purged_at" TIMESTAMPTZ(6),

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
    "cancelled_at" TIMESTAMPTZ(6),

    CONSTRAINT "attestation_artifacts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attestation_artifacts_id_request_key" UNIQUE ("id", "request_id"),
    CONSTRAINT "attestation_artifacts_clean_key" UNIQUE ("clean_object_key"),
    CONSTRAINT "attestation_artifacts_sizes" CHECK (
        "declared_size_bytes" BETWEEN 1 AND 20971520
        AND "max_file_bytes" BETWEEN 1024 AND 20971520
        AND ("size_bytes" IS NULL OR "size_bytes" BETWEEN 1 AND 20971520)),
    CONSTRAINT "attestation_artifacts_digest_shape" CHECK (
        ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$')
        AND ("client_sha256" IS NULL OR "client_sha256" ~ '^[0-9a-f]{64}$')),
    CONSTRAINT "attestation_artifacts_ready_shape" CHECK (
        "status" <> 'READY' OR ("sha256" IS NOT NULL AND "size_bytes" IS NOT NULL
            AND "detected_format" IS NOT NULL AND "detected_mime_type" IS NOT NULL
            AND "clean_object_key" IS NOT NULL AND "ready_at" IS NOT NULL)),
    CONSTRAINT "attestation_artifacts_filename" CHECK (length("original_filename") BETWEEN 1 AND 255)
);

CREATE UNIQUE INDEX "attestation_artifacts_owner_idempotency"
    ON "attestation_artifacts"("owner_user_id", "idempotency_key");
CREATE INDEX "attestation_artifacts_request_idx" ON "attestation_artifacts"("request_id", "created_at");
-- Duplicate detection is per organization, by design: never across tenants.
CREATE INDEX "attestation_artifacts_org_sha_idx" ON "attestation_artifacts"("organization_id", "sha256");
CREATE INDEX "attestation_artifacts_status_idx" ON "attestation_artifacts"("status", "upload_expires_at");

ALTER TABLE "attestation_artifacts"
    ADD CONSTRAINT "attestation_artifacts_request_owner_fkey"
    FOREIGN KEY ("request_id", "owner_user_id")
    REFERENCES "attestation_requests"("id", "owner_user_id") ON DELETE RESTRICT;
ALTER TABLE "attestation_artifacts"
    ADD CONSTRAINT "attestation_artifacts_request_org_fkey"
    FOREIGN KEY ("request_id", "organization_id")
    REFERENCES "attestation_requests"("id", "organization_id") ON DELETE RESTRICT;

-- The request's current file must be one of its own.
ALTER TABLE "attestation_requests"
    ADD CONSTRAINT "attestation_requests_current_artifact_fkey"
    FOREIGN KEY ("current_artifact_id", "id")
    REFERENCES "attestation_artifacts"("id", "request_id") ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 6. Request history — append-only
-- ---------------------------------------------------------------------------
CREATE TABLE "attestation_request_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "event_type" "AttestationRequestEventType" NOT NULL,
    "actor_side" "AttestationActorSide" NOT NULL,
    -- Null only for PalCert's own events.
    "actor_user_id" UUID,
    "from_status" "AttestationRequestStatus",
    "to_status" "AttestationRequestStatus",
    "message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attestation_request_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attestation_request_events_actor_shape" CHECK (
        ("actor_side" = 'SYSTEM' AND "actor_user_id" IS NULL)
        OR ("actor_side" <> 'SYSTEM' AND "actor_user_id" IS NOT NULL)),
    CONSTRAINT "attestation_request_events_message_bounded" CHECK (coalesce(length("message"), 0) <= 2000)
);

CREATE INDEX "attestation_request_events_request_idx"
    ON "attestation_request_events"("request_id", "created_at", "id");
CREATE INDEX "attestation_request_events_org_idx"
    ON "attestation_request_events"("organization_id", "created_at", "id");

ALTER TABLE "attestation_request_events"
    ADD CONSTRAINT "attestation_request_events_request_owner_fkey"
    FOREIGN KEY ("request_id", "owner_user_id")
    REFERENCES "attestation_requests"("id", "owner_user_id") ON DELETE RESTRICT;
ALTER TABLE "attestation_request_events"
    ADD CONSTRAINT "attestation_request_events_request_org_fkey"
    FOREIGN KEY ("request_id", "organization_id")
    REFERENCES "attestation_requests"("id", "organization_id") ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 7. Attestations — the immutable record
--
-- Written once, by the approving reviewer, in the same transaction as the
-- approval. Afterwards only revocation may be recorded on it, once.
-- ---------------------------------------------------------------------------
CREATE TABLE "attestations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "attestation_type_id" UUID NOT NULL,

    -- Human-facing, printable, non-sequential. Not a capability.
    "reference" TEXT NOT NULL,
    -- The public token is a capability, so the database keeps only a one-way
    -- hash for lookup and an AES-256-GCM envelope under a key PostgreSQL does
    -- not hold, so the owner can be shown their link again. A read of this
    -- table discloses no working verification link.
    "public_token_hash" CHAR(64) NOT NULL,
    "public_token_sealed" TEXT NOT NULL,

    -- The exact artifact version this attestation is about.
    "artifact_id" UUID NOT NULL,
    "artifact_sha256" CHAR(64) NOT NULL,
    "artifact_size_bytes" INTEGER NOT NULL,
    "artifact_mime_type" TEXT NOT NULL,
    "artifact_clean_object_key" TEXT NOT NULL,
    "artifact_clean_object_version_id" TEXT,

    "organization_name" TEXT NOT NULL,
    "organization_verified_at_approval" BOOLEAN NOT NULL,
    "type_name_en" TEXT NOT NULL,
    "type_name_ar" TEXT NOT NULL,

    -- Confirmed metadata: the institution's word, not the user's.
    "certificate_title" TEXT NOT NULL,
    "certificate_type" TEXT,
    "holder_name" TEXT,
    "issuing_organization" TEXT,
    "issue_date" DATE,
    "reference_number" TEXT,
    "holder_name_public" BOOLEAN NOT NULL DEFAULT true,
    "reference_number_public" BOOLEAN NOT NULL DEFAULT true,
    -- Shown to the owner. Never on the public page.
    "institution_note" TEXT,

    -- Explicit instants. `valid_until` is valid-through: expired from that
    -- instant on. Null only where the type allowed "no expiration".
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_until" TIMESTAMPTZ(6),
    "reminder_days" INTEGER[] NOT NULL,

    "approved_by_user_id" UUID NOT NULL,
    "approved_at" TIMESTAMPTZ(6) NOT NULL,

    "manifest_version" INTEGER NOT NULL,
    "attestation_hash" CHAR(64) NOT NULL,

    "previous_attestation_id" UUID,

    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_user_id" UUID,
    "revocation_reason" TEXT,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attestations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attestations_request_key" UNIQUE ("request_id"),
    CONSTRAINT "attestations_reference_key" UNIQUE ("reference"),
    CONSTRAINT "attestations_token_key" UNIQUE ("public_token_hash"),
    CONSTRAINT "attestations_reference_shape" CHECK ("reference" ~ '^PC-ATT-[0-9]{4}-[0-9A-HJKMNP-TV-Z]{8}$'),
    CONSTRAINT "attestations_digest_shape" CHECK (
        "artifact_sha256" ~ '^[0-9a-f]{64}$' AND "attestation_hash" ~ '^[0-9a-f]{64}$'
        AND "public_token_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "attestations_validity" CHECK ("valid_until" IS NULL OR "valid_until" > "valid_from"),
    CONSTRAINT "attestations_revocation_shape" CHECK (
        ("revoked_at" IS NULL AND "revoked_by_user_id" IS NULL AND "revocation_reason" IS NULL)
        OR ("revoked_at" IS NOT NULL AND "revoked_by_user_id" IS NOT NULL
            AND length(btrim(coalesce("revocation_reason", ''))) BETWEEN 1 AND 2000)),
    CONSTRAINT "attestations_text_bounded" CHECK (
        length(btrim("certificate_title")) BETWEEN 1 AND 300
        AND coalesce(length("certificate_type"), 0) <= 200
        AND coalesce(length("holder_name"), 0) <= 200
        AND coalesce(length("issuing_organization"), 0) <= 300
        AND coalesce(length("reference_number"), 0) <= 120
        AND coalesce(length("institution_note"), 0) <= 2000)
);

CREATE INDEX "attestations_owner_idx" ON "attestations"("owner_user_id", "approved_at" DESC);
CREATE INDEX "attestations_org_idx" ON "attestations"("organization_id", "approved_at" DESC);
CREATE INDEX "attestations_artifact_sha_idx" ON "attestations"("artifact_sha256");
CREATE INDEX "attestations_expiry_idx" ON "attestations"("valid_until") WHERE "revoked_at" IS NULL;

ALTER TABLE "attestations"
    ADD CONSTRAINT "attestations_request_owner_fkey"
    FOREIGN KEY ("request_id", "owner_user_id")
    REFERENCES "attestation_requests"("id", "owner_user_id") ON DELETE RESTRICT;
ALTER TABLE "attestations"
    ADD CONSTRAINT "attestations_request_org_fkey"
    FOREIGN KEY ("request_id", "organization_id")
    REFERENCES "attestation_requests"("id", "organization_id") ON DELETE RESTRICT;
ALTER TABLE "attestations"
    ADD CONSTRAINT "attestations_artifact_fkey"
    FOREIGN KEY ("artifact_id", "request_id")
    REFERENCES "attestation_artifacts"("id", "request_id") ON DELETE RESTRICT;
ALTER TABLE "attestations"
    ADD CONSTRAINT "attestations_type_fkey"
    FOREIGN KEY ("attestation_type_id", "organization_id")
    REFERENCES "attestation_types"("id", "organization_id") ON DELETE RESTRICT;
ALTER TABLE "attestations"
    ADD CONSTRAINT "attestations_approved_by_fkey"
    FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "attestations"
    ADD CONSTRAINT "attestations_revoked_by_fkey"
    FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "attestations"
    ADD CONSTRAINT "attestations_previous_fkey"
    FOREIGN KEY ("previous_attestation_id") REFERENCES "attestations"("id") ON DELETE RESTRICT;

ALTER TABLE "attestation_requests"
    ADD CONSTRAINT "attestation_requests_previous_fkey"
    FOREIGN KEY ("previous_attestation_id") REFERENCES "attestations"("id") ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 8. Settlement — where the captured fee went
--
-- The customer side of the double entry is the existing credit ledger: the
-- hold is captured as a SERVICE_CHARGE debit on the user's own account, by the
-- same CreditHoldService every paid check uses. These two tables are the other
-- side: one settlement header per approved request, and exactly two revenue
-- entries under it — the institution's share and PalCert's commission — whose
-- sum must equal the captured amount. A deferred constraint trigger checks
-- that at commit, so a settlement cannot exist half-written.
-- ---------------------------------------------------------------------------
CREATE TABLE "attestation_settlements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "gross_minor" BIGINT NOT NULL,
    "platform_commission_bps" INTEGER NOT NULL,
    "platform_fee_minor" BIGINT NOT NULL,
    "institution_net_minor" BIGINT NOT NULL,
    "hold_id" UUID NOT NULL,
    "capture_entry_id" UUID NOT NULL,
    "settled_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attestation_settlements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attestation_settlements_request_key" UNIQUE ("request_id"),
    CONSTRAINT "attestation_settlements_capture_key" UNIQUE ("capture_entry_id"),
    CONSTRAINT "attestation_settlements_amounts" CHECK (
        "gross_minor" > 0 AND "platform_fee_minor" >= 0 AND "institution_net_minor" >= 0
        AND "gross_minor" = "platform_fee_minor" + "institution_net_minor"
        AND "platform_commission_bps" BETWEEN 0 AND 10000
        AND "currency" ~ '^[A-Z]{3}$')
);

CREATE INDEX "attestation_settlements_org_idx"
    ON "attestation_settlements"("organization_id", "settled_at", "id");

ALTER TABLE "attestation_settlements"
    ADD CONSTRAINT "attestation_settlements_request_owner_fkey"
    FOREIGN KEY ("request_id", "owner_user_id")
    REFERENCES "attestation_requests"("id", "owner_user_id") ON DELETE RESTRICT;
ALTER TABLE "attestation_settlements"
    ADD CONSTRAINT "attestation_settlements_request_org_fkey"
    FOREIGN KEY ("request_id", "organization_id")
    REFERENCES "attestation_requests"("id", "organization_id") ON DELETE RESTRICT;
ALTER TABLE "attestation_settlements"
    ADD CONSTRAINT "attestation_settlements_hold_fkey"
    FOREIGN KEY ("hold_id") REFERENCES "credit_holds"("id") ON DELETE RESTRICT;
ALTER TABLE "attestation_settlements"
    ADD CONSTRAINT "attestation_settlements_capture_fkey"
    FOREIGN KEY ("capture_entry_id") REFERENCES "credit_ledger_entries"("id") ON DELETE RESTRICT;

CREATE TABLE "attestation_revenue_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "settlement_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    -- Whose revenue this is: the institution's share, or PalCert's commission.
    "account" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attestation_revenue_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attestation_revenue_entries_one_per_account" UNIQUE ("settlement_id", "account"),
    CONSTRAINT "attestation_revenue_entries_account_known" CHECK (
        "account" IN ('INSTITUTION', 'PLATFORM_COMMISSION')),
    CONSTRAINT "attestation_revenue_entries_amount" CHECK ("amount_minor" >= 0)
);

CREATE INDEX "attestation_revenue_entries_org_idx"
    ON "attestation_revenue_entries"("organization_id", "account", "created_at");

ALTER TABLE "attestation_revenue_entries"
    ADD CONSTRAINT "attestation_revenue_entries_settlement_fkey"
    FOREIGN KEY ("settlement_id") REFERENCES "attestation_settlements"("id") ON DELETE RESTRICT;
ALTER TABLE "attestation_revenue_entries"
    ADD CONSTRAINT "attestation_revenue_entries_request_owner_fkey"
    FOREIGN KEY ("request_id", "owner_user_id")
    REFERENCES "attestation_requests"("id", "owner_user_id") ON DELETE RESTRICT;
ALTER TABLE "attestation_revenue_entries"
    ADD CONSTRAINT "attestation_revenue_entries_request_org_fkey"
    FOREIGN KEY ("request_id", "organization_id")
    REFERENCES "attestation_requests"("id", "organization_id") ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 9. Expiry reminders
--
-- One row per (attestation, stage), unique, so a retried sweep, two workers
-- racing, or a replayed job still records — and therefore notifies — once.
-- ---------------------------------------------------------------------------
CREATE TABLE "attestation_reminders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "attestation_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    -- Days before expiry; 0 is expiry itself.
    "stage" INTEGER NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attestation_reminders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attestation_reminders_identity" UNIQUE ("attestation_id", "stage"),
    CONSTRAINT "attestation_reminders_stage" CHECK ("stage" BETWEEN 0 AND 365)
);

ALTER TABLE "attestation_reminders"
    ADD CONSTRAINT "attestation_reminders_attestation_fkey"
    FOREIGN KEY ("attestation_id") REFERENCES "attestations"("id") ON DELETE RESTRICT;
ALTER TABLE "attestation_reminders"
    ADD CONSTRAINT "attestation_reminders_request_owner_fkey"
    FOREIGN KEY ("request_id", "owner_user_id")
    REFERENCES "attestation_requests"("id", "owner_user_id") ON DELETE RESTRICT;
ALTER TABLE "attestation_reminders"
    ADD CONSTRAINT "attestation_reminders_request_org_fkey"
    FOREIGN KEY ("request_id", "organization_id")
    REFERENCES "attestation_requests"("id", "organization_id") ON DELETE RESTRICT;

-- =============================================================================
-- 10. Integrity triggers
-- =============================================================================

-- Append-only history. Corrections are new rows, never edits.
CREATE OR REPLACE FUNCTION attestation_history_is_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER "attestation_request_events_append_only"
    BEFORE UPDATE OR DELETE ON "attestation_request_events"
    FOR EACH ROW EXECUTE FUNCTION attestation_history_is_append_only();
CREATE TRIGGER "attestation_settlements_append_only"
    BEFORE UPDATE OR DELETE ON "attestation_settlements"
    FOR EACH ROW EXECUTE FUNCTION attestation_history_is_append_only();
CREATE TRIGGER "attestation_revenue_entries_append_only"
    BEFORE UPDATE OR DELETE ON "attestation_revenue_entries"
    FOR EACH ROW EXECUTE FUNCTION attestation_history_is_append_only();
CREATE TRIGGER "attestation_reminders_append_only"
    BEFORE UPDATE OR DELETE ON "attestation_reminders"
    FOR EACH ROW EXECUTE FUNCTION attestation_history_is_append_only();
CREATE TRIGGER "organization_attestation_commissions_append_only"
    BEFORE UPDATE OR DELETE ON "organization_attestation_commissions"
    FOR EACH ROW EXECUTE FUNCTION attestation_history_is_append_only();

-- A settlement must copy the request's own price snapshot, not a figure the
-- settling code computed: the snapshot is the agreement the user submitted
-- under.
CREATE OR REPLACE FUNCTION attestation_settlements_match_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    request_row "attestation_requests"%ROWTYPE;
BEGIN
    SELECT * INTO request_row FROM "attestation_requests" WHERE "id" = NEW."request_id";
    IF request_row."status" <> 'APPROVED' THEN
        RAISE EXCEPTION 'only an approved request is settled (request % is %)',
            NEW."request_id", request_row."status"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF request_row."gross_fee_minor" IS DISTINCT FROM NEW."gross_minor"
        OR request_row."currency" IS DISTINCT FROM NEW."currency"
        OR request_row."platform_commission_bps" IS DISTINCT FROM NEW."platform_commission_bps"
        OR request_row."platform_fee_minor" IS DISTINCT FROM NEW."platform_fee_minor"
        OR request_row."institution_net_minor" IS DISTINCT FROM NEW."institution_net_minor"
        OR request_row."hold_id" IS DISTINCT FROM NEW."hold_id"
    THEN
        RAISE EXCEPTION 'settlement for request % does not match its price snapshot', NEW."request_id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "attestation_settlements_match_snapshot"
    BEFORE INSERT ON "attestation_settlements"
    FOR EACH ROW EXECUTE FUNCTION attestation_settlements_match_snapshot();

-- Exactly two revenue entries, summing to the gross, by commit time.
CREATE OR REPLACE FUNCTION attestation_settlements_balanced() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    settlement "attestation_settlements"%ROWTYPE;
    v_count integer;
    v_institution bigint;
    v_platform bigint;
BEGIN
    SELECT * INTO settlement FROM "attestation_settlements" WHERE "id" = NEW."id";
    SELECT count(*),
           coalesce(sum("amount_minor") FILTER (WHERE "account" = 'INSTITUTION'), -1),
           coalesce(sum("amount_minor") FILTER (WHERE "account" = 'PLATFORM_COMMISSION'), -1)
      INTO v_count, v_institution, v_platform
      FROM "attestation_revenue_entries"
     WHERE "settlement_id" = NEW."id" AND "currency" = settlement."currency";
    IF v_count <> 2
        OR v_institution <> settlement."institution_net_minor"
        OR v_platform <> settlement."platform_fee_minor"
    THEN
        RAISE EXCEPTION 'attestation settlement % is not balanced by its revenue entries', NEW."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "attestation_settlements_balanced"
    AFTER INSERT ON "attestation_settlements"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION attestation_settlements_balanced();

-- ---------------------------------------------------------------------------
-- The request guard: identity, price, transitions and who may change what.
--
-- Keyed on context rather than identity, as Phase 14's is: a caller with an
-- organization scope is acting as the institution even if the same person
-- happens to own the request.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION attestation_requests_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    v_org_context boolean := app_current_organization() IS NOT NULL
        AND app_current_organization() = OLD."organization_id";
    v_owner_context boolean := app_current_organization() IS NULL
        AND app_current_user_id() = OLD."owner_user_id";
    v_admin boolean := app_is_platform_admin();
    v_edge text := OLD."status"::text || '->' || NEW."status"::text;
BEGIN
    IF NEW."id" <> OLD."id"
        OR NEW."owner_user_id" <> OLD."owner_user_id"
        OR NEW."organization_id" <> OLD."organization_id"
        OR NEW."attestation_type_id" <> OLD."attestation_type_id"
        OR NEW."previous_attestation_id" IS DISTINCT FROM OLD."previous_attestation_id"
        OR NEW."created_at" <> OLD."created_at"
        OR NEW."organization_name" <> OLD."organization_name"
        OR NEW."type_name_en" <> OLD."type_name_en"
        OR NEW."type_name_ar" <> OLD."type_name_ar"
    THEN
        RAISE EXCEPTION 'attestation_request % identity is immutable', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- The price snapshot is written once, at submission, and never again.
    IF OLD."priced_at" IS NOT NULL AND (
        NEW."priced_at" IS DISTINCT FROM OLD."priced_at"
        OR NEW."currency" IS DISTINCT FROM OLD."currency"
        OR NEW."gross_fee_minor" IS DISTINCT FROM OLD."gross_fee_minor"
        OR NEW."platform_commission_bps" IS DISTINCT FROM OLD."platform_commission_bps"
        OR NEW."platform_fee_minor" IS DISTINCT FROM OLD."platform_fee_minor"
        OR NEW."institution_net_minor" IS DISTINCT FROM OLD."institution_net_minor"
        OR NEW."commission_id" IS DISTINCT FROM OLD."commission_id"
        OR NEW."default_validity_days" IS DISTINCT FROM OLD."default_validity_days"
        OR NEW."allow_no_expiry" IS DISTINCT FROM OLD."allow_no_expiry"
        OR NEW."reviewer_may_override_validity" IS DISTINCT FROM OLD."reviewer_may_override_validity"
        OR NEW."reminder_days" IS DISTINCT FROM OLD."reminder_days")
    THEN
        RAISE EXCEPTION 'attestation_request % price and policy snapshot is immutable', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- A hold, once attached, stays the request's hold.
    IF OLD."hold_id" IS NOT NULL AND NEW."hold_id" IS DISTINCT FROM OLD."hold_id" THEN
        RAISE EXCEPTION 'attestation_request % hold is immutable', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- Status: the transition table, and which side may take each edge.
    IF NEW."status" <> OLD."status" THEN
        IF v_edge IN ('DRAFT->SUBMITTED', 'DRAFT->CANCELLED', 'SUBMITTED->CANCELLED',
                      'NEEDS_INFORMATION->SUBMITTED') THEN
            IF NOT (v_owner_context OR v_admin) THEN
                RAISE EXCEPTION 'only the owner may take attestation_request % from % to %',
                    OLD."id", OLD."status", NEW."status"
                    USING ERRCODE = 'insufficient_privilege';
            END IF;
        ELSIF v_edge IN ('SUBMITTED->IN_REVIEW', 'IN_REVIEW->NEEDS_INFORMATION',
                         'IN_REVIEW->APPROVED', 'IN_REVIEW->REJECTED',
                         'NEEDS_INFORMATION->REJECTED') THEN
            IF NOT (v_org_context OR v_admin) THEN
                RAISE EXCEPTION 'only the institution may take attestation_request % from % to %',
                    OLD."id", OLD."status", NEW."status"
                    USING ERRCODE = 'insufficient_privilege';
            END IF;
        ELSE
            RAISE EXCEPTION 'attestation_request % may not go from % to %',
                OLD."id", OLD."status", NEW."status"
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- Submitted metadata is the owner's, and only while the owner may edit it.
    IF (NEW."certificate_title" IS DISTINCT FROM OLD."certificate_title"
        OR NEW."certificate_type" IS DISTINCT FROM OLD."certificate_type"
        OR NEW."issuing_organization" IS DISTINCT FROM OLD."issuing_organization"
        OR NEW."issue_date" IS DISTINCT FROM OLD."issue_date"
        OR NEW."reference_number" IS DISTINCT FROM OLD."reference_number"
        OR NEW."recipient_name" IS DISTINCT FROM OLD."recipient_name"
        OR NEW."description" IS DISTINCT FROM OLD."description"
        OR NEW."notes_for_reviewer" IS DISTINCT FROM OLD."notes_for_reviewer"
        OR NEW."current_artifact_id" IS DISTINCT FROM OLD."current_artifact_id")
    THEN
        IF NOT v_owner_context THEN
            RAISE EXCEPTION 'only the owner may change what attestation_request % describes', OLD."id"
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF OLD."status" NOT IN ('DRAFT', 'NEEDS_INFORMATION') THEN
            RAISE EXCEPTION 'attestation_request % is % and its details are frozen',
                OLD."id", OLD."status"
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- Review columns are the institution's.
    IF (NEW."assigned_reviewer_user_id" IS DISTINCT FROM OLD."assigned_reviewer_user_id"
        OR NEW."rejection_reason" IS DISTINCT FROM OLD."rejection_reason"
        OR NEW."review_started_at" IS DISTINCT FROM OLD."review_started_at"
        OR NEW."decided_at" IS DISTINCT FROM OLD."decided_at")
        AND NOT (v_org_context OR v_admin)
    THEN
        RAISE EXCEPTION 'only the institution may record a review on attestation_request %', OLD."id"
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- A decided request is history. Only the payment projection may still move,
    -- and only PalCert's settlement path moves it.
    IF OLD."status" IN ('APPROVED', 'REJECTED', 'CANCELLED') THEN
        IF NEW."status" <> OLD."status"
            OR NEW."rejection_reason" IS DISTINCT FROM OLD."rejection_reason"
            OR NEW."decided_at" IS DISTINCT FROM OLD."decided_at"
            OR NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at"
            OR NEW."assigned_reviewer_user_id" IS DISTINCT FROM OLD."assigned_reviewer_user_id"
            OR NEW."open_information_request" IS DISTINCT FROM OLD."open_information_request"
        THEN
            RAISE EXCEPTION 'attestation_request % is % and cannot change', OLD."id", OLD."status"
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- Payment moves forward only.
    IF NEW."payment_status" <> OLD."payment_status" THEN
        IF NOT ((OLD."payment_status" = 'UNPAID' AND NEW."payment_status" IN ('RESERVED', 'NOT_REQUIRED'))
             OR (OLD."payment_status" = 'RESERVED' AND NEW."payment_status" IN ('SETTLED', 'RELEASED')))
        THEN
            RAISE EXCEPTION 'attestation_request % payment may not go from % to %',
                OLD."id", OLD."payment_status", NEW."payment_status"
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "attestation_requests_guard_trigger"
    BEFORE UPDATE ON "attestation_requests"
    FOR EACH ROW EXECUTE FUNCTION attestation_requests_guard();

-- A request is born a draft, by its owner.
CREATE OR REPLACE FUNCTION attestation_requests_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW."status" <> 'DRAFT' OR NEW."priced_at" IS NOT NULL OR NEW."payment_status" <> 'UNPAID' THEN
        RAISE EXCEPTION 'an attestation request starts as an unpriced DRAFT'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "attestation_requests_insert_guard_trigger"
    BEFORE INSERT ON "attestation_requests"
    FOR EACH ROW EXECUTE FUNCTION attestation_requests_insert_guard();

-- The artifact guard: identity frozen once READY; purge only for a file no
-- attestation names.
CREATE OR REPLACE FUNCTION attestation_artifacts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW."id" <> OLD."id"
        OR NEW."request_id" <> OLD."request_id"
        OR NEW."owner_user_id" <> OLD."owner_user_id"
        OR NEW."organization_id" <> OLD."organization_id"
        OR NEW."quarantine_object_key" <> OLD."quarantine_object_key"
        OR NEW."expected_format" <> OLD."expected_format"
        OR NEW."declared_size_bytes" <> OLD."declared_size_bytes"
        OR NEW."max_file_bytes" <> OLD."max_file_bytes"
        OR NEW."original_filename" <> OLD."original_filename"
    THEN
        RAISE EXCEPTION 'attestation_artifact % identity is immutable', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF OLD."status" = 'READY' AND (
        NEW."status" <> 'READY'
        OR NEW."sha256" IS DISTINCT FROM OLD."sha256"
        OR NEW."size_bytes" IS DISTINCT FROM OLD."size_bytes"
        OR NEW."detected_format" IS DISTINCT FROM OLD."detected_format"
        OR NEW."detected_mime_type" IS DISTINCT FROM OLD."detected_mime_type"
        OR NEW."clean_object_key" IS DISTINCT FROM OLD."clean_object_key"
        OR NEW."clean_object_version_id" IS DISTINCT FROM OLD."clean_object_version_id"
        OR NEW."clean_object_etag" IS DISTINCT FROM OLD."clean_object_etag")
    THEN
        RAISE EXCEPTION 'attestation_artifact % is READY and its bytes are frozen', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF NEW."purged_at" IS NOT NULL AND OLD."purged_at" IS NULL
        AND EXISTS (SELECT 1 FROM "attestations" a WHERE a."artifact_id" = OLD."id")
    THEN
        RAISE EXCEPTION 'attestation_artifact % substantiates an attestation and is retained', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "attestation_artifacts_guard_trigger"
    BEFORE UPDATE ON "attestation_artifacts"
    FOR EACH ROW EXECUTE FUNCTION attestation_artifacts_guard();

-- The attestation guard: everything is frozen except a single revocation.
CREATE OR REPLACE FUNCTION attestations_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF (to_jsonb(NEW) - ARRAY['revoked_at', 'revoked_by_user_id', 'revocation_reason'])
        IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['revoked_at', 'revoked_by_user_id', 'revocation_reason'])
    THEN
        RAISE EXCEPTION 'attestation % is immutable; correct it by revoking and re-attesting', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD."revoked_at" IS NOT NULL THEN
        RAISE EXCEPTION 'attestation % is already revoked', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "attestations_guard_trigger"
    BEFORE UPDATE ON "attestations"
    FOR EACH ROW EXECUTE FUNCTION attestations_guard();

-- The attestation must describe the request's own current, READY artifact,
-- by its measured digest, and only an APPROVED request has one.
CREATE OR REPLACE FUNCTION attestations_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    request_row "attestation_requests"%ROWTYPE;
    artifact_row "attestation_artifacts"%ROWTYPE;
BEGIN
    SELECT * INTO request_row FROM "attestation_requests" WHERE "id" = NEW."request_id";
    SELECT * INTO artifact_row FROM "attestation_artifacts" WHERE "id" = NEW."artifact_id";
    IF request_row."status" <> 'APPROVED' THEN
        RAISE EXCEPTION 'attestation for request % requires an APPROVED request', NEW."request_id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF request_row."current_artifact_id" IS DISTINCT FROM NEW."artifact_id"
        OR artifact_row."status" <> 'READY'
        OR artifact_row."sha256" IS DISTINCT FROM NEW."artifact_sha256"
        OR artifact_row."size_bytes" IS DISTINCT FROM NEW."artifact_size_bytes"
        OR artifact_row."detected_mime_type" IS DISTINCT FROM NEW."artifact_mime_type"
        OR artifact_row."clean_object_key" IS DISTINCT FROM NEW."artifact_clean_object_key"
        OR artifact_row."clean_object_version_id" IS DISTINCT FROM NEW."artifact_clean_object_version_id"
    THEN
        RAISE EXCEPTION 'attestation for request % must describe its current READY artifact exactly',
            NEW."request_id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."revoked_at" IS NOT NULL THEN
        RAISE EXCEPTION 'an attestation cannot be born revoked'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "attestations_insert_guard_trigger"
    BEFORE INSERT ON "attestations"
    FOR EACH ROW EXECUTE FUNCTION attestations_insert_guard();

-- =============================================================================
-- 11. Row-level security
--
--   attestation_types, organization_attestation_commissions  TENANT_SCOPED
--   everything else                                          DUAL_PARTY_SCOPED
--
-- A user reads types only through the SECURITY DEFINER catalogue below, and
-- never reads a commission at all.
-- =============================================================================
ALTER TABLE "attestation_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attestation_types" FORCE ROW LEVEL SECURITY;
CREATE POLICY "attestation_types_tenant" ON "attestation_types" FOR ALL
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin() OR "organization_id" = app_current_organization());

ALTER TABLE "organization_attestation_commissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_attestation_commissions" FORCE ROW LEVEL SECURITY;
-- The institution may see the rate it is charged; only PalCert sets one.
CREATE POLICY "organization_attestation_commissions_read" ON "organization_attestation_commissions"
    FOR SELECT USING (app_is_platform_admin() OR "organization_id" = app_current_organization());
CREATE POLICY "organization_attestation_commissions_insert" ON "organization_attestation_commissions"
    FOR INSERT WITH CHECK (app_is_platform_admin());
CREATE POLICY "organization_attestation_commissions_update" ON "organization_attestation_commissions"
    FOR UPDATE USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());
CREATE POLICY "organization_attestation_commissions_delete" ON "organization_attestation_commissions"
    FOR DELETE USING (app_is_platform_admin());

-- Requests: both parties read; the owner creates; either side updates, with
-- the guard above deciding which columns.
ALTER TABLE "attestation_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attestation_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "attestation_requests_read" ON "attestation_requests" FOR SELECT
    USING (app_is_platform_admin()
        OR "owner_user_id" = app_current_user_id()
        -- A draft is not the institution's to see.
        OR ("organization_id" = app_current_organization() AND "status" <> 'DRAFT'));
CREATE POLICY "attestation_requests_insert" ON "attestation_requests" FOR INSERT
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());
CREATE POLICY "attestation_requests_update" ON "attestation_requests" FOR UPDATE
    USING (app_is_platform_admin()
        OR "owner_user_id" = app_current_user_id()
        OR ("organization_id" = app_current_organization() AND "status" <> 'DRAFT'))
    WITH CHECK (app_is_platform_admin()
        OR "owner_user_id" = app_current_user_id()
        OR "organization_id" = app_current_organization());

ALTER TABLE "attestation_artifacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attestation_artifacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "attestation_artifacts_read" ON "attestation_artifacts" FOR SELECT
    USING (app_is_platform_admin()
        OR "owner_user_id" = app_current_user_id()
        OR ("organization_id" = app_current_organization()
            AND EXISTS (SELECT 1 FROM "attestation_requests" r
                        WHERE r."id" = "request_id" AND r."status" <> 'DRAFT')));
CREATE POLICY "attestation_artifacts_insert" ON "attestation_artifacts" FOR INSERT
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());
-- The institution never writes the user's file.
CREATE POLICY "attestation_artifacts_update" ON "attestation_artifacts" FOR UPDATE
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "attestation_request_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attestation_request_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "attestation_request_events_read" ON "attestation_request_events" FOR SELECT
    USING (app_is_platform_admin()
        OR "owner_user_id" = app_current_user_id()
        OR "organization_id" = app_current_organization());
-- Each side writes only as itself, and PalCert's own events only from its
-- elevated system path.
CREATE POLICY "attestation_request_events_insert" ON "attestation_request_events" FOR INSERT
    WITH CHECK (app_is_platform_admin()
        OR ("actor_side" = 'OWNER' AND app_current_organization() IS NULL
            AND "owner_user_id" = app_current_user_id() AND "actor_user_id" = app_current_user_id())
        OR ("actor_side" = 'ORGANIZATION' AND "organization_id" = app_current_organization()
            AND "actor_user_id" = app_current_user_id()));

ALTER TABLE "attestations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attestations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "attestations_read" ON "attestations" FOR SELECT
    USING (app_is_platform_admin()
        OR "owner_user_id" = app_current_user_id()
        OR "organization_id" = app_current_organization());
-- Only the approving institution, as the named approver.
CREATE POLICY "attestations_insert" ON "attestations" FOR INSERT
    WITH CHECK (app_is_platform_admin()
        OR ("organization_id" = app_current_organization()
            AND "approved_by_user_id" = app_current_user_id()));
-- Revocation: the institution, as the named revoker.
CREATE POLICY "attestations_update" ON "attestations" FOR UPDATE
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin()
        OR ("organization_id" = app_current_organization()
            AND "revoked_by_user_id" = app_current_user_id()));

ALTER TABLE "attestation_settlements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attestation_settlements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "attestation_settlements_read" ON "attestation_settlements" FOR SELECT
    USING (app_is_platform_admin()
        OR "owner_user_id" = app_current_user_id()
        OR "organization_id" = app_current_organization());
CREATE POLICY "attestation_settlements_insert" ON "attestation_settlements" FOR INSERT
    WITH CHECK (app_is_platform_admin());

ALTER TABLE "attestation_revenue_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attestation_revenue_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "attestation_revenue_entries_read" ON "attestation_revenue_entries" FOR SELECT
    USING (app_is_platform_admin()
        OR "owner_user_id" = app_current_user_id()
        OR "organization_id" = app_current_organization());
CREATE POLICY "attestation_revenue_entries_insert" ON "attestation_revenue_entries" FOR INSERT
    WITH CHECK (app_is_platform_admin());

ALTER TABLE "attestation_reminders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attestation_reminders" FORCE ROW LEVEL SECURITY;
CREATE POLICY "attestation_reminders_read" ON "attestation_reminders" FOR SELECT
    USING (app_is_platform_admin()
        OR "owner_user_id" = app_current_user_id()
        OR "organization_id" = app_current_organization());
CREATE POLICY "attestation_reminders_insert" ON "attestation_reminders" FOR INSERT
    WITH CHECK (app_is_platform_admin());

-- Table privileges. Nothing an attestation depends on may be hard-deleted by
-- the application role; history tables are not even updatable.
GRANT SELECT, INSERT, UPDATE, DELETE ON "attestation_types" TO "palcert_app";
GRANT SELECT, INSERT ON "organization_attestation_commissions" TO "palcert_app";
REVOKE UPDATE, DELETE, TRUNCATE ON "organization_attestation_commissions" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "attestation_requests" TO "palcert_app";
REVOKE DELETE, TRUNCATE ON "attestation_requests" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "attestation_artifacts" TO "palcert_app";
REVOKE DELETE, TRUNCATE ON "attestation_artifacts" FROM "palcert_app";
GRANT SELECT, INSERT ON "attestation_request_events" TO "palcert_app";
REVOKE UPDATE, DELETE, TRUNCATE ON "attestation_request_events" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "attestations" TO "palcert_app";
REVOKE DELETE, TRUNCATE ON "attestations" FROM "palcert_app";
GRANT SELECT, INSERT ON "attestation_settlements" TO "palcert_app";
REVOKE UPDATE, DELETE, TRUNCATE ON "attestation_settlements" FROM "palcert_app";
GRANT SELECT, INSERT ON "attestation_revenue_entries" TO "palcert_app";
REVOKE UPDATE, DELETE, TRUNCATE ON "attestation_revenue_entries" FROM "palcert_app";
GRANT SELECT, INSERT ON "attestation_reminders" TO "palcert_app";
REVOKE UPDATE, DELETE, TRUNCATE ON "attestation_reminders" FROM "palcert_app";

INSERT INTO "table_isolation_classification" ("table_name", "classification", "tenant_column", "notes")
VALUES
    ('attestation_types', 'TENANT_SCOPED', 'organization_id',
     'An institution''s attestation types, fees and policies. Users see enabled types only through the catalogue functions.'),
    ('organization_attestation_commissions', 'TENANT_SCOPED', 'organization_id',
     'PalCert''s commission on one institution''s attestation fees, with history. Written only by PalCert staff; readable by the institution.'),
    ('attestation_requests', 'DUAL_PARTY_SCOPED', 'owner_user_id',
     'One user''s request that one institution attest a certificate. Owner and institution read it; a draft is the owner''s alone.'),
    ('attestation_artifacts', 'DUAL_PARTY_SCOPED', 'owner_user_id',
     'The exact submitted certificate bytes, by digest. Written only on the owner''s side; frozen once READY.'),
    ('attestation_request_events', 'DUAL_PARTY_SCOPED', 'owner_user_id',
     'Append-only request history. Each side writes only as itself.'),
    ('attestations', 'DUAL_PARTY_SCOPED', 'owner_user_id',
     'The immutable attestation record. Written by the approving reviewer; afterwards only a single revocation.'),
    ('attestation_settlements', 'DUAL_PARTY_SCOPED', 'owner_user_id',
     'Where one approved request''s captured fee went. Append-only; written only by PalCert''s settlement job.'),
    ('attestation_revenue_entries', 'DUAL_PARTY_SCOPED', 'owner_user_id',
     'The institution''s share and PalCert''s commission of one settlement. Append-only; must sum to the capture.'),
    ('attestation_reminders', 'DUAL_PARTY_SCOPED', 'owner_user_id',
     'One expiry reminder stage per attestation, recorded once.')
ON CONFLICT ("table_name") DO UPDATE
    SET "classification" = EXCLUDED."classification",
        "tenant_column" = EXCLUDED."tenant_column",
        "notes" = EXCLUDED."notes";

-- =============================================================================
-- 12. Narrow SECURITY DEFINER doors
--
-- Each returns exactly the columns its caller needs and nothing else. None
-- takes a permission code, a user id to impersonate, or a table name.
-- =============================================================================

-- Institutions a user may ask: active, verified, with an enabled type.
CREATE OR REPLACE FUNCTION app_attestation_catalogue_organizations()
RETURNS TABLE ("organization_id" uuid, "display_name" text, "slug" text, "type_count" bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT o."id", o."display_name", o."slug", count(t."id")
      FROM "organizations" o
      JOIN "attestation_types" t ON t."organization_id" = o."id" AND t."enabled"
     WHERE o."status" = 'ACTIVE' AND o."verification_status" = 'VERIFIED'
     GROUP BY o."id", o."display_name", o."slug"
     ORDER BY o."display_name", o."id";
$$;

-- The enabled types of one eligible institution, public fields only.
CREATE OR REPLACE FUNCTION app_attestation_catalogue_types(p_organization_id uuid)
RETURNS TABLE (
    "id" uuid, "organization_id" uuid, "organization_name" text,
    "name_en" text, "name_ar" text,
    "description_en" text, "description_ar" text,
    "instructions_en" text, "instructions_ar" text,
    "fee_minor" bigint, "currency" text,
    "default_validity_days" integer, "allow_no_expiry" boolean,
    "reviewer_may_override_validity" boolean,
    "required_fields" text[], "allowed_formats" text[], "max_file_bytes" integer,
    "reminder_days" integer[]
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT t."id", t."organization_id", o."display_name",
           t."name_en", t."name_ar", t."description_en", t."description_ar",
           t."instructions_en", t."instructions_ar",
           t."fee_minor", t."currency",
           t."default_validity_days", t."allow_no_expiry", t."reviewer_may_override_validity",
           t."required_fields", t."allowed_formats"::text[], t."max_file_bytes", t."reminder_days"
      FROM "attestation_types" t
      JOIN "organizations" o ON o."id" = t."organization_id"
     WHERE t."organization_id" = p_organization_id
       AND t."enabled"
       AND o."status" = 'ACTIVE' AND o."verification_status" = 'VERIFIED'
     ORDER BY t."name_en", t."id";
$$;

-- One type, whatever its state, for a user acting on their own request.
-- Returns the organization's eligibility so the caller can refuse with a
-- precise reason rather than a bare not-found.
CREATE OR REPLACE FUNCTION app_attestation_type_offer(p_type_id uuid)
RETURNS TABLE (
    "id" uuid, "organization_id" uuid, "organization_name" text,
    "organization_eligible" boolean, "enabled" boolean,
    "name_en" text, "name_ar" text,
    "fee_minor" bigint, "currency" text,
    "default_validity_days" integer, "allow_no_expiry" boolean,
    "reviewer_may_override_validity" boolean,
    "required_fields" text[], "allowed_formats" text[], "max_file_bytes" integer,
    "reminder_days" integer[]
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT t."id", t."organization_id", o."display_name",
           (o."status" = 'ACTIVE' AND o."verification_status" = 'VERIFIED'),
           t."enabled", t."name_en", t."name_ar",
           t."fee_minor", t."currency",
           t."default_validity_days", t."allow_no_expiry", t."reviewer_may_override_validity",
           t."required_fields", t."allowed_formats"::text[], t."max_file_bytes", t."reminder_days"
      FROM "attestation_types" t
      JOIN "organizations" o ON o."id" = t."organization_id"
     WHERE t."id" = p_type_id
       AND app_current_user_id() IS NOT NULL;
$$;

-- The commission in force for one institution at one instant. Internal: the
-- API never shows a user this number.
CREATE OR REPLACE FUNCTION app_attestation_commission_at(p_organization_id uuid, p_at timestamptz)
RETURNS TABLE ("commission_id" uuid, "commission_bps" integer)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT c."id", c."commission_bps"
      FROM "organization_attestation_commissions" c
     WHERE c."organization_id" = p_organization_id
       AND c."effective_from" <= p_at
     ORDER BY c."effective_from" DESC, c."created_at" DESC, c."id" DESC
     LIMIT 1;
$$;

-- Who asked, for the institution that was asked, and only for requests that
-- are not drafts.
CREATE OR REPLACE FUNCTION app_attestation_request_owners(p_request_ids uuid[])
RETURNS TABLE ("request_id" uuid, "user_id" uuid, "display_name" text, "email" text)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT r."id", u."id", u."display_name", u."email"
      FROM "attestation_requests" r
      JOIN "users" u ON u."id" = r."owner_user_id"
     WHERE r."id" = ANY(p_request_ids)
       AND app_current_organization() IS NOT NULL
       AND r."organization_id" = app_current_organization()
       AND r."status" <> 'DRAFT';
$$;

-- Display names of the caller's own organization's members, for "assigned to".
CREATE OR REPLACE FUNCTION app_attestation_member_names(p_user_ids uuid[])
RETURNS TABLE ("user_id" uuid, "display_name" text)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT u."id", u."display_name"
      FROM "users" u
      JOIN "organization_memberships" m ON m."user_id" = u."id"
     WHERE u."id" = ANY(p_user_ids)
       AND app_current_organization() IS NOT NULL
       AND m."organization_id" = app_current_organization();
$$;

-- Public verification, by the token's hash. The only columns a verifier may
-- learn; the organization's verification is read as it stands *now*.
CREATE OR REPLACE FUNCTION app_public_attestation(p_token_hash text)
RETURNS TABLE (
    "reference" text,
    "organization_name" text,
    "organization_verified" boolean,
    "type_name_en" text, "type_name_ar" text,
    "certificate_title" text, "certificate_type" text,
    "holder_name" text, "issuing_organization" text,
    "issue_date" date, "reference_number" text,
    "valid_from" timestamptz, "valid_until" timestamptz,
    "approved_at" timestamptz, "revoked_at" timestamptz,
    "artifact_sha256" text, "artifact_mime_type" text, "attestation_hash" text
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT a."reference", a."organization_name",
           (o."status" = 'ACTIVE' AND o."verification_status" = 'VERIFIED'),
           a."type_name_en", a."type_name_ar",
           a."certificate_title", a."certificate_type",
           CASE WHEN a."holder_name_public" THEN a."holder_name" END,
           a."issuing_organization", a."issue_date",
           CASE WHEN a."reference_number_public" THEN a."reference_number" END,
           a."valid_from", a."valid_until", a."approved_at", a."revoked_at",
           a."artifact_sha256", a."artifact_mime_type", a."attestation_hash"
      FROM "attestations" a
      JOIN "organizations" o ON o."id" = a."organization_id"
     WHERE a."public_token_hash" = p_token_hash;
$$;

-- "Is there a valid attestation for exactly these bytes?" Only unrevoked,
-- unexpired records, and only the same public columns.
CREATE OR REPLACE FUNCTION app_public_attestations_by_artifact(p_sha256 text, p_at timestamptz)
RETURNS TABLE (
    "reference" text,
    "organization_name" text,
    "organization_verified" boolean,
    "type_name_en" text, "type_name_ar" text,
    "certificate_title" text, "certificate_type" text,
    "holder_name" text, "issuing_organization" text,
    "issue_date" date, "reference_number" text,
    "valid_from" timestamptz, "valid_until" timestamptz,
    "approved_at" timestamptz, "revoked_at" timestamptz,
    "artifact_sha256" text, "artifact_mime_type" text, "attestation_hash" text
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT a."reference", a."organization_name",
           (o."status" = 'ACTIVE' AND o."verification_status" = 'VERIFIED'),
           a."type_name_en", a."type_name_ar",
           a."certificate_title", a."certificate_type",
           CASE WHEN a."holder_name_public" THEN a."holder_name" END,
           a."issuing_organization", a."issue_date",
           CASE WHEN a."reference_number_public" THEN a."reference_number" END,
           a."valid_from", a."valid_until", a."approved_at", a."revoked_at",
           a."artifact_sha256", a."artifact_mime_type", a."attestation_hash"
      FROM "attestations" a
      JOIN "organizations" o ON o."id" = a."organization_id"
     WHERE a."artifact_sha256" = p_sha256
       AND a."revoked_at" IS NULL
       AND (a."valid_until" IS NULL OR a."valid_until" > p_at)
     ORDER BY a."approved_at" DESC
     LIMIT 10;
$$;

-- =============================================================================
-- 13. Notifications — the Phase 16 pipeline, extended
-- =============================================================================

-- Which source rows may carry which event types, and what they are about.
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
);

ALTER TABLE "domain_events" DROP CONSTRAINT "domain_events_aggregate_matches_type";
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_aggregate_matches_type" CHECK (
    ("event_type" IN ('CERTIFICATE_ISSUED', 'CERTIFICATE_REVOKED')
        AND "aggregate_type" = 'COMPLIANCE_CERTIFICATE')
    OR ("event_type"::text LIKE 'ATTESTATION\_%' AND "aggregate_type" = 'ATTESTATION_REQUEST')
    OR ("event_type" NOT IN ('CERTIFICATE_ISSUED', 'CERTIFICATE_REVOKED')
        AND "event_type"::text NOT LIKE 'ATTESTATION\_%'
        AND "aggregate_type" = 'OFFICIAL_SUBMISSION')
);

-- An attestation's revocation email cannot be switched off either.
ALTER TABLE "notification_preferences" DROP CONSTRAINT "notification_preferences_mandatory_email_stays_on";
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_mandatory_email_stays_on"
    CHECK ("email_enabled" OR "notification_type" NOT IN ('CERTIFICATE_REVOKED', 'ATTESTATION_REVOKED'));

-- The audience rule, one place. Unchanged for every Phase 16 type.
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
        ELSE 'SUBMISSION_OWNER'
    END;
$$;

-- The permission that makes somebody a member of a reviewer audience. Not a
-- parameter anybody can pass: derived from the audience, derived from the
-- event.
CREATE OR REPLACE FUNCTION app_notification_reviewer_permission(p_audience text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE p_audience
        WHEN 'ORGANIZATION_REVIEWERS' THEN 'submission:review:read'
        WHEN 'ATTESTATION_REVIEWERS' THEN 'attestation:request:review'
        ELSE NULL
    END;
$$;

CREATE OR REPLACE FUNCTION app_notification_is_audience_reviewer(
    p_organization_id uuid, p_user_id uuid, p_audience text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
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
    );
$$;

-- The reviewer resolver, now for either reviewer audience. The permission is
-- still derived from the event, never passed in.
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

CREATE OR REPLACE FUNCTION app_notification_create(
    p_notification_id uuid,
    p_source_event_id uuid,
    p_recipient_user_id uuid,
    p_template_version text,
    p_locale text,
    p_title text,
    p_body text,
    p_deep_link text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    event_row "domain_events"%ROWTYPE;
    v_audience text;
    v_id uuid;
    v_now timestamptz := now();
BEGIN
    IF NOT app_is_notification_fanout_context() THEN
        RAISE EXCEPTION 'creating a notification is system work'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO event_row FROM "domain_events" WHERE "id" = p_source_event_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'domain_event % does not exist', p_source_event_id;
    END IF;

    v_audience := app_notification_audience(event_row."event_type");

    IF app_notification_reviewer_permission(v_audience) IS NOT NULL THEN
        IF NOT app_notification_is_audience_reviewer(
                event_row."organization_id", p_recipient_user_id, v_audience) THEN
            RAISE EXCEPTION
                'user % is not a reviewer for domain_event %',
                p_recipient_user_id, p_source_event_id
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    ELSIF p_recipient_user_id IS DISTINCT FROM event_row."owner_user_id" THEN
        RAISE EXCEPTION
            'domain_event % is for its owner, not for user %',
            p_source_event_id, p_recipient_user_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    PERFORM set_config('palcert.notification_system_write', 'on', true);

    INSERT INTO "user_notifications" (
        "id", "source_event_id", "recipient_user_id", "organization_id",
        "notification_type", "template_version", "locale",
        "title", "body", "deep_link", "created_at"
    ) VALUES (
        p_notification_id, event_row."id", p_recipient_user_id, event_row."organization_id",
        event_row."event_type", p_template_version, p_locale,
        p_title, p_body, p_deep_link, v_now
    )
    ON CONFLICT ("source_event_id", "recipient_user_id", "notification_type") DO NOTHING
    RETURNING "id" INTO v_id;

    IF v_id IS NULL THEN
        SELECT "id" INTO v_id FROM "user_notifications"
         WHERE "source_event_id" = event_row."id"
           AND "recipient_user_id" = p_recipient_user_id
           AND "notification_type" = event_row."event_type";
    END IF;

    PERFORM set_config('palcert.notification_system_write', 'off', true);

    INSERT INTO "notification_deliveries" (
        "id", "notification_id", "channel", "status", "provider",
        "attempt_count", "created_at", "updated_at", "delivered_at"
    ) VALUES (
        gen_random_uuid(), v_id, 'IN_APP', 'DELIVERED', 'IN_APP', 1, v_now, v_now, v_now
    )
    ON CONFLICT ("notification_id", "channel") DO NOTHING;

    RETURN v_id;
END;
$$;

-- Emitting from one request-history row. The event type is derived from the
-- row and checked against the pair the caller names, so a caller can ask for
-- the two events a submission produces but cannot invent a third.
CREATE OR REPLACE FUNCTION app_domain_event_emit_attestation(
    p_request_event_id uuid, p_event_type "NotificationType"
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    history "attestation_request_events"%ROWTYPE;
    v_attestation_id uuid;
    v_allowed "NotificationType"[];
    v_payload jsonb;
    v_id uuid;
BEGIN
    SELECT * INTO history FROM "attestation_request_events" WHERE "id" = p_request_event_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'attestation_request_event % does not exist', p_request_event_id;
    END IF;

    IF NOT app_notification_caller_is_party(history."owner_user_id", history."organization_id") THEN
        RAISE EXCEPTION 'attestation_request_event % is not the caller''s to report', p_request_event_id;
    END IF;

    v_allowed := CASE history."event_type"
        WHEN 'SUBMITTED' THEN
            ARRAY['ATTESTATION_SUBMITTED', 'ATTESTATION_READY_FOR_REVIEW']::"NotificationType"[]
        WHEN 'INFORMATION_PROVIDED' THEN
            ARRAY['ATTESTATION_INFORMATION_PROVIDED']::"NotificationType"[]
        WHEN 'INFORMATION_REQUESTED' THEN
            ARRAY['ATTESTATION_INFORMATION_REQUESTED']::"NotificationType"[]
        WHEN 'APPROVED' THEN ARRAY['ATTESTATION_APPROVED']::"NotificationType"[]
        WHEN 'REJECTED' THEN ARRAY['ATTESTATION_REJECTED']::"NotificationType"[]
        WHEN 'REVOKED' THEN ARRAY['ATTESTATION_REVOKED']::"NotificationType"[]
        ELSE ARRAY[]::"NotificationType"[]
    END;

    IF NOT (p_event_type = ANY (v_allowed)) THEN
        RAISE EXCEPTION 'attestation_request_event % (%) does not produce %',
            p_request_event_id, history."event_type", p_event_type
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT a."id" INTO v_attestation_id FROM "attestations" a WHERE a."request_id" = history."request_id";

    v_payload := jsonb_build_object('attestationRequestId', history."request_id");
    IF p_event_type IN ('ATTESTATION_APPROVED', 'ATTESTATION_REVOKED') THEN
        IF v_attestation_id IS NULL THEN
            RAISE EXCEPTION 'attestation_request % has no attestation to report', history."request_id";
        END IF;
        v_payload := v_payload || jsonb_build_object('attestationId', v_attestation_id);
    END IF;

    INSERT INTO "domain_events" (
        "id", "event_type", "event_schema_version", "source_type", "source_id",
        "aggregate_type", "aggregate_id", "owner_user_id", "organization_id",
        "occurred_at", "payload", "webhook_eligible"
    ) VALUES (
        gen_random_uuid(), p_event_type, 1, 'ATTESTATION_REQUEST_EVENT', history."id",
        'ATTESTATION_REQUEST', history."request_id",
        history."owner_user_id", history."organization_id",
        history."created_at", v_payload,
        -- Not projected to webhooks: no public contract exists for these yet.
        false
    )
    ON CONFLICT ("source_type", "source_id", "event_type") DO NOTHING
    RETURNING "id" INTO v_id;

    IF v_id IS NULL THEN
        SELECT "id" INTO v_id FROM "domain_events"
         WHERE "source_type" = 'ATTESTATION_REQUEST_EVENT'
           AND "source_id" = history."id"
           AND "event_type" = p_event_type;
    END IF;

    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION app_domain_event_emit_attestation_reminder(p_reminder_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    reminder "attestation_reminders"%ROWTYPE;
    v_event_type "NotificationType";
    v_id uuid;
BEGIN
    SELECT * INTO reminder FROM "attestation_reminders" WHERE "id" = p_reminder_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'attestation_reminder % does not exist', p_reminder_id;
    END IF;

    IF NOT app_notification_caller_is_party(reminder."owner_user_id", reminder."organization_id") THEN
        RAISE EXCEPTION 'attestation_reminder % is not the caller''s to report', p_reminder_id;
    END IF;

    v_event_type := CASE WHEN reminder."stage" = 0
        THEN 'ATTESTATION_EXPIRED'::"NotificationType"
        ELSE 'ATTESTATION_EXPIRING'::"NotificationType" END;

    INSERT INTO "domain_events" (
        "id", "event_type", "event_schema_version", "source_type", "source_id",
        "aggregate_type", "aggregate_id", "owner_user_id", "organization_id",
        "occurred_at", "payload", "webhook_eligible"
    ) VALUES (
        gen_random_uuid(), v_event_type, 1, 'ATTESTATION_REMINDER', reminder."id",
        'ATTESTATION_REQUEST', reminder."request_id",
        reminder."owner_user_id", reminder."organization_id",
        reminder."recorded_at",
        jsonb_build_object(
            'attestationRequestId', reminder."request_id",
            'attestationId', reminder."attestation_id",
            'reminderStage', reminder."stage"
        ),
        false
    )
    ON CONFLICT ("source_type", "source_id", "event_type") DO NOTHING
    RETURNING "id" INTO v_id;

    IF v_id IS NULL THEN
        SELECT "id" INTO v_id FROM "domain_events"
         WHERE "source_type" = 'ATTESTATION_REMINDER'
           AND "source_id" = reminder."id"
           AND "event_type" = v_event_type;
    END IF;

    RETURN v_id;
END;
$$;

-- =============================================================================
-- 14. Durable jobs
--
-- Ingesting an artifact is the owner's work, as a document ingest is. Moving
-- the money a decision implies is PalCert's own work — it crosses the owner's
-- ledger and the institution's revenue — so it belongs to neither party.
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
        'ATTESTATION_ARTIFACT', 'ATTESTATION_REQUEST'));

ALTER TABLE "processing_jobs" DROP CONSTRAINT "processing_jobs_tenancy_matches_type";
ALTER TABLE "processing_jobs"
    ADD CONSTRAINT "processing_jobs_tenancy_matches_type" CHECK (
        ("resource_type" IN ('STANDARD_SOURCE_ASSET', 'RULE_EXTRACTION_RUN')
            AND "organization_id" IS NOT NULL AND "owner_user_id" IS NOT NULL)
        OR ("resource_type" IN ('PAYMENT_PROVIDER_EVENT', 'PAYMENT_RECONCILIATION',
                                'DOMAIN_EVENT', 'NOTIFICATION_DELIVERY',
                                'WEBHOOK_DELIVERY', 'WEBHOOK_VERIFICATION_OPERATION',
                                'ATTESTATION_REQUEST')
            AND "organization_id" IS NULL AND "owner_user_id" IS NULL)
        OR ("resource_type" NOT IN ('STANDARD_SOURCE_ASSET', 'RULE_EXTRACTION_RUN',
                                    'PAYMENT_PROVIDER_EVENT', 'PAYMENT_RECONCILIATION',
                                    'DOMAIN_EVENT', 'NOTIFICATION_DELIVERY',
                                    'WEBHOOK_DELIVERY', 'WEBHOOK_VERIFICATION_OPERATION',
                                    'ATTESTATION_REQUEST')
            AND "organization_id" IS NULL AND "owner_user_id" IS NOT NULL)
    );

-- =============================================================================
-- 15. Permissions
-- =============================================================================
INSERT INTO "permissions" ("id", "code", "description") VALUES
    (gen_random_uuid(), 'attestation:submit:self',
     'Ask an institution to attest a certificate you hold, pay its fee, and manage your requests'),
    (gen_random_uuid(), 'attestation:read:self',
     'Read your own attestation requests, attestations and receipts'),
    (gen_random_uuid(), 'attestation:request:read',
     'See this organization''s attestation queue and requests'),
    (gen_random_uuid(), 'attestation:request:review',
     'Start reviewing, request information and reject attestation requests'),
    (gen_random_uuid(), 'attestation:request:approve',
     'Approve an attestation request and issue its public attestation'),
    (gen_random_uuid(), 'attestation:record:revoke',
     'Revoke an attestation this organization issued'),
    (gen_random_uuid(), 'attestation:type:manage',
     'Create and configure this organization''s attestation types'),
    (gen_random_uuid(), 'attestation:fee:manage',
     'Set the fee this organization charges for each attestation type'),
    (gen_random_uuid(), 'attestation:finance:read',
     'Read this organization''s attestation revenue and its split'),
    (gen_random_uuid(), 'admin:attestation:read',
     'Read any organization''s attestation requests and records, for support'),
    (gen_random_uuid(), 'admin:attestation-commission:manage',
     'Set the platform commission on an organization''s attestation fees'),
    (gen_random_uuid(), 'admin:attestation-finance:read',
     'Read platform-wide attestation revenue')
ON CONFLICT ("code") DO NOTHING;

-- Self-service, like every other "your own" permission.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT DISTINCT rp."role_id", p."id"
FROM "role_permissions" rp
JOIN "permissions" anchor ON anchor."id" = rp."permission_id" AND anchor."code" = 'profile:read:self'
CROSS JOIN "permissions" p
WHERE p."code" IN ('attestation:submit:self', 'attestation:read:self')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- Reviewing: owners, admins and reviewers.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r CROSS JOIN "permissions" p
WHERE r."code" IN ('ORGANIZATION_OWNER', 'ORGANIZATION_ADMIN', 'ORGANIZATION_REVIEWER')
  AND p."code" IN ('attestation:request:read', 'attestation:request:review', 'attestation:request:approve')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- Running the service: owners and admins only.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r CROSS JOIN "permissions" p
WHERE r."code" IN ('ORGANIZATION_OWNER', 'ORGANIZATION_ADMIN')
  AND p."code" IN ('attestation:record:revoke', 'attestation:type:manage',
                   'attestation:fee:manage', 'attestation:finance:read')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- PalCert staff.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r CROSS JOIN "permissions" p
WHERE (r."code" = 'PALCERT_ADMIN' AND p."code" IN
        ('admin:attestation:read', 'admin:attestation-commission:manage', 'admin:attestation-finance:read'))
   OR (r."code" = 'PALCERT_FINANCE' AND p."code" IN
        ('admin:attestation-commission:manage', 'admin:attestation-finance:read'))
   OR (r."code" = 'PALCERT_AUDITOR' AND p."code" = 'admin:attestation-finance:read')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- =============================================================================
-- 16. Function privileges
-- =============================================================================
REVOKE ALL ON FUNCTION app_attestation_catalogue_organizations() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_attestation_catalogue_types(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_attestation_type_offer(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_attestation_commission_at(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_attestation_request_owners(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_attestation_member_names(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_public_attestation(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_public_attestations_by_artifact(text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_domain_event_emit_attestation(uuid, "NotificationType") FROM PUBLIC;
REVOKE ALL ON FUNCTION app_domain_event_emit_attestation_reminder(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_notification_reviewer_permission(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_notification_is_audience_reviewer(uuid, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_attestation_catalogue_organizations() TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_attestation_catalogue_types(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_attestation_type_offer(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_attestation_commission_at(uuid, timestamptz) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_attestation_request_owners(uuid[]) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_attestation_member_names(uuid[]) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_public_attestation(text) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_public_attestations_by_artifact(text, timestamptz) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_domain_event_emit_attestation(uuid, "NotificationType") TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_domain_event_emit_attestation_reminder(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_notification_reviewer_permission(text) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_notification_is_audience_reviewer(uuid, uuid, text) TO "palcert_app";

COMMENT ON TABLE "attestations" IS
    'An institution''s immutable attestation over the exact bytes of a certificate a user submitted. PalCert attests a submitted artifact; it does not claim to have issued the external certificate.';
COMMENT ON TABLE "attestation_settlements" IS
    'The destination of one approved request''s captured fee. The customer debit is in credit_ledger_entries; the split is here, balanced by attestation_revenue_entries.';
