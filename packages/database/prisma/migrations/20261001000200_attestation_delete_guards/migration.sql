-- Certificate attestation: rows are never deleted.
--
-- The application role already has no DELETE privilege on these tables and
-- no DELETE policy, so this is defence in depth against a privileged
-- connection: an attestation, the request it answers and the artifact it
-- describes are the evidence behind a public verification page, and the
-- only way to withdraw one is revocation. Retention of unattested files
-- deletes the stored object and marks the row purged; it never removes the
-- row. TRUNCATE (test harness resets only) does not fire row triggers.

CREATE OR REPLACE FUNCTION app_attestation_refuse_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS "attestations_refuse_delete" ON "attestations";
CREATE TRIGGER "attestations_refuse_delete"
    BEFORE DELETE ON "attestations"
    FOR EACH ROW EXECUTE FUNCTION app_attestation_refuse_delete();

DROP TRIGGER IF EXISTS "attestation_requests_refuse_delete" ON "attestation_requests";
CREATE TRIGGER "attestation_requests_refuse_delete"
    BEFORE DELETE ON "attestation_requests"
    FOR EACH ROW EXECUTE FUNCTION app_attestation_refuse_delete();

DROP TRIGGER IF EXISTS "attestation_artifacts_refuse_delete" ON "attestation_artifacts";
CREATE TRIGGER "attestation_artifacts_refuse_delete"
    BEFORE DELETE ON "attestation_artifacts"
    FOR EACH ROW EXECUTE FUNCTION app_attestation_refuse_delete();
