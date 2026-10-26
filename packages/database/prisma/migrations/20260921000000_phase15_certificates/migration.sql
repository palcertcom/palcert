-- =============================================================================
-- Phase 15 — approval-gated certificates and public verification
--
-- A certificate exists only where PalCert said COMPLIANT and the receiving
-- organization said APPROVED about the same immutable submission revision. The
-- two authorities Phase 14 separated stay separated: this table records that
-- they agreed, and can never be used to make one of them say something else.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The certificate
-- -----------------------------------------------------------------------------
CREATE TABLE "compliance_certificates" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "submission_revision_id" UUID NOT NULL,
    "approval_decision_event_id" UUID NOT NULL,

    -- The digest of the canonical verification code, never the code itself.
    -- A database read that should not have happened hands somebody hashes, not
    -- a working verification capability for every certificate at once.
    "verification_code_hash" CHAR(64) NOT NULL,
    "certificate_number" TEXT NOT NULL,

    "issuance_status" TEXT NOT NULL DEFAULT 'PENDING',

    "claim_schema_version" INTEGER,
    "claim_canonicalization_version" INTEGER,
    "claim_hash" CHAR(64),

    "claim_object_key" TEXT,
    "claim_object_version_id" TEXT,
    "claim_object_sha256" CHAR(64),

    "certificate_object_key" TEXT,
    "certificate_object_version_id" TEXT,
    "certificate_object_sha256" CHAR(64),

    "renderer_name" TEXT,
    "renderer_version" TEXT,
    "template_version" TEXT,

    "issued_at" TIMESTAMPTZ(6),
    "valid_until" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revocation_reason" TEXT,

    "failure_code" TEXT,
    "failure_detail" TEXT,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "compliance_certificates_pkey" PRIMARY KEY ("id"),

    -- The certificate's own vocabulary. Never APPROVED, never COMPLIANT:
    -- those words belong to the evidence, and reusing them here would be the
    -- first step towards one status standing for all three.
    CONSTRAINT "compliance_certificates_issuance_status_check"
        CHECK ("issuance_status" IN
            ('PENDING', 'ISSUED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT', 'REVOKED')),

    CONSTRAINT "compliance_certificates_revocation_reason_check"
        CHECK ("revocation_reason" IS NULL OR "revocation_reason" IN
            ('ISSUED_IN_ERROR', 'EVIDENCE_INTEGRITY_FAILURE', 'ADMINISTRATIVE_CORRECTION',
             'SECURITY_INCIDENT', 'OTHER')),

    -- ISSUED means everything a certificate needs really exists. A row with
    -- some of it would describe an issuance that half happened, and public
    -- verification would be answering about an artifact nobody can produce.
    CONSTRAINT "compliance_certificates_issued_is_complete"
        CHECK ("issuance_status" NOT IN ('ISSUED', 'REVOKED') OR (
            "claim_hash" IS NOT NULL
            AND "claim_object_key" IS NOT NULL
            AND "claim_object_sha256" IS NOT NULL
            AND "certificate_object_key" IS NOT NULL
            AND "certificate_object_sha256" IS NOT NULL
            AND "claim_schema_version" IS NOT NULL
            AND "claim_canonicalization_version" IS NOT NULL
            AND "renderer_name" IS NOT NULL
            AND "renderer_version" IS NOT NULL
            AND "template_version" IS NOT NULL
            AND "issued_at" IS NOT NULL
        )),

    -- Revocation records when and why, or it is not a revocation.
    CONSTRAINT "compliance_certificates_revoked_is_explained"
        CHECK ("issuance_status" <> 'REVOKED' OR
            ("revoked_at" IS NOT NULL AND "revocation_reason" IS NOT NULL)),

    -- And nothing that is not revoked may claim to have been.
    CONSTRAINT "compliance_certificates_revocation_requires_revoked"
        CHECK ("issuance_status" = 'REVOKED'
            OR ("revoked_at" IS NULL AND "revocation_reason" IS NULL)),

    -- A failure names its cause; a success has none.
    CONSTRAINT "compliance_certificates_failure_shape"
        CHECK (
            ("issuance_status" IN ('FAILED_RETRYABLE', 'FAILED_PERMANENT') AND "failure_code" IS NOT NULL)
            OR ("issuance_status" NOT IN ('FAILED_RETRYABLE', 'FAILED_PERMANENT') AND "failure_code" IS NULL)
        ),

    CONSTRAINT "compliance_certificates_number_format"
        CHECK ("certificate_number" ~ '^PC-[0-9A-HJKMNP-TV-Z]{8}(-[0-9A-HJKMNP-TV-Z]{8}){3}$')
);

-- §25: one certificate identity per official revision. A retry reuses this
-- row — same id, same verification code, same binding — rather than minting a
-- second certificate for one approval.
CREATE UNIQUE INDEX "compliance_certificates_revision_key"
    ON "compliance_certificates"("submission_revision_id");
CREATE UNIQUE INDEX "compliance_certificates_verification_code_hash_key"
    ON "compliance_certificates"("verification_code_hash");
CREATE UNIQUE INDEX "compliance_certificates_number_key"
    ON "compliance_certificates"("certificate_number");

CREATE INDEX "compliance_certificates_org_idx"
    ON "compliance_certificates"("organization_id", "issued_at", "id");
CREATE INDEX "compliance_certificates_owner_idx"
    ON "compliance_certificates"("owner_user_id", "created_at", "id");
-- Reconciliation reads this one: eligible work waiting to be picked up.
CREATE INDEX "compliance_certificates_status_idx"
    ON "compliance_certificates"("issuance_status", "updated_at");

ALTER TABLE "compliance_certificates"
    ADD CONSTRAINT "compliance_certificates_owner_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;

ALTER TABLE "compliance_certificates"
    ADD CONSTRAINT "compliance_certificates_revision_fkey"
    FOREIGN KEY ("submission_revision_id") REFERENCES "submission_revisions"("id") ON DELETE RESTRICT;

-- -----------------------------------------------------------------------------
-- 2. Append-only history
-- -----------------------------------------------------------------------------
CREATE TABLE "certificate_events" (
    "id" UUID NOT NULL,
    "certificate_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_source" TEXT NOT NULL,
    "actor_user_id" UUID,
    "reason_code" TEXT,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificate_events_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "certificate_events_type_check"
        CHECK ("event_type" IN ('ISSUED', 'REVOKED')),
    CONSTRAINT "certificate_events_source_check"
        CHECK ("event_source" IN ('SYSTEM', 'ORGANIZATION', 'PALCERT_ADMIN')),

    -- PalCert issues; it never revokes on somebody's behalf and never has an
    -- actor. A SYSTEM row claiming a human made it is refused outright.
    CONSTRAINT "certificate_events_system_shape"
        CHECK ("event_source" <> 'SYSTEM' OR (
            "event_type" = 'ISSUED' AND "actor_user_id" IS NULL
            AND "reason_code" IS NULL AND "comment" IS NULL
        )),

    -- A person only ever revokes, and is always named.
    CONSTRAINT "certificate_events_human_shape"
        CHECK ("event_source" = 'SYSTEM' OR (
            "event_type" = 'REVOKED' AND "actor_user_id" IS NOT NULL AND "reason_code" IS NOT NULL
        )),

    CONSTRAINT "certificate_events_reason_check"
        CHECK ("reason_code" IS NULL OR "reason_code" IN
            ('ISSUED_IN_ERROR', 'EVIDENCE_INTEGRITY_FAILURE', 'ADMINISTRATIVE_CORRECTION',
             'SECURITY_INCIDENT', 'OTHER')),

    CONSTRAINT "certificate_events_comment_bounded"
        CHECK ("comment" IS NULL OR length("comment") BETWEEN 1 AND 2000)
);

CREATE INDEX "certificate_events_certificate_idx"
    ON "certificate_events"("certificate_id", "created_at", "id");
CREATE INDEX "certificate_events_org_idx"
    ON "certificate_events"("organization_id", "created_at", "id");

ALTER TABLE "certificate_events"
    ADD CONSTRAINT "certificate_events_certificate_fkey"
    FOREIGN KEY ("certificate_id") REFERENCES "compliance_certificates"("id") ON DELETE RESTRICT;

-- One ISSUED event per certificate, whatever the queue delivers.
CREATE UNIQUE INDEX "certificate_events_one_issued"
    ON "certificate_events"("certificate_id") WHERE "event_type" = 'ISSUED';

-- =============================================================================
-- 3. Isolation
--
-- Certificates are dual-party for the same reason submissions are: the subject
-- and the approving organization both legitimately read them. Phase 14's
-- corrected principle carries straight over — dual-party means shared *reads*,
-- never shared generic writes (§122).
--
-- Here the asymmetry is stronger still. Neither party may create a
-- certificate: issuance is PalCert's, because a certificate that either the
-- subject or the institution could insert would be worth nothing to a verifier.
-- =============================================================================

ALTER TABLE "compliance_certificates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "compliance_certificates" FORCE ROW LEVEL SECURITY;
ALTER TABLE "certificate_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "certificate_events" FORCE ROW LEVEL SECURITY;

-- The system writer, recognised exactly as Phase 14 recognises its own:
-- a role switch only a SECURITY DEFINER function owned by a privileged role
-- can reach, *and* a transaction-local flag. The flag alone is forgeable by
-- `palcert_app` and buys nothing; the role switch is the real boundary.
CREATE OR REPLACE FUNCTION app_is_certificate_system_writer() RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT current_user IS DISTINCT FROM session_user
       AND COALESCE(current_setting('palcert.certificate_system_write', true), 'off') = 'on';
$$;

-- --- compliance_certificates -------------------------------------------------
--   SELECT  subject, approving organization, audited platform admin
--   INSERT  the system only
--   UPDATE  the system only (issuance and the narrow revocation path)
--   DELETE  nobody
CREATE POLICY "compliance_certificates_read" ON "compliance_certificates" FOR SELECT
    USING (app_is_platform_admin()
        OR "owner_user_id" = app_current_user_id()
        OR "organization_id" = app_current_organization());

CREATE POLICY "compliance_certificates_insert" ON "compliance_certificates" FOR INSERT
    WITH CHECK (app_is_certificate_system_writer());

CREATE POLICY "compliance_certificates_update" ON "compliance_certificates" FOR UPDATE
    USING (app_is_certificate_system_writer())
    WITH CHECK (app_is_certificate_system_writer());

-- --- certificate_events ------------------------------------------------------
--   SELECT  both parties
--   INSERT  the system only — revocation goes through the function below,
--           which writes the event as the authenticated reviewer
--   UPDATE  nobody
--   DELETE  nobody
CREATE POLICY "certificate_events_read" ON "certificate_events" FOR SELECT
    USING (app_is_platform_admin()
        OR "owner_user_id" = app_current_user_id()
        OR "organization_id" = app_current_organization());

CREATE POLICY "certificate_events_insert" ON "certificate_events" FOR INSERT
    WITH CHECK (app_is_certificate_system_writer());

GRANT SELECT, INSERT, UPDATE ON "compliance_certificates" TO "palcert_app";
GRANT SELECT, INSERT ON "certificate_events" TO "palcert_app";
-- §95: a certificate is verification history. It is never hard-deleted, so the
-- application role simply does not hold the privilege.
REVOKE DELETE ON "compliance_certificates" FROM "palcert_app";
REVOKE DELETE ON "certificate_events" FROM "palcert_app";

-- =============================================================================
-- 4. Immutability
--
-- Once issued, what the certificate asserts and which bytes assert it are
-- fixed. A later template, a renamed organization or an edited standard label
-- must never change what an old certificate says (§34, §94, §187, §188).
-- =============================================================================

CREATE OR REPLACE FUNCTION compliance_certificates_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- Identity, bound when the certificate was claimed and never re-pointed.
    IF NEW."owner_user_id" IS DISTINCT FROM OLD."owner_user_id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."submission_id" IS DISTINCT FROM OLD."submission_id"
       OR NEW."submission_revision_id" IS DISTINCT FROM OLD."submission_revision_id"
       OR NEW."approval_decision_event_id" IS DISTINCT FROM OLD."approval_decision_event_id"
       OR NEW."verification_code_hash" IS DISTINCT FROM OLD."verification_code_hash"
       OR NEW."certificate_number" IS DISTINCT FROM OLD."certificate_number"
    THEN
        RAISE EXCEPTION 'compliance_certificate % identity is immutable', OLD."id";
    END IF;

    -- The claim and the artifacts, once written. A second write would mean a
    -- verifier is being told about bytes other than the ones whose hash they
    -- were given.
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

    -- §69: no un-revoke, no re-issue, and a permanent failure stays failed.
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

CREATE TRIGGER "compliance_certificates_guard_trigger"
    BEFORE UPDATE ON "compliance_certificates"
    FOR EACH ROW EXECUTE FUNCTION compliance_certificates_guard();

CREATE OR REPLACE FUNCTION certificate_history_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% rows are immutable once written', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "certificate_events_append_only"
    BEFORE UPDATE OR DELETE ON "certificate_events"
    FOR EACH ROW EXECUTE FUNCTION certificate_history_is_append_only();

CREATE TRIGGER "compliance_certificates_no_delete"
    BEFORE DELETE ON "compliance_certificates"
    FOR EACH ROW EXECUTE FUNCTION certificate_history_is_append_only();

GRANT EXECUTE ON FUNCTION app_is_certificate_system_writer() TO "palcert_app";
GRANT EXECUTE ON FUNCTION compliance_certificates_guard() TO "palcert_app";
GRANT EXECUTE ON FUNCTION certificate_history_is_append_only() TO "palcert_app";

-- =============================================================================
-- 5. Claiming a certificate
--
-- The eligibility rule lives here, in the same statement that creates the row.
-- Putting it in a service alone would mean a future route, a script or a
-- support engineer could produce a certificate for something that never met
-- it — and a certificate is exactly the artifact where that must be
-- impossible rather than merely discouraged (§193, §194).
--
-- Even explicit platform elevation goes through this function. There is no
-- path that mints a certificate without COMPLIANT + APPROVED.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_certificate_claim(
    p_certificate_id uuid,
    p_revision_id uuid,
    p_verification_code_hash text,
    p_certificate_number text
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

    -- The eligibility predicate, in full and in one place.
    IF revision."processing_status" <> 'READY'
       OR revision."determination" <> 'COMPLIANT'
       OR revision."institution_decision_status" <> 'APPROVED'
       OR submission."current_revision_id" IS DISTINCT FROM revision."id"
    THEN
        RAISE EXCEPTION 'submission_revision % is not certificate-eligible', p_revision_id
            USING ERRCODE = 'check_violation';
    END IF;

    -- §7, §84: the status is not enough. There must be the matching immutable
    -- decision event, written by the organization itself — never a forged
    -- SYSTEM approval, and never one belonging to a different revision.
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

    -- §76: ten deliveries, one certificate. A retry finds the row it made
    -- last time and reuses its identity and its verification code.
    SELECT * INTO existing FROM "compliance_certificates"
     WHERE "submission_revision_id" = revision."id" FOR UPDATE;
    IF FOUND THEN
        IF existing."issuance_status" = 'FAILED_RETRYABLE' THEN
            PERFORM set_config('palcert.certificate_system_write', 'on', true);
            UPDATE "compliance_certificates"
               SET "issuance_status" = 'PENDING',
                   "failure_code" = NULL,
                   "failure_detail" = NULL,
                   "updated_at" = now()
             WHERE "id" = existing."id";
            PERFORM set_config('palcert.certificate_system_write', 'off', true);
        END IF;
        RETURN existing."id";
    END IF;

    PERFORM set_config('palcert.certificate_system_write', 'on', true);
    INSERT INTO "compliance_certificates" (
        "id", "owner_user_id", "organization_id", "submission_id", "submission_revision_id",
        "approval_decision_event_id", "verification_code_hash", "certificate_number",
        "issuance_status", "created_at", "updated_at"
    ) VALUES (
        p_certificate_id, revision."owner_user_id", revision."organization_id",
        revision."submission_id", revision."id", approval_id,
        p_verification_code_hash, p_certificate_number, 'PENDING', now(), now()
    );
    PERFORM set_config('palcert.certificate_system_write', 'off', true);

    RETURN p_certificate_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- Finalisation: the whole handoff in one statement, so a certificate is never
-- half issued (§90, §91).
-- -----------------------------------------------------------------------------
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
    issued_at timestamptz := now();
BEGIN
    SELECT * INTO certificate FROM "compliance_certificates"
     WHERE "id" = p_certificate_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'compliance_certificate % does not exist', p_certificate_id;
    END IF;

    -- Idempotent: a duplicate delivery finds it already issued and changes
    -- nothing, rather than writing a second artifact identity.
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
        "issued_at" = issued_at,
        "valid_until" = p_valid_until,
        "failure_code" = NULL,
        "failure_detail" = NULL,
        "updated_at" = issued_at
     WHERE "id" = p_certificate_id;

    INSERT INTO "certificate_events" (
        "id", "certificate_id", "owner_user_id", "organization_id",
        "event_type", "event_source", "actor_user_id", "reason_code", "comment", "created_at"
    ) VALUES (
        gen_random_uuid(), certificate."id", certificate."owner_user_id",
        certificate."organization_id", 'ISSUED', 'SYSTEM', NULL, NULL, NULL, issued_at
    );

    PERFORM set_config('palcert.certificate_system_write', 'off', true);
    RETURN true;
END;
$$;

-- -----------------------------------------------------------------------------
-- Recording a failure, split by whether retrying could ever help (§85, §86).
-- -----------------------------------------------------------------------------
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
        "updated_at" = now()
     WHERE "id" = p_certificate_id;
    PERFORM set_config('palcert.certificate_system_write', 'off', true);
    RETURN true;
END;
$$;

-- -----------------------------------------------------------------------------
-- Revocation (§62, §63, §70).
--
-- Withdraws the certificate and nothing else. The technical determination, the
-- institution's approval, the decision history and the issued PDF are all
-- untouched — the artifact keeps existing, and its QR now resolves to a page
-- that says REVOKED, which is the whole point of online verification.
--
-- The actor is the authenticated caller, taken from the session context rather
-- than from anything a request body said.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_certificate_revoke(
    p_certificate_id uuid,
    p_reason_code text,
    p_comment text,
    p_event_source text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    certificate "compliance_certificates"%ROWTYPE;
    actor uuid := app_current_user_id();
    revoked_at timestamptz := now();
BEGIN
    IF actor IS NULL THEN
        RAISE EXCEPTION 'certificate revocation requires an authenticated actor';
    END IF;
    IF p_event_source NOT IN ('ORGANIZATION', 'PALCERT_ADMIN') THEN
        RAISE EXCEPTION 'certificate revocation source % is not a person', p_event_source;
    END IF;

    SELECT * INTO certificate FROM "compliance_certificates"
     WHERE "id" = p_certificate_id FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;

    -- The caller must be acting for the organization that approved it, unless
    -- they are PalCert staff under explicit, audited elevation (§64).
    IF p_event_source = 'ORGANIZATION' THEN
        IF app_current_organization() IS DISTINCT FROM certificate."organization_id" THEN
            RAISE EXCEPTION 'compliance_certificate % belongs to another organization', p_certificate_id;
        END IF;
    ELSIF NOT app_is_platform_admin() THEN
        RAISE EXCEPTION 'platform revocation requires elevation';
    END IF;

    -- §69: already revoked is not an error to repeat, but it writes nothing.
    IF certificate."issuance_status" = 'REVOKED' THEN RETURN false; END IF;
    IF certificate."issuance_status" <> 'ISSUED' THEN
        RAISE EXCEPTION 'compliance_certificate % is %, not ISSUED',
            p_certificate_id, certificate."issuance_status";
    END IF;

    PERFORM set_config('palcert.certificate_system_write', 'on', true);

    UPDATE "compliance_certificates" SET
        "issuance_status" = 'REVOKED',
        "revoked_at" = revoked_at,
        "revocation_reason" = p_reason_code,
        "updated_at" = revoked_at
     WHERE "id" = p_certificate_id;

    INSERT INTO "certificate_events" (
        "id", "certificate_id", "owner_user_id", "organization_id",
        "event_type", "event_source", "actor_user_id", "reason_code", "comment", "created_at"
    ) VALUES (
        gen_random_uuid(), certificate."id", certificate."owner_user_id",
        certificate."organization_id", 'REVOKED', p_event_source, actor,
        p_reason_code, NULLIF(left(p_comment, 2000), ''), revoked_at
    );

    PERFORM set_config('palcert.certificate_system_write', 'off', true);
    RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION app_certificate_claim(uuid, uuid, text, text) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_certificate_issue(
    uuid, integer, integer, text, text, text, text, text, text, text, text, text, text, timestamptz
) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_certificate_fail(uuid, text, text, boolean) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_certificate_revoke(uuid, text, text, text) TO "palcert_app";

-- =============================================================================
-- 6. Public verification (§56, §57, §58)
--
-- Anonymous verification needs to read one certificate. It must not be able to
-- read the table, so the certificate policies are left exactly as they are and
-- the disclosure goes through a function whose WHERE clause and fixed column
-- list *are* the authorization boundary — the same pattern Phase 14 uses to
-- tell a submitter whether an organization accepts submissions.
--
-- Three properties make it safe to expose to the internet:
--
--   * It is looked up by the *hash* of the canonical code, so the table never
--     holds a working verification capability in plaintext.
--   * It returns a fixed column list. There is no row type, no `SELECT *`, and
--     no way for a column added in a later phase to appear here by default.
--   * It answers only for certificates that were really issued. A PENDING or
--     failed one returns no rows, so a verifier cannot probe for the existence
--     of certificates that do not publicly exist.
--
-- Note what is absent from the return type: no owner, no submission or
-- revision id, no check or report id, no document title or filename, no
-- comment, no actor, no storage key or object version.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_public_certificate(p_verification_code_hash text)
RETURNS TABLE (
    "certificate_number" text,
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
    SELECT c."certificate_number",
           c."issuance_status",
           c."issued_at",
           c."valid_until",
           c."revoked_at",
           c."revocation_reason",
           -- The labels as the Phase 14 handoff captured them, never as the
           -- catalogue reads today: a university renaming itself must not
           -- change what an old certificate appears to say.
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

-- =============================================================================
-- 7. Catalogue and queue vocabulary
-- =============================================================================

-- Certificates are dual-party for the same reason submissions are, and the
-- coverage suite asserts the class as it does for Phase 14.
INSERT INTO "table_isolation_classification" ("table_name", "classification", "tenant_column", "notes")
VALUES
    ('compliance_certificates', 'DUAL_PARTY_SCOPED', 'owner_user_id',
     'Read by its subject and the approving organization; written only by PalCert''s issuance path.'),
    ('certificate_events', 'DUAL_PARTY_SCOPED', 'owner_user_id',
     'Append-only certificate history. Issuance is SYSTEM; revocation is a named authorized person.')
ON CONFLICT ("table_name") DO UPDATE
    SET "classification" = EXCLUDED."classification",
        "tenant_column" = EXCLUDED."tenant_column",
        "notes" = EXCLUDED."notes";

ALTER TABLE "processing_jobs" DROP CONSTRAINT "processing_jobs_resource_type_known";
ALTER TABLE "processing_jobs"
    ADD CONSTRAINT "processing_jobs_resource_type_known"
    CHECK ("resource_type" IN (
        'DOCUMENT_VERSION', 'DOCUMENT', 'DOCUMENT_ANALYSIS', 'DOCUMENT_CHECK', 'CHECK_RUN', 'AI_REVIEW',
        'STANDARD_SOURCE_ASSET', 'RULE_EXTRACTION_RUN',
        'PAYMENT_PROVIDER_EVENT', 'PAYMENT_RECONCILIATION',
        'SMARTFIX_REQUEST', 'SUBMISSION_REVISION', 'COMPLIANCE_CERTIFICATE'));

-- =============================================================================
-- 8. Permissions
-- =============================================================================
INSERT INTO "permissions" ("id", "code", "description") VALUES
    (gen_random_uuid(), 'certificate:read:self',
     'Read and download certificates issued for your own official submissions'),
    (gen_random_uuid(), 'certificate:record:read',
     'See the certificates issued for this organization''s approvals'),
    (gen_random_uuid(), 'certificate:revocation:write',
     'Withdraw a certificate this organization''s approval produced')
ON CONFLICT ("code") DO NOTHING;

-- Self-service, like every other "your own" permission.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT rp."role_id", p."id"
FROM "role_permissions" rp
JOIN "permissions" baseline ON baseline."id" = rp."permission_id" AND baseline."code" = 'profile:read:self'
CROSS JOIN "permissions" p
WHERE p."code" = 'certificate:read:self'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- Reading a certificate is part of reviewing submissions, so every role that
-- reviews gets it. Withdrawing one is a heavier authority and goes only to the
-- roles that administer the organization (§63).
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."code" IN ('ORGANIZATION_OWNER', 'ORGANIZATION_ADMIN', 'ORGANIZATION_REVIEWER')
  AND p."code" = 'certificate:record:read'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."code" IN ('ORGANIZATION_OWNER', 'ORGANIZATION_ADMIN')
  AND p."code" = 'certificate:revocation:write'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
