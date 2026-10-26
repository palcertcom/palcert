-- Phase 17 — three reliability invariants the workers turned out to need.
--
-- 1. A retryable delivery must carry the time it is waiting for.
--
--    The business ladder lives in `next_attempt_at`. A row that is
--    FAILED_RETRYABLE without one has nothing to wait for and nothing to
--    schedule from, so a worker reclaiming its job early cannot tell "owed an
--    attempt now" from "owed an attempt in twelve hours" — and would send. The
--    constraint makes that row impossible rather than making the worker guess.

ALTER TABLE "webhook_deliveries"
    ADD CONSTRAINT "webhook_deliveries_retryable_has_next_attempt"
    CHECK ("status" <> 'FAILED_RETRYABLE' OR "next_attempt_at" IS NOT NULL);

-- 2. What a dead verification job needs to clean up after itself.
--
--    Without a way to see its own attempts, the dead-job path cannot close the
--    one a killed worker left open, and the operation's history says PalCert
--    is still waiting for a receiver that nobody is talking to.

CREATE OR REPLACE FUNCTION app_webhook_verification_attempts_system_get(p_operation_id uuid)
RETURNS TABLE (
    id uuid, attempt_number integer, started_at timestamptz,
    finished_at timestamptz, outcome "WebhookAttemptOutcome",
    error_code text, http_status integer, duration_ms integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'webhook verification attempt rows are system data';
    END IF;
    RETURN QUERY
    SELECT a."id", a."attempt_number", a."started_at", a."finished_at",
           a."outcome", a."error_code"::text, a."http_status", a."duration_ms"
      FROM "webhook_verification_attempts" a
     WHERE a."operation_id" = p_operation_id
     ORDER BY a."attempt_number";
END;
$$;

REVOKE ALL ON FUNCTION app_webhook_verification_attempts_system_get(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_webhook_verification_attempts_system_get(uuid) TO "palcert_app";

-- 3. Recording a verification failure that never reached the wire.
--
--    `app_webhook_config_verification_failed` is bound to an attempt, and an
--    attempt is the record of a real network request. A configuration refused
--    before anything was sent — a URL whose policy no longer holds, stored
--    metadata that stopped describing its own ciphertext — still belongs in
--    the configuration's history, but inventing a wire attempt to carry it
--    would put a request in the log that never happened.
--
--    So this takes the operation instead. It writes the same two columns, and
--    only for the configuration that operation is actually about.

CREATE OR REPLACE FUNCTION app_webhook_config_verification_refused(
    p_operation_id uuid,
    p_error_code text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_operation "webhook_management_operations"%ROWTYPE;
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'recording a webhook verification refusal is system work';
    END IF;

    SELECT * INTO v_operation FROM "webhook_management_operations"
     WHERE "id" = p_operation_id;
    IF NOT FOUND OR v_operation."operation" <> 'VERIFY_CONFIG' THEN
        RAISE EXCEPTION 'webhook operation % is not a configuration verification',
            p_operation_id;
    END IF;
    IF v_operation."config_version_id" IS NULL THEN
        RAISE EXCEPTION 'webhook operation % names no configuration', p_operation_id;
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'lifecycle', true);

    -- `status = 'PENDING'` again: a refusal must not revive the lifecycle of a
    -- configuration that was superseded while the job waited.
    UPDATE "webhook_endpoint_config_versions"
       SET "last_verification_error" = p_error_code::"webhook_error_code",
           "last_verification_at" = now()
     WHERE "id" = v_operation."config_version_id" AND "status" = 'PENDING';

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
END;
$$;

REVOKE ALL ON FUNCTION app_webhook_config_verification_refused(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_webhook_config_verification_refused(uuid, text) TO "palcert_app";
