-- =============================================================================
-- Phase 15 — the certificate row must not hold a working verification code
--
-- `certificate_number` was `PC-` plus the *same* 32 Crockford symbols as the
-- verification code, with hyphens for readability. Stripping four hyphens and
-- a prefix is not a transformation, so the column was a plaintext capability:
-- one SELECT over the table handed the reader a working public verification
-- for every certificate that had ever been issued.
--
-- The invariant this migration establishes:
--
--     a compromised certificate row  ≠  instant disclosure of every
--                                       public verification capability
--
-- What replaces it:
--
--   * `verification_code_hash` stays, unique, and remains the only lookup
--     authority. It is one-way, so it discloses nothing.
--   * `verification_code_ciphertext` is *issuance staging material* and
--     nothing else: AES-256-GCM under a key held by the application, never by
--     PostgreSQL, so a database compromise alone cannot open it. It exists
--     only while the worker still needs the plaintext to build the claim and
--     render the PDF, and `app_certificate_issue` erases it in the same
--     statement that marks the certificate ISSUED.
--   * The human-readable number lives where the holder's copies live: in the
--     private immutable claim artifact, in the PDF and in the QR. Public
--     verification reconstructs it from the code the caller supplied, because
--     a caller who can verify already holds the code.
--
-- Nothing else about Phase 15 moves. Eligibility, the claim, its hash, the
-- deterministic bilingual PDF, revocation, the retry lifecycle and the
-- dual-party read model are all unchanged.
-- =============================================================================

-- --- 1. The staging column ---------------------------------------------------
--
-- Nullable by design: NULL is the normal state of an issued certificate, and
-- the constraint below says so rather than leaving it to convention.
ALTER TABLE "compliance_certificates"
    ADD COLUMN "verification_code_ciphertext" TEXT;

COMMENT ON COLUMN "compliance_certificates"."verification_code_ciphertext" IS
    'AES-256-GCM sealed canonical verification code, readable only by the '
    'application. Issuance staging material: erased when the certificate is '
    'issued or permanently fails. Never logged, never audited, never in an '
    'API view.';

-- §92: an issued certificate has no staging material left. A row that still
-- carried it would be a capability nobody needs, kept for ever.
ALTER TABLE "compliance_certificates"
    ADD CONSTRAINT "compliance_certificates_staging_is_cleared"
    CHECK ("issuance_status" NOT IN ('ISSUED', 'REVOKED', 'FAILED_PERMANENT')
        OR "verification_code_ciphertext" IS NULL);

-- --- 2. The plaintext capability goes ----------------------------------------
--
-- Dropped rather than renamed. A column that still held `PC-…` under another
-- name would be the same disclosure with a better cover story.
DROP INDEX IF EXISTS "compliance_certificates_number_key";

ALTER TABLE "compliance_certificates"
    DROP CONSTRAINT IF EXISTS "compliance_certificates_number_format";

ALTER TABLE "compliance_certificates"
    DROP COLUMN "certificate_number";

-- --- 3. The claim, re-pointed at the ciphertext ------------------------------
--
-- Takes the sealed code in place of the formatted number. A pre-correction row
-- that never issued has a hash whose code cannot be recovered, so a claim
-- against it re-keys: new code, new hash, new ciphertext. That is safe
-- precisely because nothing was ever issued from it — no PDF, no QR and no
-- number has been shown to anybody. An ISSUED or REVOKED row is returned
-- untouched, and a retry that still has its ciphertext keeps its code, which
-- is what §76 and the approved lifecycle require.
-- Dropped first: the replaced function has the same signature with a
-- differently named fourth parameter, and PostgreSQL will not rename one in
-- place.
DROP FUNCTION IF EXISTS app_certificate_claim(uuid, uuid, text, text);

CREATE FUNCTION app_certificate_claim(
    p_certificate_id uuid,
    p_revision_id uuid,
    p_verification_code_hash text,
    p_verification_code_ciphertext text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    revision "submission_revisions"%ROWTYPE;
    submission "official_submissions"%ROWTYPE;
    approval_id uuid;
    existing "compliance_certificates"%ROWTYPE;
BEGIN
    SELECT * INTO revision FROM "submission_revisions" WHERE "id" = p_revision_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'submission_revision % does not exist', p_revision_id;
    END IF;

    SELECT * INTO submission FROM "official_submissions" WHERE "id" = revision."submission_id";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'official_submission % does not exist', revision."submission_id";
    END IF;

    IF revision."processing_status" <> 'READY'
       OR revision."determination" <> 'COMPLIANT'
       OR revision."institution_decision_status" <> 'APPROVED'
       OR submission."current_revision_id" IS DISTINCT FROM revision."id"
    THEN
        RAISE EXCEPTION 'submission_revision % is not certificate-eligible', p_revision_id
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT "id" INTO approval_id FROM "submission_decision_events"
     WHERE "submission_revision_id" = revision."id"
       AND "organization_id" = revision."organization_id"
       AND "to_status" = 'APPROVED'
       AND "event_source" = 'ORGANIZATION'
     ORDER BY "created_at" DESC, "id" DESC
     LIMIT 1;

    IF approval_id IS NULL THEN
        RAISE EXCEPTION 'submission_revision % has no organization approval event', p_revision_id
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT * INTO existing FROM "compliance_certificates"
     WHERE "submission_revision_id" = revision."id" FOR UPDATE;
    IF FOUND THEN
        IF existing."issuance_status" IN ('ISSUED', 'REVOKED', 'FAILED_PERMANENT') THEN
            RETURN existing."id";
        END IF;

        PERFORM set_config('palcert.certificate_system_write', 'on', true);

        IF existing."verification_code_ciphertext" IS NULL THEN
            -- Nothing was ever issued from this row and its code is not
            -- recoverable, so it is re-keyed rather than abandoned.
            UPDATE "compliance_certificates"
               SET "verification_code_hash" = p_verification_code_hash,
                   "verification_code_ciphertext" = p_verification_code_ciphertext,
                   "issuance_status" = 'PENDING',
                   "failure_code" = NULL,
                   "failure_detail" = NULL,
                   "updated_at" = now()
             WHERE "id" = existing."id";
        ELSIF existing."issuance_status" = 'FAILED_RETRYABLE' THEN
            -- §76 and correction §4: the same identity, the same code.
            UPDATE "compliance_certificates"
               SET "issuance_status" = 'PENDING',
                   "failure_code" = NULL,
                   "failure_detail" = NULL,
                   "updated_at" = now()
             WHERE "id" = existing."id";
        END IF;

        PERFORM set_config('palcert.certificate_system_write', 'off', true);
        RETURN existing."id";
    END IF;

    PERFORM set_config('palcert.certificate_system_write', 'on', true);
    INSERT INTO "compliance_certificates" (
        "id", "owner_user_id", "organization_id", "submission_id", "submission_revision_id",
        "approval_decision_event_id", "verification_code_hash", "verification_code_ciphertext",
        "issuance_status", "created_at", "updated_at"
    ) VALUES (
        p_certificate_id, revision."owner_user_id", revision."organization_id",
        revision."submission_id", revision."id", approval_id,
        p_verification_code_hash, p_verification_code_ciphertext, 'PENDING', now(), now()
    );
    PERFORM set_config('palcert.certificate_system_write', 'off', true);

    RETURN p_certificate_id;
END;
$$;

-- --- 4. Issuance erases the staging material ---------------------------------
--
-- In the same statement that marks the row ISSUED, so there is no window in
-- which an issued certificate still carries an openable copy of its code.
CREATE OR REPLACE FUNCTION app_certificate_issue(
    p_certificate_id uuid,
    p_claim_schema_version integer,
    p_claim_canonicalization_version integer,
    p_claim_hash text,
    p_claim_object_key text,
    p_claim_object_version_id text,
    p_claim_object_sha256 text,
    p_certificate_object_key text,
    p_certificate_object_version_id text,
    p_certificate_object_sha256 text,
    p_renderer_name text,
    p_renderer_version text,
    p_template_version text,
    p_valid_until timestamptz
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    certificate "compliance_certificates"%ROWTYPE;
    v_now timestamptz := now();
BEGIN
    SELECT * INTO certificate FROM "compliance_certificates"
     WHERE "id" = p_certificate_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'compliance_certificate % does not exist', p_certificate_id;
    END IF;

    IF certificate."issuance_status" <> 'PENDING' THEN RETURN false; END IF;

    PERFORM set_config('palcert.certificate_system_write', 'on', true);

    UPDATE "compliance_certificates" SET
        "claim_schema_version" = p_claim_schema_version,
        "claim_canonicalization_version" = p_claim_canonicalization_version,
        "claim_hash" = p_claim_hash,
        "claim_object_key" = p_claim_object_key,
        "claim_object_version_id" = p_claim_object_version_id,
        "claim_object_sha256" = p_claim_object_sha256,
        "certificate_object_key" = p_certificate_object_key,
        "certificate_object_version_id" = p_certificate_object_version_id,
        "certificate_object_sha256" = p_certificate_object_sha256,
        "renderer_name" = p_renderer_name,
        "renderer_version" = p_renderer_version,
        "template_version" = p_template_version,
        "issuance_status" = 'ISSUED',
        "issued_at" = v_now,
        "valid_until" = p_valid_until,
        "failure_code" = NULL,
        "failure_detail" = NULL,
        -- The claim artifact and the PDF now carry the code. The row stops
        -- carrying it, for good.
        "verification_code_ciphertext" = NULL,
        "updated_at" = v_now
     WHERE "id" = p_certificate_id;

    INSERT INTO "certificate_events" (
        "id", "certificate_id", "owner_user_id", "organization_id",
        "event_type", "event_source", "actor_user_id", "reason_code", "comment", "created_at"
    ) VALUES (
        gen_random_uuid(), certificate."id", certificate."owner_user_id",
        certificate."organization_id", 'ISSUED', 'SYSTEM', NULL, NULL, NULL, v_now
    );

    PERFORM set_config('palcert.certificate_system_write', 'off', true);
    RETURN true;
END;
$$;

-- --- 5. A permanent failure erases it too ------------------------------------
--
-- Nothing will ever be issued from that row, so keeping even sealed capability
-- material would be keeping it for no reason. A retryable failure keeps its
-- ciphertext, because the retry has to produce the same code.
CREATE OR REPLACE FUNCTION app_certificate_fail(
    p_certificate_id uuid,
    p_failure_code text,
    p_failure_detail text,
    p_permanent boolean
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    certificate "compliance_certificates"%ROWTYPE;
BEGIN
    SELECT * INTO certificate FROM "compliance_certificates"
     WHERE "id" = p_certificate_id FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    IF certificate."issuance_status" <> 'PENDING' THEN RETURN false; END IF;

    PERFORM set_config('palcert.certificate_system_write', 'on', true);
    UPDATE "compliance_certificates" SET
        "issuance_status" = CASE WHEN p_permanent THEN 'FAILED_PERMANENT' ELSE 'FAILED_RETRYABLE' END,
        "failure_code" = p_failure_code,
        "failure_detail" = left(p_failure_detail, 500),
        "verification_code_ciphertext" =
            CASE WHEN p_permanent THEN NULL ELSE certificate."verification_code_ciphertext" END,
        "updated_at" = now()
     WHERE "id" = p_certificate_id;
    PERFORM set_config('palcert.certificate_system_write', 'off', true);
    RETURN true;
END;
$$;

-- --- 6. The guard, with the number gone and the staging rules added ----------
CREATE OR REPLACE FUNCTION compliance_certificates_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."owner_user_id" IS DISTINCT FROM OLD."owner_user_id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."submission_id" IS DISTINCT FROM OLD."submission_id"
       OR NEW."submission_revision_id" IS DISTINCT FROM OLD."submission_revision_id"
       OR NEW."approval_decision_event_id" IS DISTINCT FROM OLD."approval_decision_event_id"
    THEN
        RAISE EXCEPTION 'compliance_certificate % identity is immutable', OLD."id";
    END IF;

    -- The lookup digest may be re-keyed only while the certificate has never
    -- been issued *and* its code is unrecoverable — the pre-correction row
    -- above. Once anything has been issued against a code, the digest that
    -- resolves it is fixed for ever, or an old QR would stop working.
    IF NEW."verification_code_hash" IS DISTINCT FROM OLD."verification_code_hash"
       AND NOT (OLD."issuance_status" IN ('PENDING', 'FAILED_RETRYABLE')
                AND OLD."verification_code_ciphertext" IS NULL)
    THEN
        RAISE EXCEPTION 'compliance_certificate % verification code is immutable', OLD."id";
    END IF;

    -- Staging material is written once at claim time and only ever erased.
    -- Re-sealing an issued certificate's code would put a capability back into
    -- the row that issuance deliberately removed.
    IF NEW."verification_code_ciphertext" IS NOT NULL
       AND OLD."verification_code_ciphertext" IS NOT NULL
       AND NEW."verification_code_ciphertext" IS DISTINCT FROM OLD."verification_code_ciphertext"
    THEN
        RAISE EXCEPTION 'compliance_certificate % verification code is immutable', OLD."id";
    END IF;
    IF NEW."verification_code_ciphertext" IS NOT NULL
       AND OLD."verification_code_ciphertext" IS NULL
       AND OLD."issuance_status" NOT IN ('PENDING', 'FAILED_RETRYABLE')
    THEN
        RAISE EXCEPTION 'compliance_certificate % is issued and its claim is write-once', OLD."id";
    END IF;

    IF OLD."issuance_status" IN ('ISSUED', 'REVOKED') THEN
        IF NEW."claim_hash" IS DISTINCT FROM OLD."claim_hash"
           OR NEW."claim_object_key" IS DISTINCT FROM OLD."claim_object_key"
           OR NEW."claim_object_version_id" IS DISTINCT FROM OLD."claim_object_version_id"
           OR NEW."claim_object_sha256" IS DISTINCT FROM OLD."claim_object_sha256"
           OR NEW."certificate_object_key" IS DISTINCT FROM OLD."certificate_object_key"
           OR NEW."certificate_object_version_id" IS DISTINCT FROM OLD."certificate_object_version_id"
           OR NEW."certificate_object_sha256" IS DISTINCT FROM OLD."certificate_object_sha256"
           OR NEW."claim_schema_version" IS DISTINCT FROM OLD."claim_schema_version"
           OR NEW."claim_canonicalization_version" IS DISTINCT FROM OLD."claim_canonicalization_version"
           OR NEW."renderer_name" IS DISTINCT FROM OLD."renderer_name"
           OR NEW."renderer_version" IS DISTINCT FROM OLD."renderer_version"
           OR NEW."template_version" IS DISTINCT FROM OLD."template_version"
           OR NEW."issued_at" IS DISTINCT FROM OLD."issued_at"
           OR NEW."valid_until" IS DISTINCT FROM OLD."valid_until"
        THEN
            RAISE EXCEPTION 'compliance_certificate % is issued and its claim is write-once', OLD."id";
        END IF;
    END IF;

    IF NEW."issuance_status" IS DISTINCT FROM OLD."issuance_status" THEN
        IF NOT (
            (OLD."issuance_status" = 'PENDING' AND NEW."issuance_status" IN
                ('ISSUED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT'))
            OR (OLD."issuance_status" = 'FAILED_RETRYABLE' AND NEW."issuance_status" = 'PENDING')
            OR (OLD."issuance_status" = 'ISSUED' AND NEW."issuance_status" = 'REVOKED')
        ) THEN
            RAISE EXCEPTION 'compliance_certificate % cannot move from % to %',
                OLD."id", OLD."issuance_status", NEW."issuance_status";
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- --- 7. The public projection stops returning a number ------------------------
--
-- It never needed to. A caller who can verify already holds the code, so the
-- displayed number is reconstructed from the request rather than read from a
-- column that should not exist.
DROP FUNCTION IF EXISTS app_public_certificate(text);

CREATE OR REPLACE FUNCTION app_public_certificate(p_verification_code_hash text)
RETURNS TABLE (
    "issuance_status" text,
    "issued_at" timestamptz,
    "valid_until" timestamptz,
    "revoked_at" timestamptz,
    "revocation_reason" text,
    "organization_name" text,
    "document_type_name" text,
    "document_format" text,
    "standard_code" text,
    "standard_name" text,
    "standard_version_label" text,
    "document_sha256" text,
    "report_hash" text,
    "standard_content_hash" text,
    "submission_evidence_hash" text,
    "claim_hash" text,
    "certificate_object_sha256" text
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT c."issuance_status",
           c."issued_at",
           c."valid_until",
           c."revoked_at",
           c."revocation_reason",
           s."organization_name",
           s."document_type_name",
           r."source_document_format",
           r."standard_code",
           r."standard_name",
           r."standard_version_label",
           r."source_document_sha256",
           r."source_report_hash",
           r."standard_content_hash",
           r."evidence_hash",
           c."claim_hash",
           c."certificate_object_sha256"
      FROM "compliance_certificates" c
      JOIN "submission_revisions" r ON r."id" = c."submission_revision_id"
      JOIN "official_submissions" s ON s."id" = c."submission_id"
     WHERE c."verification_code_hash" = p_verification_code_hash
       AND c."issuance_status" IN ('ISSUED', 'REVOKED');
$$;

GRANT EXECUTE ON FUNCTION app_public_certificate(text) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_certificate_claim(uuid, uuid, text, text) TO "palcert_app";
