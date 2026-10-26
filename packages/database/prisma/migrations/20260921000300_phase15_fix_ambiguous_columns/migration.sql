-- =============================================================================
-- Phase 15 — stop PL/pgSQL variables shadowing the columns they write
--
-- `app_certificate_issue` declared a variable called `issued_at` and then
-- assigned to the column `issued_at`; PostgreSQL cannot tell which one the
-- reference means and refuses the whole statement (42702). The effect was that
-- every issuance failed at the last step, after the evidence had been
-- re-verified and both artifacts stored — the certificate sat PENDING and the
-- job retried for ever.
--
-- `app_certificate_revoke` had the same shape with `revoked_at`. Both variables
-- are renamed rather than qualified, because a variable that merely *looks*
-- like a column is a trap for the next person to edit the function.
-- =============================================================================

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

CREATE OR REPLACE FUNCTION app_certificate_revoke(
    p_certificate_id uuid,
    p_reason_code text,
    p_comment text,
    p_event_source text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    certificate "compliance_certificates"%ROWTYPE;
    v_actor uuid := app_current_user_id();
    v_now timestamptz := now();
BEGIN
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'certificate revocation requires an authenticated actor';
    END IF;
    IF p_event_source NOT IN ('ORGANIZATION', 'PALCERT_ADMIN') THEN
        RAISE EXCEPTION 'certificate revocation source % is not a person', p_event_source;
    END IF;

    SELECT * INTO certificate FROM "compliance_certificates"
     WHERE "id" = p_certificate_id FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;

    IF p_event_source = 'ORGANIZATION' THEN
        IF app_current_organization() IS DISTINCT FROM certificate."organization_id" THEN
            RAISE EXCEPTION 'compliance_certificate % belongs to another organization', p_certificate_id;
        END IF;
    ELSIF NOT app_is_platform_admin() THEN
        RAISE EXCEPTION 'platform revocation requires elevation';
    END IF;

    IF certificate."issuance_status" = 'REVOKED' THEN RETURN false; END IF;
    IF certificate."issuance_status" <> 'ISSUED' THEN
        RAISE EXCEPTION 'compliance_certificate % is %, not ISSUED',
            p_certificate_id, certificate."issuance_status";
    END IF;

    PERFORM set_config('palcert.certificate_system_write', 'on', true);

    UPDATE "compliance_certificates" SET
        "issuance_status" = 'REVOKED',
        "revoked_at" = v_now,
        "revocation_reason" = p_reason_code,
        "updated_at" = v_now
     WHERE "id" = p_certificate_id;

    INSERT INTO "certificate_events" (
        "id", "certificate_id", "owner_user_id", "organization_id",
        "event_type", "event_source", "actor_user_id", "reason_code", "comment", "created_at"
    ) VALUES (
        gen_random_uuid(), certificate."id", certificate."owner_user_id",
        certificate."organization_id", 'REVOKED', p_event_source, v_actor,
        p_reason_code, NULLIF(left(p_comment, 2000), ''), v_now
    );

    PERFORM set_config('palcert.certificate_system_write', 'off', true);
    RETURN true;
END;
$$;
