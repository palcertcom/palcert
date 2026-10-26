-- Phase 17 — the business-retry edge on the processing job lifecycle.
--
-- Every phase up to this one had a single retry ladder: the queue's. A job that
-- ended SUCCEEDED had done its work exactly once and was finished forever, so
-- the Phase 5 guard treats SUCCEEDED as terminal and refuses to move out of it.
--
-- Phase 17 introduces a second ladder that is deliberately *not* the queue's.
-- When a webhook receiver answers 503, the job did its whole job: it made one
-- real outbound attempt, recorded a durable WebhookDeliveryAttempt, classified
-- the answer, and wrote the delivery's next business attempt time. Succeeding
-- is the honest end of that unit of work. Failing it instead — the shape Phase
-- 16 uses for email — would hand the receiver's answer to the queue's short
-- ladder and turn one 503 into a burst of immediate outbound HTTP calls, which
-- is the single thing this phase's retry design exists to prevent.
--
-- So the delivery's own `next_attempt_at` decides, hours later, and the sweeper
-- re-arms that same job. That needs one new edge, SUCCEEDED -> PENDING, and it
-- is granted only to the job types that actually carry a business ladder. For
-- every other job type SUCCEEDED stays terminal, because for every other job
-- type a second run would be a duplicate.
--
-- The edge is narrow in a second way: PENDING is the only destination. A
-- succeeded job cannot be walked back into RUNNING or DISPATCHED, so a re-arm
-- always goes through the ordinary claim path and gets an ordinary lease.

CREATE OR REPLACE FUNCTION processing_jobs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    allowed boolean;
BEGIN
    IF NEW."job_type" <> OLD."job_type"
       OR NEW."resource_type" <> OLD."resource_type"
       OR NEW."resource_id" <> OLD."resource_id"
       OR NEW."owner_user_id" <> OLD."owner_user_id"
       OR NEW."idempotency_key" <> OLD."idempotency_key" THEN
        RAISE EXCEPTION 'processing_job % identity is immutable', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."status" <> OLD."status" THEN
        allowed := CASE OLD."status"
            WHEN 'PENDING'       THEN NEW."status" IN ('DISPATCHED', 'RUNNING', 'DEAD')
            WHEN 'DISPATCHED'    THEN NEW."status" IN ('RUNNING', 'PENDING', 'DEAD')
            WHEN 'RUNNING'       THEN NEW."status" IN ('SUCCEEDED', 'RETRY_PENDING', 'DEAD', 'PENDING')
            WHEN 'RETRY_PENDING' THEN NEW."status" IN ('DISPATCHED', 'RUNNING', 'DEAD', 'PENDING')
            WHEN 'DEAD'          THEN NEW."status" IN ('PENDING')
            -- The business-retry edge. Only for a job type whose resource owns
            -- its own schedule, and only back to PENDING.
            WHEN 'SUCCEEDED'     THEN NEW."status" = 'PENDING'
                                      AND OLD."job_type" IN ('WEBHOOK_DELIVER')
            ELSE false
        END;
        IF NOT allowed THEN
            RAISE EXCEPTION 'processing_job % cannot move from % to %', OLD."id", OLD."status", NEW."status"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
