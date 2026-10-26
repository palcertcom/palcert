-- Phase 17 — the last two places where the database took the application's word.
--
-- The retry architecture is right; these are the two spots where it was held up
-- by the service behaving rather than by the schema refusing.
--
-- First, the begin doorway let a FAILED_RETRYABLE delivery start an attempt at
-- any moment. The service checks the business time before calling it, but a
-- doorway that trusts its caller is a doorway that a future bug walks through:
-- one wrong branch and a receiver that asked for twelve hours gets asked again
-- immediately. The delivery's own schedule is now a precondition of starting.
--
-- Second, the parent-only transition — which exists precisely for the facts
-- PalCert knows *without* a receiver — could still write an HTTP status, and
-- could still carry a receiver's error code. That is a second way to record an
-- answer with no attempt behind it, which is the thing the atomic finish was
-- built to make impossible. It now accepts a closed set of shapes, and every
-- one of them is something knowable before a socket is opened.

-- -----------------------------------------------------------------------------
-- 1. No attempt may begin before the delivery's business schedule.
--
-- The comparison uses the caller's `p_started_at` rather than the database's
-- clock, deliberately: the worker's clock is the one the ladder was written
-- with, and a test clock has to be able to move both together.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_webhook_delivery_attempt_begin(
    p_delivery_id uuid,
    p_started_at timestamptz
) RETURNS TABLE (attempt_id uuid, attempt_number integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_delivery "webhook_deliveries"%ROWTYPE;
    v_number integer;
    v_id uuid;
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'beginning a webhook attempt is system work';
    END IF;

    SELECT * INTO v_delivery FROM "webhook_deliveries"
     WHERE "id" = p_delivery_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook delivery % does not exist', p_delivery_id;
    END IF;

    -- SENDING is deliberately not a start state. A delivery that is already
    -- mid-attempt has an open attempt row, and the one-open-attempt index would
    -- refuse the insert anyway — this says so with a sentence instead of a
    -- constraint name.
    IF v_delivery."status" NOT IN ('PENDING', 'FAILED_RETRYABLE') THEN
        RAISE EXCEPTION 'webhook delivery % is % and cannot begin an attempt',
            p_delivery_id, v_delivery."status";
    END IF;

    IF v_delivery."status" = 'FAILED_RETRYABLE' THEN
        IF v_delivery."next_attempt_at" IS NULL THEN
            RAISE EXCEPTION 'webhook delivery % is retryable with no next attempt time',
                p_delivery_id;
        END IF;
        IF p_started_at < v_delivery."next_attempt_at" THEN
            RAISE EXCEPTION
                'webhook delivery % is not due until % and cannot be attempted at %',
                p_delivery_id, v_delivery."next_attempt_at", p_started_at;
        END IF;
    END IF;

    SELECT COALESCE(MAX(a."attempt_number"), 0) + 1 INTO v_number
      FROM "webhook_delivery_attempts" a WHERE a."delivery_id" = p_delivery_id;

    PERFORM set_config('palcert.webhook_write_mode', 'system', true);

    INSERT INTO "webhook_delivery_attempts"
        ("id", "delivery_id", "attempt_number", "started_at")
    VALUES (gen_random_uuid(), p_delivery_id, v_number, p_started_at)
    RETURNING "id" INTO v_id;

    -- The counter and the row it counts, in one statement pair that nothing can
    -- interrupt. This is what makes `attempt_count = count(attempts)` true by
    -- construction rather than by convention.
    UPDATE "webhook_deliveries"
       SET "status" = 'SENDING',
           "attempt_count" = "attempt_count" + 1,
           "next_attempt_at" = NULL,
           "updated_at" = now()
     WHERE "id" = p_delivery_id;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);

    attempt_id := v_id;
    attempt_number := v_number;
    RETURN NEXT;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. The parent-only doorway carries only what is knowable without a receiver.
--
-- A closed set of shapes rather than a graph plus loose columns. Each row of
-- the CASE below is a thing PalCert can know with no socket open: an endpoint
-- that is paused, a subscription that is gone, a stored configuration that
-- stopped describing itself, a URL the policy no longer allows, and a worker
-- that died. Anything with an HTTP status or a receiver-derived code belongs to
-- `app_webhook_delivery_attempt_finish`, which writes it together with the
-- attempt that earned it.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_webhook_delivery_transition(
    p_delivery_id uuid,
    p_status "WebhookDeliveryStatus",
    p_skip_reason "WebhookSkipReason",
    p_error_code text,
    p_http_status integer,
    p_next_attempt_at timestamptz,
    p_increment_attempt boolean
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_from "WebhookDeliveryStatus";
    v_allowed boolean;
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'moving a webhook delivery is system work';
    END IF;

    IF p_increment_attempt THEN
        RAISE EXCEPTION 'a webhook attempt is counted by the doorway that opens it';
    END IF;

    IF p_http_status IS NOT NULL THEN
        RAISE EXCEPTION
            'a receiver status belongs to the attempt that received it';
    END IF;

    SELECT "status" INTO v_from FROM "webhook_deliveries"
     WHERE "id" = p_delivery_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook delivery % does not exist', p_delivery_id;
    END IF;

    v_allowed := CASE
        -- Deliberately not sent: the endpoint is inactive, or the organization
        -- unsubscribed between one attempt and the next.
        WHEN v_from IN ('PENDING', 'FAILED_RETRYABLE') AND p_status = 'SKIPPED' THEN
            p_skip_reason IS NOT NULL AND p_error_code IS NULL AND p_next_attempt_at IS NULL
        -- Refused before any socket: the stored configuration no longer
        -- describes itself, or its URL is no longer one PalCert will call.
        WHEN v_from IN ('PENDING', 'FAILED_RETRYABLE') AND p_status = 'FAILED_PERMANENT' THEN
            p_skip_reason IS NULL AND p_next_attempt_at IS NULL
                AND p_error_code IN ('WEBHOOK_CONFIG_INTEGRITY_MISMATCH', 'URL_POLICY_VIOLATION')
        -- PalCert stopped. Says nothing about the receiver, costs no rung when
        -- it comes from PENDING, and always carries a time so the sweeper
        -- brings the delivery back.
        WHEN v_from IN ('PENDING', 'SENDING') AND p_status = 'FAILED_RETRYABLE' THEN
            p_skip_reason IS NULL AND p_next_attempt_at IS NOT NULL
                AND p_error_code = 'WORKER_INTERRUPTED'
        ELSE false
    END;

    IF NOT v_allowed THEN
        RAISE EXCEPTION 'webhook delivery % cannot move from % to % this way',
            p_delivery_id, v_from, p_status;
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'system', true);

    UPDATE "webhook_deliveries"
       SET "status" = p_status,
           "skip_reason" = p_skip_reason,
           "last_error_code" = COALESCE(p_error_code::"webhook_error_code", "last_error_code"),
           "next_attempt_at" = p_next_attempt_at,
           "updated_at" = now()
     WHERE "id" = p_delivery_id;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
END;
$$;
