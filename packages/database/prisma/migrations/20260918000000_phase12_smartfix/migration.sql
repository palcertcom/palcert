-- =============================================================================
-- Phase 12 — SmartFix: paid deterministic DOCX correction
--
-- PalCert may change deterministic document formatting, but it must never
-- silently change academic meaning. This migration is where that sentence
-- stops being a policy and becomes something the database enforces.
--
-- Three tables. A `smartfix_plan` is what PalCert *would* change, computed for
-- free from a completed check and hashed so the list somebody approved is the
-- list that executes. A `smartfix_request` is one paid correction, and every
-- guarantee below hangs off it. A `smartfix_manifest` is the proof of what
-- actually changed, computed from the corrected bytes rather than copied from
-- the plan.
--
-- Two columns carry the weight elsewhere. `document_versions.origin` says a
-- corrected document is a *new version* with a recorded parent, never a
-- rewrite of the original — the original is what the author uploaded and what
-- every earlier check was run against. `document_checks.purpose` says whether
-- a check is somebody's own, and therefore paid for, or the automatic recheck
-- inside a correction they already bought.
--
-- The guarantees installed here rather than in a service, because a service
-- can be bypassed and a trigger cannot (§196–§200):
--
--   1. **The original is never modified.** Phase 5 already froze a version's
--      identity columns; this adds that a version's origin and lineage are
--      write-once too, so an original can never be retro-fitted with a parent
--      to make it look like a correction.
--
--   2. **A corrected version always has lineage.** SMARTFIX origin requires a
--      source version and a request, and both must belong to the same person.
--      A USER_UPLOAD version may have neither.
--
--   3. **A correction is invisible until it is delivered.** A deferred trigger
--      refuses a visible SMARTFIX version whose request has not reached
--      DELIVERED, so the generated file cannot be downloaded before anybody
--      has paid for it or the recheck has proved it worth delivering.
--
--   4. **No free check comes back through the side door.** The Phase 11 rule
--      "every new check names a purchase" becomes purpose-aware: a
--      USER_REQUESTED check still needs one, and a SMARTFIX_RECHECK must name
--      a request that owns it, points at the version being rechecked, and
--      carries the same standard version. It may not carry a purchase of its
--      own, because it was already paid for.
--
--   5. **Nothing is delivered that was not proved and charged.** A deferred
--      trigger requires a DELIVERED request to have a corrected version, a
--      manifest, a COMPLETED recheck and a DELIVERED purchase; and a FAILED or
--      CANCELLED one to have released its reservation with nothing charged.
-- =============================================================================

-- =============================================================================
-- 1. Generated additive DDL
-- =============================================================================
-- CreateEnum
CREATE TYPE "DocumentVersionOrigin" AS ENUM ('USER_UPLOAD', 'SMARTFIX');

-- CreateEnum
CREATE TYPE "CheckPurpose" AS ENUM ('USER_REQUESTED', 'SMARTFIX_RECHECK');

-- CreateEnum
CREATE TYPE "SmartFixRequestStatus" AS ENUM ('RESERVED', 'PROCESSING', 'RECHECKING', 'VALIDATING', 'DELIVERED', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "document_checks" ADD COLUMN     "purpose" "CheckPurpose" NOT NULL DEFAULT 'USER_REQUESTED',
ADD COLUMN     "smartfix_request_id" UUID;

-- AlterTable
ALTER TABLE "document_versions" ADD COLUMN     "origin" "DocumentVersionOrigin" NOT NULL DEFAULT 'USER_UPLOAD',
ADD COLUMN     "smartfix_request_id" UUID,
ADD COLUMN     "source_document_version_id" UUID,
ADD COLUMN     "visible_to_owner" BOOLEAN NOT NULL DEFAULT true;


-- CreateTable
CREATE TABLE "smartfix_plans" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "check_id" UUID NOT NULL,
    "check_run_id" UUID,
    "document_id" UUID NOT NULL,
    "document_version_id" UUID NOT NULL,
    "standard_version_id" UUID NOT NULL,
    "document_sha256" CHAR(64) NOT NULL,
    "analysis_artifact_sha256" CHAR(64) NOT NULL,
    "standard_content_hash" TEXT NOT NULL,
    "report_hash" CHAR(64) NOT NULL,
    "plan_schema_version" INTEGER NOT NULL,
    "fix_engine_name" VARCHAR(80) NOT NULL,
    "fix_engine_version" VARCHAR(40) NOT NULL,
    "capability_registry_version" INTEGER NOT NULL,
    "plan_hash" CHAR(64) NOT NULL,
    "refusal_code" VARCHAR(64),
    "rule_count" INTEGER NOT NULL,
    "fixable_rule_count" INTEGER NOT NULL,
    "action_count" INTEGER NOT NULL,
    "artifact_object_key" TEXT NOT NULL,
    "artifact_object_version_id" TEXT,
    "artifact_size_bytes" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "smartfix_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "smartfix_requests" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "plan_hash" CHAR(64) NOT NULL,
    "check_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "source_document_version_id" UUID NOT NULL,
    "standard_version_id" UUID NOT NULL,
    "service_purchase_id" UUID NOT NULL,
    "status" "SmartFixRequestStatus" NOT NULL DEFAULT 'RESERVED',
    "failure_code" VARCHAR(64),
    "failure_detail" TEXT,
    "corrected_document_version_id" UUID,
    "recheck_check_id" UUID,
    "idempotency_key" VARCHAR(200),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reserved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processing_at" TIMESTAMPTZ(6),
    "rechecking_at" TIMESTAMPTZ(6),
    "validating_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "smartfix_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "smartfix_manifests" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "manifest_schema_version" INTEGER NOT NULL,
    "fix_engine_name" VARCHAR(80) NOT NULL,
    "fix_engine_version" VARCHAR(40) NOT NULL,
    "plan_hash" CHAR(64) NOT NULL,
    "source_sha256" CHAR(64) NOT NULL,
    "output_sha256" CHAR(64) NOT NULL,
    "manifest_hash" CHAR(64) NOT NULL,
    "entry_count" INTEGER NOT NULL,
    "changed_parts" TEXT[],
    "source_visible_text_hash" CHAR(64) NOT NULL,
    "output_visible_text_hash" CHAR(64) NOT NULL,
    "source_media_set_hash" CHAR(64) NOT NULL,
    "output_media_set_hash" CHAR(64) NOT NULL,
    "source_field_instruction_hash" CHAR(64) NOT NULL,
    "output_field_instruction_hash" CHAR(64) NOT NULL,
    "source_relationship_hash" CHAR(64) NOT NULL,
    "output_relationship_hash" CHAR(64) NOT NULL,
    "artifact_object_key" TEXT NOT NULL,
    "artifact_object_version_id" TEXT,
    "artifact_size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "smartfix_manifests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "smartfix_plans_artifact_object_key_key" ON "smartfix_plans"("artifact_object_key");

-- CreateIndex
CREATE INDEX "smartfix_plans_owner_user_id_created_at_id_idx" ON "smartfix_plans"("owner_user_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "smartfix_plans_check_id_created_at_idx" ON "smartfix_plans"("check_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "smartfix_plans_id_owner_key" ON "smartfix_plans"("id", "owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "smartfix_requests_service_purchase_id_key" ON "smartfix_requests"("service_purchase_id");

-- CreateIndex
CREATE UNIQUE INDEX "smartfix_requests_corrected_document_version_id_key" ON "smartfix_requests"("corrected_document_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "smartfix_requests_recheck_check_id_key" ON "smartfix_requests"("recheck_check_id");

-- CreateIndex
CREATE INDEX "smartfix_requests_owner_user_id_created_at_id_idx" ON "smartfix_requests"("owner_user_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "smartfix_requests_status_reserved_at_idx" ON "smartfix_requests"("status", "reserved_at");

-- CreateIndex
CREATE INDEX "smartfix_requests_check_id_idx" ON "smartfix_requests"("check_id");

-- CreateIndex
CREATE UNIQUE INDEX "smartfix_requests_id_owner_key" ON "smartfix_requests"("id", "owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "smartfix_requests_owner_idempotency" ON "smartfix_requests"("owner_user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "smartfix_manifests_request_id_key" ON "smartfix_manifests"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "smartfix_manifests_artifact_object_key_key" ON "smartfix_manifests"("artifact_object_key");

-- CreateIndex
CREATE INDEX "smartfix_manifests_owner_user_id_created_at_id_idx" ON "smartfix_manifests"("owner_user_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_checks_smartfix_request_id_key" ON "document_checks"("smartfix_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_smartfix_request_id_key" ON "document_versions"("smartfix_request_id");

-- CreateIndex
CREATE INDEX "document_versions_source_document_version_id_idx" ON "document_versions"("source_document_version_id");

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_source_document_version_id_fkey" FOREIGN KEY ("source_document_version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_smartfix_request_id_fkey" FOREIGN KEY ("smartfix_request_id") REFERENCES "smartfix_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_checks" ADD CONSTRAINT "document_checks_smartfix_request_id_fkey" FOREIGN KEY ("smartfix_request_id") REFERENCES "smartfix_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smartfix_plans" ADD CONSTRAINT "smartfix_plans_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smartfix_plans" ADD CONSTRAINT "smartfix_plans_check_id_fkey" FOREIGN KEY ("check_id") REFERENCES "document_checks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smartfix_plans" ADD CONSTRAINT "smartfix_plans_document_version_id_fkey" FOREIGN KEY ("document_version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smartfix_plans" ADD CONSTRAINT "smartfix_plans_standard_version_id_fkey" FOREIGN KEY ("standard_version_id") REFERENCES "standard_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smartfix_requests" ADD CONSTRAINT "smartfix_requests_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smartfix_requests" ADD CONSTRAINT "smartfix_requests_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "smartfix_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smartfix_requests" ADD CONSTRAINT "smartfix_requests_check_id_fkey" FOREIGN KEY ("check_id") REFERENCES "document_checks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smartfix_requests" ADD CONSTRAINT "smartfix_requests_source_document_version_id_fkey" FOREIGN KEY ("source_document_version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smartfix_requests" ADD CONSTRAINT "smartfix_requests_standard_version_id_fkey" FOREIGN KEY ("standard_version_id") REFERENCES "standard_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smartfix_requests" ADD CONSTRAINT "smartfix_requests_service_purchase_id_fkey" FOREIGN KEY ("service_purchase_id") REFERENCES "service_purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smartfix_manifests" ADD CONSTRAINT "smartfix_manifests_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "smartfix_manifests" ADD CONSTRAINT "smartfix_manifests_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "smartfix_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- =============================================================================
-- 2. Composite ownership keys (§128–§131)
--
--    The ordinary foreign keys above prove the row exists. These prove it
--    belongs to the same person. Without them a service bug could correct User
--    A's document into User B's version, or recheck it against a plan that was
--    never theirs — and a document is somebody's unpublished thesis.
-- =============================================================================
ALTER TABLE "smartfix_plans"
    ADD CONSTRAINT "smartfix_plans_check_owner_fkey"
    FOREIGN KEY ("owner_user_id", "check_id")
    REFERENCES "document_checks" ("owner_user_id", "id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "smartfix_plans"
    ADD CONSTRAINT "smartfix_plans_version_owner_fkey"
    FOREIGN KEY ("owner_user_id", "document_version_id")
    REFERENCES "document_versions" ("owner_user_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "smartfix_requests"
    ADD CONSTRAINT "smartfix_requests_plan_owner_fkey"
    FOREIGN KEY ("owner_user_id", "plan_id")
    REFERENCES "smartfix_plans" ("owner_user_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "smartfix_requests"
    ADD CONSTRAINT "smartfix_requests_check_owner_fkey"
    FOREIGN KEY ("owner_user_id", "check_id")
    REFERENCES "document_checks" ("owner_user_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "smartfix_requests"
    ADD CONSTRAINT "smartfix_requests_source_owner_fkey"
    FOREIGN KEY ("owner_user_id", "source_document_version_id")
    REFERENCES "document_versions" ("owner_user_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "smartfix_requests"
    ADD CONSTRAINT "smartfix_requests_purchase_owner_fkey"
    FOREIGN KEY ("owner_user_id", "service_purchase_id")
    REFERENCES "service_purchases" ("owner_user_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "smartfix_manifests"
    ADD CONSTRAINT "smartfix_manifests_request_owner_fkey"
    FOREIGN KEY ("owner_user_id", "request_id")
    REFERENCES "smartfix_requests" ("owner_user_id", "id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "document_versions"
    ADD CONSTRAINT "document_versions_source_owner_fkey"
    FOREIGN KEY ("owner_user_id", "source_document_version_id")
    REFERENCES "document_versions" ("owner_user_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "document_versions"
    ADD CONSTRAINT "document_versions_smartfix_owner_fkey"
    FOREIGN KEY ("owner_user_id", "smartfix_request_id")
    REFERENCES "smartfix_requests" ("owner_user_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "document_checks"
    ADD CONSTRAINT "document_checks_smartfix_owner_fkey"
    FOREIGN KEY ("owner_user_id", "smartfix_request_id")
    REFERENCES "smartfix_requests" ("owner_user_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT;

-- =============================================================================
-- 3. Value invariants
-- =============================================================================
-- Digests are digests. A truncated one is not evidence of anything.
ALTER TABLE "smartfix_plans"
    ADD CONSTRAINT "smartfix_plans_hash_shape" CHECK (
        "plan_hash" ~ '^[0-9a-f]{64}$'
        AND "document_sha256" ~ '^[0-9a-f]{64}$'
        AND "analysis_artifact_sha256" ~ '^[0-9a-f]{64}$'
        AND "report_hash" ~ '^[0-9a-f]{64}$'
    );

ALTER TABLE "smartfix_plans"
    ADD CONSTRAINT "smartfix_plans_counts_sane" CHECK (
        "rule_count" >= 0
        AND "action_count" >= 0
        AND "fixable_rule_count" >= 0
        AND "fixable_rule_count" <= "rule_count"
        AND "artifact_size_bytes" > 0
    );

-- A refusal is a property of the document, so a refusing plan plans nothing.
ALTER TABLE "smartfix_plans"
    ADD CONSTRAINT "smartfix_plans_refusal_has_no_actions"
    CHECK ("refusal_code" IS NULL OR "action_count" = 0);

ALTER TABLE "smartfix_plans"
    ADD CONSTRAINT "smartfix_plans_expires_after_creation"
    CHECK ("expires_at" > "created_at");

ALTER TABLE "smartfix_requests"
    ADD CONSTRAINT "smartfix_requests_plan_hash_shape"
    CHECK ("plan_hash" ~ '^[0-9a-f]{64}$');

-- A status and its timestamp agree, so "when did this fail?" is answerable
-- from the row rather than from a log.
ALTER TABLE "smartfix_requests"
    ADD CONSTRAINT "smartfix_requests_status_timestamps" CHECK (
        ("status" IN ('RESERVED', 'PROCESSING', 'RECHECKING', 'VALIDATING'))
        OR ("status" = 'DELIVERED' AND "delivered_at" IS NOT NULL
            AND "failed_at" IS NULL AND "cancelled_at" IS NULL)
        OR ("status" = 'FAILED'    AND "failed_at"    IS NOT NULL AND "delivered_at" IS NULL)
        OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "delivered_at" IS NULL)
    );

-- Delivery means all of it, or none of it. A corrected version without a
-- recheck is an untested document; a recheck without a corrected version is a
-- check of nothing (§79).
ALTER TABLE "smartfix_requests"
    ADD CONSTRAINT "smartfix_requests_delivery_is_complete" CHECK (
        "status" <> 'DELIVERED'
        OR ("corrected_document_version_id" IS NOT NULL AND "recheck_check_id" IS NOT NULL)
    );

-- A failure has a code. "Something went wrong" is not something a user can act
-- on, and support cannot triage it either.
ALTER TABLE "smartfix_requests"
    ADD CONSTRAINT "smartfix_requests_failure_has_a_code"
    CHECK ("status" <> 'FAILED' OR "failure_code" IS NOT NULL);

ALTER TABLE "smartfix_manifests"
    ADD CONSTRAINT "smartfix_manifests_hash_shape" CHECK (
        "manifest_hash" ~ '^[0-9a-f]{64}$'
        AND "plan_hash" ~ '^[0-9a-f]{64}$'
        AND "source_sha256" ~ '^[0-9a-f]{64}$'
        AND "output_sha256" ~ '^[0-9a-f]{64}$'
        AND "source_visible_text_hash" ~ '^[0-9a-f]{64}$'
        AND "output_visible_text_hash" ~ '^[0-9a-f]{64}$'
    );

-- The correction produced a different document. An output identical to the
-- source is a correction that did nothing, and nobody should be charged for
-- one (§111).
ALTER TABLE "smartfix_manifests"
    ADD CONSTRAINT "smartfix_manifests_output_differs"
    CHECK ("output_sha256" <> "source_sha256");

-- The proofs. Stored as columns and checked here so a manifest that admits it
-- changed the text, the media, a field instruction or a relationship cannot
-- exist at all — not merely be rejected by whichever service last looked.
ALTER TABLE "smartfix_manifests"
    ADD CONSTRAINT "smartfix_manifests_integrity_holds" CHECK (
        "source_visible_text_hash" = "output_visible_text_hash"
        AND "source_media_set_hash" = "output_media_set_hash"
        AND "source_field_instruction_hash" = "output_field_instruction_hash"
        AND "source_relationship_hash" = "output_relationship_hash"
    );

ALTER TABLE "smartfix_manifests"
    ADD CONSTRAINT "smartfix_manifests_counts_sane"
    CHECK ("entry_count" > 0 AND "artifact_size_bytes" > 0 AND cardinality("changed_parts") > 0);

-- Phase 12 sells corrections and Phase 11 sells checks; neither may be bought
-- under the other's product (§73).
ALTER TABLE "service_purchases"
    ADD CONSTRAINT "service_purchases_phase12_product"
    CHECK ("resource_type" <> 'SMARTFIX' OR "product_code" = 'SMARTFIX');

-- =============================================================================
-- 4. The original is never modified, and a correction always has lineage
--    (§2, §196, §197)
-- =============================================================================
CREATE OR REPLACE FUNCTION document_versions_origin_lineage()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    parent "document_versions"%ROWTYPE;
BEGIN
    -- Checked first, so an attempt to re-parent an existing version is
    -- diagnosed as what it is rather than as a malformed correction.
    IF TG_OP = 'UPDATE' THEN
        IF NEW."origin" <> OLD."origin"
            OR NEW."source_document_version_id" IS DISTINCT FROM OLD."source_document_version_id"
            OR NEW."smartfix_request_id" IS DISTINCT FROM OLD."smartfix_request_id"
        THEN
            RAISE EXCEPTION 'document_version % lineage is written once', OLD."id"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;

    IF NEW."origin" = 'SMARTFIX' THEN
        IF NEW."source_document_version_id" IS NULL OR NEW."smartfix_request_id" IS NULL THEN
            RAISE EXCEPTION 'document_version % is a correction without lineage', NEW."id"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW."source_document_version_id" = NEW."id" THEN
            RAISE EXCEPTION 'document_version % cannot be corrected from itself', NEW."id"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        SELECT * INTO parent FROM "document_versions"
        WHERE "id" = NEW."source_document_version_id";
        IF NOT FOUND OR parent."owner_user_id" <> NEW."owner_user_id" THEN
            RAISE EXCEPTION 'document_version % names a source that is not its owner''s', NEW."id"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        -- A correction belongs to the same logical document as the thing it
        -- corrects. Otherwise "version 3 of my thesis" would mean two files.
        IF parent."document_id" <> NEW."document_id" THEN
            RAISE EXCEPTION 'document_version % corrects a version of another document', NEW."id"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    ELSE
        IF NEW."source_document_version_id" IS NOT NULL OR NEW."smartfix_request_id" IS NOT NULL THEN
            -- An uploaded file has no parent. Allowing one would let an
            -- original be dressed up as a correction after the fact.
            RAISE EXCEPTION 'document_version % is an upload and cannot have correction lineage',
                NEW."id"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NOT NEW."visible_to_owner" THEN
            -- Hiding is a property of a correction awaiting delivery, and of
            -- nothing else. A person's own upload is theirs to see, always.
            RAISE EXCEPTION 'document_version % is an upload and cannot be hidden from its owner',
                NEW."id"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "document_versions_origin_lineage"
    BEFORE INSERT OR UPDATE ON "document_versions"
    FOR EACH ROW EXECUTE FUNCTION document_versions_origin_lineage();

-- A correction is invisible until it is delivered, and visible once it is
-- (§84, §85, §198).
--
-- Both halves matter, and they fail in opposite directions. Visible-too-early
-- hands the user an output that has not passed its recheck; hidden-after-
-- delivery takes back something they have paid for. The delivered side is also
-- asked by `smartfix_requests_settlement`, but only of transactions that touch
-- the request row — so without this half a later UPDATE of the version alone
-- could quietly withdraw a delivered correction.
--
-- Deferred, because the delivery transaction necessarily passes through a
-- moment where the version has been made visible and the request has not yet
-- been marked DELIVERED. Asked at COMMIT it is the only question worth asking:
-- when this transaction is over, can the user see exactly what they have paid
-- for and nothing else?
CREATE OR REPLACE FUNCTION document_versions_smartfix_visibility_trigger()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    request_status text;
BEGIN
    IF NEW."origin" <> 'SMARTFIX' THEN
        RETURN NULL;
    END IF;

    SELECT "status"::text INTO request_status
    FROM "smartfix_requests" WHERE "id" = NEW."smartfix_request_id";

    IF NEW."visible_to_owner" AND request_status IS DISTINCT FROM 'DELIVERED' THEN
        RAISE EXCEPTION 'document_version % is visible but its correction is %',
            NEW."id", COALESCE(request_status, 'missing')
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF NOT NEW."visible_to_owner" AND request_status = 'DELIVERED' THEN
        RAISE EXCEPTION 'document_version % is hidden but its correction was delivered',
            NEW."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "document_versions_smartfix_visibility"
    AFTER INSERT OR UPDATE ON "document_versions"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION document_versions_smartfix_visibility_trigger();

-- =============================================================================
-- 5. Purpose-aware check classification (§95, §96, §98, §200)
--
--    Phase 11 retired the free check with "every new check names a purchase".
--    A SmartFix recheck is part of a correction the user already bought, so it
--    is the one check that does not — and that exception is exactly where a
--    free-check bypass would hide. It is therefore not an exemption but a
--    stricter requirement: a SMARTFIX_RECHECK must name a request that belongs
--    to the same person, that is rechecking this very version, against the
--    same standard version the correction was planned for. And it must carry
--    no purchase of its own, so the Phase 11 completion handler finds nothing
--    to capture when it finishes.
-- =============================================================================
CREATE OR REPLACE FUNCTION document_checks_require_purchase()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    purchase "service_purchases"%ROWTYPE;
    request "smartfix_requests"%ROWTYPE;
BEGIN
    IF NEW."purpose" = 'SMARTFIX_RECHECK' THEN
        IF NEW."smartfix_request_id" IS NULL THEN
            RAISE EXCEPTION 'document_check % is a recheck with no correction behind it', NEW."id"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW."service_purchase_id" IS NOT NULL THEN
            -- The recheck is included in the correction. A purchase here would
            -- be a second charge for work the user already paid for (§93).
            RAISE EXCEPTION 'document_check % is a recheck and must not carry its own purchase',
                NEW."id"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        SELECT * INTO request FROM "smartfix_requests" WHERE "id" = NEW."smartfix_request_id";
        IF NOT FOUND THEN
            RAISE EXCEPTION 'document_check % names a correction that does not exist', NEW."id"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF request."owner_user_id" <> NEW."owner_user_id" THEN
            RAISE EXCEPTION 'document_check % names another person''s correction', NEW."id"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF request."corrected_document_version_id" IS DISTINCT FROM NEW."document_version_id" THEN
            RAISE EXCEPTION 'document_check % rechecks a version the correction did not produce',
                NEW."id"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        -- The recheck uses the exact historical standard version, even if it
        -- has since been archived or made private (§91, §92). Checking it here
        -- means a service that reached for "the current version" instead is
        -- refused rather than quietly reporting against different rules.
        IF request."standard_version_id" <> NEW."standard_version_id" THEN
            RAISE EXCEPTION 'document_check % rechecks against a different standard version',
                NEW."id"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."smartfix_request_id" IS NOT NULL THEN
        RAISE EXCEPTION 'document_check % names a correction but is not a recheck', NEW."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF NEW."service_purchase_id" IS NULL THEN
        RAISE EXCEPTION 'document_check % must be bound to a service purchase', NEW."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    SELECT * INTO purchase FROM "service_purchases" WHERE "id" = NEW."service_purchase_id";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'document_check % names a service purchase that does not exist', NEW."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF purchase."owner_user_id" <> NEW."owner_user_id"
        OR purchase."resource_type" <> 'DOCUMENT_CHECK'
        OR purchase."resource_id" <> NEW."id"
        OR purchase."product_code" <> 'DOCUMENT_CHECK'
    THEN
        RAISE EXCEPTION 'service_purchase % does not describe document_check %',
            purchase."id", NEW."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
END;
$$;

-- Purpose and the correction behind it are write-once. A user's own check
-- cannot be reclassified as a recheck to make it look free, and a recheck
-- cannot be reclassified as a user's check to make it look billable.
CREATE OR REPLACE FUNCTION document_checks_purpose_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW."purpose" <> OLD."purpose"
        OR NEW."smartfix_request_id" IS DISTINCT FROM OLD."smartfix_request_id"
    THEN
        RAISE EXCEPTION 'document_check % purpose is written once', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "document_checks_purpose_immutable"
    BEFORE UPDATE ON "document_checks"
    FOR EACH ROW EXECUTE FUNCTION document_checks_purpose_immutable();

-- Phase 11's completion invariant, taught about rechecks. A SMARTFIX_RECHECK
-- has no purchase, so there is nothing for it to be consistent with — and
-- demanding one would be demanding a second charge (§98).
CREATE OR REPLACE FUNCTION document_checks_completion_paid_trigger()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    purchase_status text;
BEGIN
    IF NEW."status" <> 'COMPLETED'
        OR NEW."purpose" = 'SMARTFIX_RECHECK'
        OR NEW."service_purchase_id" IS NULL
    THEN
        RETURN NULL;
    END IF;

    SELECT "status"::text INTO purchase_status
    FROM "service_purchases" WHERE "id" = NEW."service_purchase_id";

    IF purchase_status NOT IN ('DELIVERED', 'REFUNDED') THEN
        RAISE EXCEPTION 'document_check % is COMPLETED but its purchase is %',
            NEW."id", COALESCE(purchase_status, 'missing')
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NULL;
END;
$$;

-- =============================================================================
-- 6. The correction's own life (§59, §79, §80, §199)
-- =============================================================================
CREATE OR REPLACE FUNCTION smartfix_requests_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    allowed text[];
BEGIN
    -- What was bought, for whom, from which plan. Changing any of it would
    -- mean the correction the user approved is not the one being made.
    IF NEW."owner_user_id" <> OLD."owner_user_id"
        OR NEW."plan_id" <> OLD."plan_id"
        OR NEW."plan_hash" <> OLD."plan_hash"
        OR NEW."check_id" <> OLD."check_id"
        OR NEW."document_id" <> OLD."document_id"
        OR NEW."source_document_version_id" <> OLD."source_document_version_id"
        OR NEW."standard_version_id" <> OLD."standard_version_id"
        OR NEW."service_purchase_id" <> OLD."service_purchase_id"
    THEN
        RAISE EXCEPTION 'smartfix_request % identity is immutable', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- What it produced is written once, when it is produced.
    IF OLD."corrected_document_version_id" IS NOT NULL
        AND NEW."corrected_document_version_id" IS DISTINCT FROM OLD."corrected_document_version_id"
    THEN
        RAISE EXCEPTION 'smartfix_request % already produced a corrected version', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD."recheck_check_id" IS NOT NULL
        AND NEW."recheck_check_id" IS DISTINCT FROM OLD."recheck_check_id"
    THEN
        RAISE EXCEPTION 'smartfix_request % already ran its recheck', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF NEW."status" <> OLD."status" THEN
        allowed := CASE OLD."status"
            WHEN 'RESERVED'   THEN ARRAY['PROCESSING', 'FAILED', 'CANCELLED']
            WHEN 'PROCESSING' THEN ARRAY['RECHECKING', 'FAILED', 'CANCELLED']
            WHEN 'RECHECKING' THEN ARRAY['VALIDATING', 'FAILED', 'CANCELLED']
            WHEN 'VALIDATING' THEN ARRAY['DELIVERED', 'FAILED']
            ELSE ARRAY[]::text[]
        END;
        IF NOT (NEW."status"::text = ANY (allowed)) THEN
            RAISE EXCEPTION 'smartfix_request % cannot move from % to %',
                OLD."id", OLD."status", NEW."status"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "smartfix_requests_guard"
    BEFORE UPDATE ON "smartfix_requests"
    FOR EACH ROW EXECUTE FUNCTION smartfix_requests_guard();

-- The manifest is evidence. Evidence that can be edited is not evidence.
CREATE OR REPLACE FUNCTION smartfix_manifests_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    RAISE EXCEPTION 'smartfix_manifest % is written once and cannot be changed', OLD."id"
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER "smartfix_manifests_immutable"
    BEFORE UPDATE ON "smartfix_manifests"
    FOR EACH ROW EXECUTE FUNCTION smartfix_manifests_immutable();

-- The purchase belongs to this correction and nothing else (§73).
CREATE OR REPLACE FUNCTION smartfix_requests_purchase_binding()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    purchase "service_purchases"%ROWTYPE;
BEGIN
    SELECT * INTO purchase FROM "service_purchases" WHERE "id" = NEW."service_purchase_id";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'smartfix_request % names a purchase that does not exist', NEW."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF purchase."owner_user_id" <> NEW."owner_user_id"
        OR purchase."resource_type" <> 'SMARTFIX'
        OR purchase."resource_id" <> NEW."id"
        OR purchase."product_code" <> 'SMARTFIX'
    THEN
        RAISE EXCEPTION 'service_purchase % does not describe smartfix_request %',
            purchase."id", NEW."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "smartfix_requests_purchase_binding"
    BEFORE INSERT ON "smartfix_requests"
    FOR EACH ROW EXECUTE FUNCTION smartfix_requests_purchase_binding();

-- Nothing is delivered that was not produced, proved, rechecked and charged;
-- and nothing that failed was charged for (§79, §80, §199).
--
-- Deferred for the same reason as everything else here: the delivery
-- transaction writes the version, the manifest, the purchase and the request,
-- and no ordering of those four writes avoids an intermediate state that an
-- immediate trigger would refuse.
CREATE OR REPLACE FUNCTION smartfix_requests_settlement_trigger()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    purchase_status text;
    recheck_status text;
    corrected_visible boolean;
    manifest_count integer;
    charged integer;
BEGIN
    SELECT "status"::text INTO purchase_status
    FROM "service_purchases" WHERE "id" = NEW."service_purchase_id";

    IF NEW."status" = 'DELIVERED' THEN
        SELECT COUNT(*) INTO manifest_count
        FROM "smartfix_manifests" WHERE "request_id" = NEW."id";
        IF manifest_count <> 1 THEN
            RAISE EXCEPTION 'smartfix_request % is DELIVERED with % manifest(s)',
                NEW."id", manifest_count
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        SELECT "status"::text INTO recheck_status
        FROM "document_checks" WHERE "id" = NEW."recheck_check_id";
        IF recheck_status IS DISTINCT FROM 'COMPLETED' THEN
            RAISE EXCEPTION 'smartfix_request % is DELIVERED but its recheck is %',
                NEW."id", COALESCE(recheck_status, 'missing')
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        SELECT "visible_to_owner" INTO corrected_visible
        FROM "document_versions" WHERE "id" = NEW."corrected_document_version_id";
        IF corrected_visible IS DISTINCT FROM TRUE THEN
            RAISE EXCEPTION 'smartfix_request % is DELIVERED but its corrected version is hidden',
                NEW."id"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF purchase_status NOT IN ('DELIVERED', 'REFUNDED') THEN
            RAISE EXCEPTION 'smartfix_request % is DELIVERED but its purchase is %',
                NEW."id", COALESCE(purchase_status, 'missing')
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;

    IF NEW."status" IN ('FAILED', 'CANCELLED') THEN
        -- The failure path is free. This is the invariant that makes that
        -- promise true rather than merely intended (§80, §120).
        IF purchase_status IS DISTINCT FROM 'RELEASED' THEN
            RAISE EXCEPTION 'smartfix_request % is % but its purchase is %',
                NEW."id", NEW."status", COALESCE(purchase_status, 'missing')
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        SELECT COUNT(*) INTO charged
        FROM "service_purchase_allocations" a
        JOIN "credit_holds" h ON h."id" = a."hold_id"
        WHERE a."purchase_id" = NEW."service_purchase_id" AND h."status" = 'CAPTURED';
        IF charged > 0 THEN
            RAISE EXCEPTION 'smartfix_request % is % but % reservation(s) were charged',
                NEW."id", NEW."status", charged
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        -- A failed correction delivers nothing, so nothing it produced may be
        -- visible (§84).
        IF NEW."corrected_document_version_id" IS NOT NULL THEN
            SELECT "visible_to_owner" INTO corrected_visible
            FROM "document_versions" WHERE "id" = NEW."corrected_document_version_id";
            IF corrected_visible THEN
                RAISE EXCEPTION 'smartfix_request % is % but its output is visible',
                    NEW."id", NEW."status"
                    USING ERRCODE = 'integrity_constraint_violation';
            END IF;
        END IF;
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "smartfix_requests_settlement"
    AFTER INSERT OR UPDATE ON "smartfix_requests"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION smartfix_requests_settlement_trigger();

-- The same question from the purchase's side: a SMARTFIX purchase that was
-- charged must have delivered a correction (§126, §199).
CREATE OR REPLACE FUNCTION service_purchases_settlement_trigger()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    captured bigint;
    uncaptured integer;
    check_status text;
    request_status text;
    charged integer;
BEGIN
    PERFORM service_purchase_allocation_sum(NEW."id");

    IF NEW."status" = 'RECONCILIATION_REQUIRED' THEN RETURN NULL; END IF;

    IF NEW."status" IN ('DELIVERED', 'REFUNDED') THEN
        SELECT COUNT(*) INTO uncaptured
        FROM "service_purchase_allocations" a
        JOIN "credit_holds" h ON h."id" = a."hold_id"
        WHERE a."purchase_id" = NEW."id" AND h."status" <> 'CAPTURED';

        IF uncaptured > 0 THEN
            RAISE EXCEPTION 'service_purchase % is % with % uncaptured reservation(s)',
                NEW."id", NEW."status", uncaptured
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        SELECT COALESCE(SUM(h."amount_minor"), 0) INTO captured
        FROM "service_purchase_allocations" a
        JOIN "credit_holds" h ON h."id" = a."hold_id"
        WHERE a."purchase_id" = NEW."id";

        IF captured <> NEW."amount_minor" THEN
            RAISE EXCEPTION 'service_purchase % charged % but costs %',
                NEW."id", captured, NEW."amount_minor"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF NEW."resource_type" = 'DOCUMENT_CHECK' THEN
            SELECT "status"::text INTO check_status
            FROM "document_checks" WHERE "id" = NEW."resource_id";
            IF check_status IS DISTINCT FROM 'COMPLETED' THEN
                RAISE EXCEPTION 'service_purchase % is % but document_check % is %',
                    NEW."id", NEW."status", NEW."resource_id", COALESCE(check_status, 'missing')
                    USING ERRCODE = 'integrity_constraint_violation';
            END IF;
        ELSIF NEW."resource_type" = 'SMARTFIX' THEN
            SELECT "status"::text INTO request_status
            FROM "smartfix_requests" WHERE "id" = NEW."resource_id";
            IF request_status IS DISTINCT FROM 'DELIVERED' THEN
                RAISE EXCEPTION 'service_purchase % is % but smartfix_request % is %',
                    NEW."id", NEW."status", NEW."resource_id", COALESCE(request_status, 'missing')
                    USING ERRCODE = 'integrity_constraint_violation';
            END IF;
        END IF;
    END IF;

    IF NEW."status" = 'RELEASED' THEN
        SELECT COUNT(*) INTO charged
        FROM "service_purchase_allocations" a
        JOIN "credit_holds" h ON h."id" = a."hold_id"
        WHERE a."purchase_id" = NEW."id" AND h."status" = 'CAPTURED';

        IF charged > 0 THEN
            RAISE EXCEPTION 'service_purchase % is RELEASED but % reservation(s) were charged',
                NEW."id", charged
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        SELECT COUNT(*) INTO charged
        FROM "service_purchase_allocations" a
        JOIN "credit_ledger_entries" e
          ON e."reference_type" = 'CREDIT_HOLD' AND e."reference_id" = a."hold_id"
        WHERE a."purchase_id" = NEW."id" AND e."entry_type" = 'SERVICE_CHARGE';

        IF charged > 0 THEN
            RAISE EXCEPTION 'service_purchase % is RELEASED but has % service charge(s)',
                NEW."id", charged
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;

    RETURN NULL;
END;
$$;

-- =============================================================================
-- 7. Isolation classification (§128)
-- =============================================================================
INSERT INTO "table_isolation_classification" ("table_name", "classification", "tenant_column", "notes")
VALUES
    ('smartfix_plans', 'USER_SCOPED', 'owner_user_id',
     'What PalCert would change in one person''s document. The organization whose standard was checked has no access at all.'),
    ('smartfix_requests', 'USER_SCOPED', 'owner_user_id',
     'One paid correction of one person''s document.'),
    ('smartfix_manifests', 'USER_SCOPED', 'owner_user_id',
     'Proof of what a correction changed, and of what it did not.')
ON CONFLICT ("table_name") DO NOTHING;

-- =============================================================================
-- 8. Row-level security (§128, §129, §130)
-- =============================================================================
ALTER TABLE "smartfix_plans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "smartfix_plans" FORCE ROW LEVEL SECURITY;
CREATE POLICY "smartfix_plans_owner" ON "smartfix_plans" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "smartfix_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "smartfix_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "smartfix_requests_owner" ON "smartfix_requests" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "smartfix_manifests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "smartfix_manifests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "smartfix_manifests_owner" ON "smartfix_manifests" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

-- =============================================================================
-- 9. Grants
-- =============================================================================
GRANT SELECT, INSERT, UPDATE ON "smartfix_requests" TO "palcert_app";
GRANT SELECT, INSERT ON "smartfix_plans" TO "palcert_app";
GRANT SELECT, INSERT ON "smartfix_manifests" TO "palcert_app";

-- A plan is an immutable record of what was proposed, and a manifest of what
-- happened. Neither is edited, and neither is deleted: a user asking "what did
-- you change in my thesis?" must get the same answer for ever. As elsewhere,
-- the triggers are the belt and the revoked privilege is the braces, because
-- Phase 2's default privileges would otherwise have granted both quietly.
REVOKE UPDATE, DELETE ON "smartfix_plans" FROM "palcert_app";
REVOKE UPDATE, DELETE ON "smartfix_manifests" FROM "palcert_app";
REVOKE DELETE ON "smartfix_requests" FROM "palcert_app";

-- A correction's durable work is customer work with an owner, so it lands in
-- the ordinary owner-scoped branch of the tenancy rule.
ALTER TABLE "processing_jobs" DROP CONSTRAINT "processing_jobs_resource_type_known";
ALTER TABLE "processing_jobs"
    ADD CONSTRAINT "processing_jobs_resource_type_known"
    CHECK ("resource_type" IN (
        'DOCUMENT_VERSION', 'DOCUMENT', 'DOCUMENT_ANALYSIS', 'DOCUMENT_CHECK', 'CHECK_RUN', 'AI_REVIEW',
        'STANDARD_SOURCE_ASSET', 'RULE_EXTRACTION_RUN',
        'PAYMENT_PROVIDER_EVENT', 'PAYMENT_RECONCILIATION',
        'SMARTFIX_REQUEST'));

-- =============================================================================
-- 10. Permissions (§130)
-- =============================================================================
INSERT INTO "permissions" ("id", "code", "description") VALUES
    (gen_random_uuid(), 'smartfix:read:self',
     'Read correction plans and corrections of your own documents'),
    (gen_random_uuid(), 'smartfix:create:self',
     'Plan and buy a correction of your own document')
ON CONFLICT ("code") DO NOTHING;

-- Self-service, exactly as the check permissions are: given to every role that
-- already carries the self-service baseline, and to no organization role. An
-- institution publishing a standard gains no ability to alter anybody's
-- document (§129).
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT rp."role_id", p."id"
FROM "role_permissions" rp
JOIN "permissions" baseline ON baseline."id" = rp."permission_id" AND baseline."code" = 'profile:read:self'
CROSS JOIN "permissions" p
WHERE p."code" IN ('smartfix:read:self', 'smartfix:create:self')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- =============================================================================
-- 11. A correction is a reason to keep a document
--
--     The source of a correction must not be purged while the corrected
--     version claims it as a parent: a lineage pointing at bytes that no
--     longer exist is a record nobody can verify.
-- =============================================================================
ALTER TABLE "document_retention_locks" DROP CONSTRAINT "document_retention_locks_type_known";
ALTER TABLE "document_retention_locks"
    ADD CONSTRAINT "document_retention_locks_type_known"
    CHECK ("lock_type" IN (
        'CHECK', 'REPORT', 'CERTIFICATE', 'FINANCIAL_RECORD', 'SUBMISSION', 'LEGAL_HOLD',
        'SMARTFIX'));
