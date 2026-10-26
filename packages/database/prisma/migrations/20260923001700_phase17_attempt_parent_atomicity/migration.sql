-- Phase 17 — an attempt and what it decided are one write, not two.
--
-- Until now a real network attempt finished in two commits: close the attempt
-- row, then move the delivery. The gap between them is a crash window with a
-- nasty property — the receiver's answer is already durable and the parent does
-- not know it. A worker reclaiming that job saw a delivery stuck SENDING with no
-- open attempt, called it an interrupted send, and asked the receiver again.
-- PalCert had the answer on disk and threw it away.
--
-- The same split existed on the verification side, where it broke a rule the
-- phase had just adopted: an HTTP answer settles the administrator's intent. A
-- crash between closing the attempt and settling the operation left the intent
-- eligible for another automatic request.
--
-- Both are closed the same way: one doorway per case that does the whole thing
-- in one transaction, and the old doorways narrowed so they cannot be used to
-- record a receiver's answer at all. What is left is exactly the at-least-once
-- boundary anyone would want — if the transaction commits and the process then
-- dies, the reclaim reads a finished parent and sends nothing; if it never
-- commits, the attempt is still open and the ordinary ambiguous-send recovery
-- applies.

-- -----------------------------------------------------------------------------
-- 1. One open attempt per parent, as storage truth rather than convention.
-- -----------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS "webhook_delivery_attempts_one_open"
    ON "webhook_delivery_attempts" ("delivery_id") WHERE "outcome" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "webhook_verification_attempts_one_open"
    ON "webhook_verification_attempts" ("operation_id") WHERE "outcome" IS NULL;

-- -----------------------------------------------------------------------------
-- 2. Finishing a real delivery attempt.
--
-- The attempt id is the whole authority: the delivery is derived from it, never
-- passed in, so a caller cannot use this to move an unrelated delivery. The
-- application supplies the normalized outcome and the already-bounded next
-- attempt time — a receiver's Retry-After header is read, clamped and forgotten
-- in memory, and never reaches a stored column.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_webhook_delivery_attempt_finish(
    p_attempt_id uuid,
    p_outcome "WebhookAttemptOutcome",
    p_error_code text,
    p_http_status integer,
    p_duration_ms integer,
    p_delivery_status "WebhookDeliveryStatus",
    p_next_attempt_at timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_attempt "webhook_delivery_attempts"%ROWTYPE;
    v_status "WebhookDeliveryStatus";
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'finishing a webhook delivery attempt is system work';
    END IF;

    SELECT * INTO v_attempt FROM "webhook_delivery_attempts"
     WHERE "id" = p_attempt_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook delivery attempt % does not exist', p_attempt_id;
    END IF;
    IF v_attempt."outcome" IS NOT NULL THEN
        RAISE EXCEPTION 'webhook delivery attempt % is already %',
            p_attempt_id, v_attempt."outcome";
    END IF;

    SELECT "status" INTO v_status FROM "webhook_deliveries"
     WHERE "id" = v_attempt."delivery_id" FOR UPDATE;
    IF v_status <> 'SENDING' THEN
        RAISE EXCEPTION 'webhook delivery % is % and is not mid-attempt',
            v_attempt."delivery_id", v_status;
    END IF;

    -- The pairing is the point. An attempt that succeeded and a delivery that
    -- did not are two rows that disagree, and a delivery log that disagrees
    -- with itself is not evidence of anything.
    IF NOT (
        (p_outcome = 'SUCCEEDED' AND p_delivery_status = 'DELIVERED'
             AND p_error_code IS NULL AND p_next_attempt_at IS NULL)
     OR (p_outcome = 'FAILED_PERMANENT' AND p_delivery_status = 'FAILED_PERMANENT'
             AND p_error_code IS NOT NULL AND p_next_attempt_at IS NULL)
     OR (p_outcome = 'FAILED_RETRYABLE' AND p_delivery_status = 'FAILED_RETRYABLE'
             AND p_error_code IS NOT NULL AND p_next_attempt_at IS NOT NULL)
     -- The receiver may be worth asking again and the ladder may still be out
     -- of rungs. Those are two different facts, not a disagreement: the attempt
     -- records what the receiver said, the delivery records that PalCert is
     -- done asking.
     OR (p_outcome = 'FAILED_RETRYABLE' AND p_delivery_status = 'FAILED_PERMANENT'
             AND p_error_code IS NOT NULL AND p_next_attempt_at IS NULL)
    ) THEN
        RAISE EXCEPTION 'webhook delivery attempt % cannot finish as % against a % delivery',
            p_attempt_id, p_outcome, p_delivery_status;
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'system', true);

    UPDATE "webhook_delivery_attempts"
       SET "outcome" = p_outcome,
           "error_code" = p_error_code::"webhook_error_code",
           "http_status" = p_http_status,
           "duration_ms" = p_duration_ms,
           "finished_at" = now()
     WHERE "id" = p_attempt_id;

    UPDATE "webhook_deliveries"
       SET "status" = p_delivery_status,
           "last_error_code" = COALESCE(p_error_code::"webhook_error_code", "last_error_code"),
           "last_http_status" = COALESCE(p_http_status, "last_http_status"),
           "next_attempt_at" = p_next_attempt_at,
           "delivered_at" = CASE WHEN p_delivery_status = 'DELIVERED'
                                 THEN now() ELSE "delivered_at" END,
           "updated_at" = now()
     WHERE "id" = v_attempt."delivery_id";

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
END;
$$;

REVOKE ALL ON FUNCTION app_webhook_delivery_attempt_finish(
    uuid, "WebhookAttemptOutcome", text, integer, integer,
    "WebhookDeliveryStatus", timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_webhook_delivery_attempt_finish(
    uuid, "WebhookAttemptOutcome", text, integer, integer,
    "WebhookDeliveryStatus", timestamptz) TO "palcert_app";

-- -----------------------------------------------------------------------------
-- 3. The old delivery-attempt close is now only for an interrupted attempt.
--
-- This is what makes the atomicity structural instead of a convention the
-- application is trusted to follow: there is no longer any way to record a
-- receiver's answer on an attempt without moving its delivery in the same
-- transaction. What remains is the one honest use — a worker died and somebody
-- has to say so.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_webhook_attempt_close(
    p_attempt_id uuid,
    p_outcome "WebhookAttemptOutcome",
    p_error_code text,
    p_http_status integer,
    p_duration_ms integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'closing a webhook attempt is system work';
    END IF;

    IF p_outcome <> 'FAILED_RETRYABLE' OR p_error_code IS DISTINCT FROM 'WORKER_INTERRUPTED' THEN
        RAISE EXCEPTION
            'a webhook delivery attempt carrying a receiver answer must finish atomically '
            'with its delivery';
    END IF;
    IF p_http_status IS NOT NULL THEN
        RAISE EXCEPTION 'an interrupted webhook attempt has no receiver status';
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'system', true);

    UPDATE "webhook_delivery_attempts"
       SET "outcome" = p_outcome,
           "error_code" = p_error_code::"webhook_error_code",
           "duration_ms" = p_duration_ms,
           "finished_at" = now()
     WHERE "id" = p_attempt_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook delivery attempt % does not exist', p_attempt_id;
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Settling a verification from a receiver's answer.
--
-- Same shape, one row further out: the attempt, the configuration's history and
-- the administrator's intent all move together, so no receiver response can be
-- durably recorded while the same intent is still eligible for another
-- automatic request.
--
-- Success is deliberately not here. A SUCCEEDED attempt is recoverable on its
-- own — `succeeded_attempt_id` is exactly that proof — so a crash after it costs
-- two database writes on the next run and no network at all.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_webhook_verification_attempt_settle_response(
    p_attempt_id uuid,
    p_outcome "WebhookAttemptOutcome",
    p_error_code text,
    p_http_status integer,
    p_duration_ms integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_attempt "webhook_verification_attempts"%ROWTYPE;
    v_operation "webhook_management_operations"%ROWTYPE;
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'settling a webhook verification is system work';
    END IF;

    IF p_outcome NOT IN ('FAILED_RETRYABLE', 'FAILED_PERMANENT') OR p_error_code IS NULL THEN
        RAISE EXCEPTION 'a verification settled from a response must carry a failure code';
    END IF;

    SELECT * INTO v_attempt FROM "webhook_verification_attempts"
     WHERE "id" = p_attempt_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook verification attempt % does not exist', p_attempt_id;
    END IF;
    IF v_attempt."outcome" IS NOT NULL THEN
        RAISE EXCEPTION 'webhook verification attempt % is already %',
            p_attempt_id, v_attempt."outcome";
    END IF;

    SELECT * INTO v_operation FROM "webhook_management_operations"
     WHERE "id" = v_attempt."operation_id" FOR UPDATE;
    IF v_operation."operation" <> 'VERIFY_CONFIG'
       OR v_operation."config_version_id" IS DISTINCT FROM v_attempt."config_version_id"
       OR v_operation."endpoint_id" IS DISTINCT FROM v_attempt."endpoint_id"
    THEN
        RAISE EXCEPTION 'webhook verification attempt % does not match its operation', p_attempt_id;
    END IF;
    IF v_operation."settled_at" IS NOT NULL THEN
        RAISE EXCEPTION 'webhook operation % is already settled', v_operation."id";
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'system', true);

    UPDATE "webhook_verification_attempts"
       SET "outcome" = p_outcome,
           "error_code" = p_error_code::"webhook_error_code",
           "http_status" = p_http_status,
           "duration_ms" = p_duration_ms,
           "finished_at" = now()
     WHERE "id" = p_attempt_id;

    PERFORM set_config('palcert.webhook_write_mode', 'lifecycle', true);

    -- `status = 'PENDING'` again: a failure must not revive the lifecycle of a
    -- configuration that was superseded while the request was in flight.
    UPDATE "webhook_endpoint_config_versions"
       SET "last_verification_error" = p_error_code::"webhook_error_code",
           "last_verification_at" = now()
     WHERE "id" = v_attempt."config_version_id" AND "status" = 'PENDING';

    PERFORM set_config('palcert.webhook_write_mode', 'system', true);

    UPDATE "webhook_management_operations"
       SET "settled_at" = now(),
           "settled_error_code" = p_error_code::"webhook_error_code",
           "updated_at" = now()
     WHERE "id" = v_operation."id";

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
END;
$$;

REVOKE ALL ON FUNCTION app_webhook_verification_attempt_settle_response(
    uuid, "WebhookAttemptOutcome", text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_webhook_verification_attempt_settle_response(
    uuid, "WebhookAttemptOutcome", text, integer, integer) TO "palcert_app";

-- -----------------------------------------------------------------------------
-- 5. The verification close keeps only the two outcomes that are safe alone.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_webhook_verification_attempt_close(
    p_attempt_id uuid,
    p_outcome "WebhookAttemptOutcome",
    p_error_code text,
    p_http_status integer,
    p_duration_ms integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'closing a webhook verification attempt is system work';
    END IF;

    -- A success stands on its own: the operation resumes from it. An
    -- interruption, and a transport failure where nothing was heard at all, say
    -- nothing about the receiver and deliberately leave the intent unsettled so
    -- the same job may try again. Everything else is a receiver's answer and
    -- must settle the intent in the same transaction — which is why a status
    -- code is refused here: a verification that got a status got an answer.
    IF NOT (
        (p_outcome = 'SUCCEEDED' AND p_error_code IS NULL)
     OR (p_outcome = 'FAILED_RETRYABLE' AND p_http_status IS NULL
             AND p_error_code IN (
                 'WORKER_INTERRUPTED', 'DNS_TEMPORARY_FAILURE', 'CONNECT_TIMEOUT',
                 'CONNECTION_RESET', 'TLS_INTERRUPTED', 'REQUEST_TIMEOUT'))
    ) THEN
        RAISE EXCEPTION
            'a webhook verification attempt carrying a receiver answer must settle atomically '
            'with its operation';
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'system', true);

    UPDATE "webhook_verification_attempts"
       SET "outcome" = p_outcome,
           "error_code" = p_error_code::"webhook_error_code",
           "http_status" = p_http_status,
           "duration_ms" = p_duration_ms,
           "finished_at" = now()
     WHERE "id" = p_attempt_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook verification attempt % does not exist', p_attempt_id;
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. The attempt-bound failure recorder has no callers left.
--
-- Its two jobs both moved: a receiver's answer is recorded by the atomic settle
-- above, and a refusal that never reached the wire by the operation-bound
-- recorder added with the reveal-window work. Leaving an unused SECURITY
-- DEFINER write path in place is a way into the lifecycle that nothing uses and
-- nothing watches.
-- -----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS app_webhook_config_verification_failed(uuid);
