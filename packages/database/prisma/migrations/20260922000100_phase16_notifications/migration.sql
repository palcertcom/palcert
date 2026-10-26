-- =============================================================================
-- Phase 16 — notifications and reliable event delivery
--
--     A notification reports an authoritative event.
--     It never becomes the authoritative record itself.
--
-- Nothing created here may be consulted to decide whether a submission was
-- approved or whether a certificate is valid. Phase 14's decision events and
-- Phase 15's certificate rows keep that authority, and the emitters below can
-- only read them — every one takes a single authoritative row id and derives
-- everything it writes from that row.
--
-- `domain_events` is not a second outbox. `ProcessingJob` remains the one
-- dispatch and retry mechanism in PalCert; these rows are the source identity
-- the jobs refer to, and the reason a retried job cannot notify twice.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Vocabularies
--
-- Native enums rather than TEXT + CHECK, because the closedness is the point:
-- an unknown notification type must be refused even where application
-- validation was bypassed (hardening §1).
-- -----------------------------------------------------------------------------
CREATE TYPE "NotificationType" AS ENUM (
    'SUBMISSION_READY',
    'SUBMISSION_REVISION_READY',
    'SUBMISSION_UNDER_REVIEW',
    'SUBMISSION_APPROVED',
    'SUBMISSION_REJECTED',
    'SUBMISSION_REVISION_REQUESTED',
    'SUBMISSION_COMMENT_ADDED',
    'CERTIFICATE_ISSUED',
    'CERTIFICATE_REVOKED'
);

CREATE TYPE "DomainEventSourceType" AS ENUM (
    'SUBMISSION_REVISION',
    'SUBMISSION_DECISION_EVENT',
    'SUBMISSION_COMMENT',
    'CERTIFICATE_EVENT'
);

CREATE TYPE "DomainAggregateType" AS ENUM (
    'OFFICIAL_SUBMISSION',
    'COMPLIANCE_CERTIFICATE'
);

CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL');

CREATE TYPE "NotificationDeliveryStatus" AS ENUM (
    'PENDING', 'SENDING', 'DELIVERED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT', 'SKIPPED'
);

CREATE TYPE "NotificationSkipReason" AS ENUM (
    'PREFERENCE_DISABLED',
    'NO_VERIFIED_EMAIL',
    'AUTHORIZATION_REVOKED',
    'CHANNEL_DISABLED',
    'ACCOUNT_INELIGIBLE'
);

CREATE TYPE "NotificationAttemptOutcome" AS ENUM (
    'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT'
);

-- -----------------------------------------------------------------------------
-- 2. The event log
--
-- One committed authoritative row produces at most one event of a given type,
-- for ever, enforced by a UNIQUE index rather than by a service remembering to
-- check. That is what makes "notify exactly once" a property of the schema and
-- not of a worker's control flow.
-- -----------------------------------------------------------------------------
CREATE TABLE "domain_events" (
    "id" UUID NOT NULL,
    "event_type" "NotificationType" NOT NULL,
    "event_schema_version" INTEGER NOT NULL,

    "source_type" "DomainEventSourceType" NOT NULL,
    "source_id" UUID NOT NULL,

    "aggregate_type" "DomainAggregateType" NOT NULL,
    "aggregate_id" UUID NOT NULL,

    "owner_user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,

    -- When the business event happened, copied from the authoritative row —
    -- never now(). A retried emission reproduces the same value, which is what
    -- makes rendered output deterministic (hardening §3).
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    -- Identifiers and decision status only. Never document text, filenames,
    -- findings, comment bodies, addresses, verification codes or money.
    "payload" JSONB NOT NULL,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id"),

    -- Each source type may only carry the event types it can actually produce.
    -- Without this, a future emitter could file a certificate event under a
    -- submission revision and the idempotency key would stop meaning anything.
    CONSTRAINT "domain_events_source_matches_type" CHECK (
        ("source_type" = 'SUBMISSION_REVISION' AND "event_type" IN
            ('SUBMISSION_READY', 'SUBMISSION_REVISION_READY'))
        OR ("source_type" = 'SUBMISSION_DECISION_EVENT' AND "event_type" IN
            ('SUBMISSION_UNDER_REVIEW', 'SUBMISSION_APPROVED',
             'SUBMISSION_REJECTED', 'SUBMISSION_REVISION_REQUESTED'))
        OR ("source_type" = 'SUBMISSION_COMMENT' AND "event_type" = 'SUBMISSION_COMMENT_ADDED')
        OR ("source_type" = 'CERTIFICATE_EVENT' AND "event_type" IN
            ('CERTIFICATE_ISSUED', 'CERTIFICATE_REVOKED'))
    ),

    -- Hardening §2: the aggregate is exact or it is not recorded at all.
    CONSTRAINT "domain_events_aggregate_matches_type" CHECK (
        ("event_type" IN ('CERTIFICATE_ISSUED', 'CERTIFICATE_REVOKED')
            AND "aggregate_type" = 'COMPLIANCE_CERTIFICATE')
        OR ("event_type" NOT IN ('CERTIFICATE_ISSUED', 'CERTIFICATE_REVOKED')
            AND "aggregate_type" = 'OFFICIAL_SUBMISSION')
    ),

    CONSTRAINT "domain_events_payload_is_object" CHECK (jsonb_typeof("payload") = 'object'),
    CONSTRAINT "domain_events_schema_version_positive" CHECK ("event_schema_version" >= 1)
);

-- The producer-level idempotency root (§13). Ten deliveries of one job, or one
-- transaction retried ten times, still produce one event.
CREATE UNIQUE INDEX "domain_events_source_identity"
    ON "domain_events"("source_type", "source_id", "event_type");

CREATE INDEX "domain_events_type_created_idx"
    ON "domain_events"("event_type", "created_at", "id");
CREATE INDEX "domain_events_aggregate_idx"
    ON "domain_events"("aggregate_type", "aggregate_id", "occurred_at");

-- RESTRICT, not CASCADE: the log is append-only, so nothing deletes a row out
-- of it — not even a cascade from the actor it belongs to.
ALTER TABLE "domain_events"
    ADD CONSTRAINT "domain_events_owner_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "domain_events"
    ADD CONSTRAINT "domain_events_organization_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;

-- -----------------------------------------------------------------------------
-- 3. One recipient's copy
-- -----------------------------------------------------------------------------
CREATE TABLE "user_notifications" (
    "id" UUID NOT NULL,
    "source_event_id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    -- Context, not a grant. It records which tenant the event happened in so
    -- the inbox can label it; it never widens who may read the row.
    "organization_id" UUID NOT NULL,

    "notification_type" "NotificationType" NOT NULL,

    -- The copy as it was rendered, with the template version that produced it,
    -- so later wording changes never rewrite what somebody was actually told.
    "template_version" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    -- An application route. Never a bearer link, never a storage URL.
    "deep_link" TEXT NOT NULL,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ(6),

    CONSTRAINT "user_notifications_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "user_notifications_locale_known"
        CHECK ("locale" IN ('en', 'ar')),
    CONSTRAINT "user_notifications_deep_link_is_relative"
        CHECK ("deep_link" ~ '^/[A-Za-z0-9/_-]*$'),
    CONSTRAINT "user_notifications_text_bounded"
        CHECK (length("title") BETWEEN 1 AND 200 AND length("body") BETWEEN 1 AND 2000)
);

-- One event notifies one person once, whatever the queue delivers (§14).
CREATE UNIQUE INDEX "user_notifications_logical_identity"
    ON "user_notifications"("source_event_id", "recipient_user_id", "notification_type");

CREATE INDEX "user_notifications_inbox_idx"
    ON "user_notifications"("recipient_user_id", "created_at", "id");
-- The unread badge reads this one.
CREATE INDEX "user_notifications_unread_idx"
    ON "user_notifications"("recipient_user_id") WHERE "read_at" IS NULL;

ALTER TABLE "user_notifications"
    ADD CONSTRAINT "user_notifications_event_fkey"
    FOREIGN KEY ("source_event_id") REFERENCES "domain_events"("id") ON DELETE RESTRICT;
ALTER TABLE "user_notifications"
    ADD CONSTRAINT "user_notifications_recipient_fkey"
    FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "user_notifications"
    ADD CONSTRAINT "user_notifications_organization_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;

-- -----------------------------------------------------------------------------
-- 4. Delivery, and the history of what was attempted
-- -----------------------------------------------------------------------------
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "skip_reason" "NotificationSkipReason",

    "provider" TEXT NOT NULL,
    "provider_message_id" TEXT,

    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    -- A normalized code. Never a provider banner, an address or a message body.
    "last_error_code" TEXT,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "delivered_at" TIMESTAMPTZ(6),

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id"),

    -- A skip is not a failure: it names its reason, and nothing else may.
    CONSTRAINT "notification_deliveries_skip_shape" CHECK (
        ("status" = 'SKIPPED' AND "skip_reason" IS NOT NULL)
        OR ("status" <> 'SKIPPED' AND "skip_reason" IS NULL)
    ),
    CONSTRAINT "notification_deliveries_delivered_shape"
        CHECK ("status" <> 'DELIVERED' OR "delivered_at" IS NOT NULL),
    CONSTRAINT "notification_deliveries_failure_shape" CHECK (
        "status" NOT IN ('FAILED_RETRYABLE', 'FAILED_PERMANENT') OR "last_error_code" IS NOT NULL
    ),
    -- Only a retryable failure is waiting for another go.
    CONSTRAINT "notification_deliveries_retry_shape"
        CHECK ("next_attempt_at" IS NULL OR "status" IN ('PENDING', 'FAILED_RETRYABLE')),
    CONSTRAINT "notification_deliveries_error_code_known" CHECK (
        "last_error_code" IS NULL OR "last_error_code" IN
            ('PROVIDER_UNAVAILABLE', 'PROVIDER_REJECTED',
             'RECIPIENT_REJECTED', 'CONFIGURATION_REJECTED')
    ),
    CONSTRAINT "notification_deliveries_attempts_sane" CHECK ("attempt_count" >= 0),
    -- In-app delivery is the notification row existing. It has no provider to
    -- fail, so it may not pretend to be pending, sending or failed.
    CONSTRAINT "notification_deliveries_in_app_shape" CHECK (
        "channel" <> 'IN_APP' OR ("status" = 'DELIVERED' AND "attempt_count" <= 1)
    )
);

-- Duplicate events or duplicate jobs cannot schedule two logical emails (§41).
-- What is *not* claimed is external exactly-once — see the attempt table.
CREATE UNIQUE INDEX "notification_deliveries_logical_identity"
    ON "notification_deliveries"("notification_id", "channel");

CREATE INDEX "notification_deliveries_due_idx"
    ON "notification_deliveries"("status", "next_attempt_at");

ALTER TABLE "notification_deliveries"
    ADD CONSTRAINT "notification_deliveries_notification_fkey"
    FOREIGN KEY ("notification_id") REFERENCES "user_notifications"("id") ON DELETE RESTRICT;

CREATE TABLE "notification_delivery_attempts" (
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,

    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "outcome" "NotificationAttemptOutcome",

    "provider_message_id" TEXT,
    "error_code" TEXT,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_delivery_attempts_pkey" PRIMARY KEY ("id"),

    -- An attempt is either still running or finished and explained.
    CONSTRAINT "notification_delivery_attempts_finished_shape" CHECK (
        ("outcome" IS NULL AND "finished_at" IS NULL)
        OR ("outcome" IS NOT NULL AND "finished_at" IS NOT NULL)
    ),
    CONSTRAINT "notification_delivery_attempts_failure_shape" CHECK (
        "outcome" IS NULL OR "outcome" = 'SUCCEEDED' OR "error_code" IS NOT NULL
    ),
    CONSTRAINT "notification_delivery_attempts_error_code_known" CHECK (
        "error_code" IS NULL OR "error_code" IN
            ('PROVIDER_UNAVAILABLE', 'PROVIDER_REJECTED',
             'RECIPIENT_REJECTED', 'CONFIGURATION_REJECTED')
    ),
    CONSTRAINT "notification_delivery_attempts_number_positive"
        CHECK ("attempt_number" >= 1)
);

CREATE UNIQUE INDEX "notification_delivery_attempts_identity"
    ON "notification_delivery_attempts"("delivery_id", "attempt_number");

ALTER TABLE "notification_delivery_attempts"
    ADD CONSTRAINT "notification_delivery_attempts_delivery_fkey"
    FOREIGN KEY ("delivery_id") REFERENCES "notification_deliveries"("id") ON DELETE RESTRICT;

-- -----------------------------------------------------------------------------
-- 5. Preferences
--
-- Normalized rather than a JSON blob, so the database can hold the one rule
-- that matters (hardening §6): a revocation email cannot be switched off. A
-- missing row means the product default, so a new account needs no rows.
-- -----------------------------------------------------------------------------
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "notification_type" "NotificationType" NOT NULL,
    "email_enabled" BOOLEAN NOT NULL DEFAULT true,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id"),

    -- A certificate revocation is a material change to the validity of
    -- something the holder may already have shown an employer. A stored
    -- preference row claiming otherwise is refused outright, whatever route
    -- or script wrote it.
    CONSTRAINT "notification_preferences_mandatory_email_stays_on"
        CHECK ("email_enabled" OR "notification_type" <> 'CERTIFICATE_REVOKED')
);

CREATE UNIQUE INDEX "notification_preferences_identity"
    ON "notification_preferences"("user_id", "notification_type");

ALTER TABLE "notification_preferences"
    ADD CONSTRAINT "notification_preferences_user_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

-- =============================================================================
-- 6. Isolation
--
-- Two of these five tables are one person's, and two are machinery. The event
-- log is neither: it belongs to PalCert.
--
--   domain_events                  SYSTEM   — no tenant reads it at all
--   user_notifications             USER     — the recipient, and nobody else
--   notification_deliveries        SYSTEM   — delivery machinery
--   notification_delivery_attempts SYSTEM   — delivery machinery
--   notification_preferences       USER     — the person whose mail it is
--
-- The two USER_SCOPED tables get row-level security on their own isolation
-- column. An organization owner does not read a member's inbox; a reviewer
-- does not read a submitter's. There is no dual party here — a notification is
-- a private copy, and "the organization the event happened in" is a label on
-- it, not a second reader.
-- =============================================================================

ALTER TABLE "user_notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_notifications" FORCE ROW LEVEL SECURITY;
ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_preferences" FORCE ROW LEVEL SECURITY;

-- Recognised exactly as Phase 14 and Phase 15 recognise theirs: a role switch
-- only a SECURITY DEFINER function owned by a privileged role can reach, *and*
-- a transaction-local flag. The flag alone is forgeable by `palcert_app` and
-- buys nothing; the role switch is the real boundary.
CREATE OR REPLACE FUNCTION app_is_notification_system_writer() RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT current_user IS DISTINCT FROM session_user
       AND COALESCE(current_setting('palcert.notification_system_write', true), 'off') = 'on';
$$;

-- --- user_notifications --------------------------------------------------
--   SELECT  the recipient only — not the organization, not a reviewer
--   INSERT  the fan-out path only, which writes for people who are not the
--           caller and so can never be a self-insert policy
--   UPDATE  the recipient, and (by the guard below) only `read_at`
--   DELETE  nobody
CREATE POLICY "user_notifications_read" ON "user_notifications" FOR SELECT
    USING ("recipient_user_id" = app_current_user_id());

CREATE POLICY "user_notifications_insert" ON "user_notifications" FOR INSERT
    WITH CHECK (app_is_notification_system_writer());

CREATE POLICY "user_notifications_update" ON "user_notifications" FOR UPDATE
    USING ("recipient_user_id" = app_current_user_id())
    WITH CHECK ("recipient_user_id" = app_current_user_id());

-- Stated rather than omitted, so the catalogue shows a decision and not a gap.
CREATE POLICY "user_notifications_delete" ON "user_notifications" FOR DELETE
    USING (false);

-- --- notification_preferences ---------------------------------------------
-- Entirely the person's own, in all four commands. Deleting a row is how a
-- preference returns to the product default.
CREATE POLICY "notification_preferences_read" ON "notification_preferences" FOR SELECT
    USING ("user_id" = app_current_user_id());

CREATE POLICY "notification_preferences_insert" ON "notification_preferences" FOR INSERT
    WITH CHECK ("user_id" = app_current_user_id());

CREATE POLICY "notification_preferences_update" ON "notification_preferences" FOR UPDATE
    USING ("user_id" = app_current_user_id())
    WITH CHECK ("user_id" = app_current_user_id());

CREATE POLICY "notification_preferences_delete" ON "notification_preferences" FOR DELETE
    USING ("user_id" = app_current_user_id());

-- =============================================================================
-- 7. Immutability
--
-- An event is what happened. A notification is what somebody was told. Neither
-- is editable; the only mutable fact in the whole phase is whether the
-- recipient has read theirs.
-- =============================================================================

CREATE OR REPLACE FUNCTION notification_history_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% rows are immutable once written', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "domain_events_append_only"
    BEFORE UPDATE OR DELETE ON "domain_events"
    FOR EACH ROW EXECUTE FUNCTION notification_history_is_append_only();

CREATE TRIGGER "notification_delivery_attempts_no_delete"
    BEFORE DELETE ON "notification_delivery_attempts"
    FOR EACH ROW EXECUTE FUNCTION notification_history_is_append_only();

-- An attempt is written when it starts and closed once when it ends. Nothing
-- may reopen it or rewrite how it went.
CREATE OR REPLACE FUNCTION notification_delivery_attempts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."delivery_id" IS DISTINCT FROM OLD."delivery_id"
       OR NEW."attempt_number" IS DISTINCT FROM OLD."attempt_number"
       OR NEW."started_at" IS DISTINCT FROM OLD."started_at"
    THEN
        RAISE EXCEPTION 'notification_delivery_attempt % identity is immutable', OLD."id";
    END IF;

    IF OLD."outcome" IS NOT NULL THEN
        RAISE EXCEPTION 'notification_delivery_attempt % is already %', OLD."id", OLD."outcome";
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "notification_delivery_attempts_guard_trigger"
    BEFORE UPDATE ON "notification_delivery_attempts"
    FOR EACH ROW EXECUTE FUNCTION notification_delivery_attempts_guard();

-- The rendered copy is write-once. A later template, a renamed organization or
-- an edited standard must never change what an old notification says — and a
-- recipient marking one read must not be a way to rewrite its text.
CREATE OR REPLACE FUNCTION user_notifications_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."source_event_id" IS DISTINCT FROM OLD."source_event_id"
       OR NEW."recipient_user_id" IS DISTINCT FROM OLD."recipient_user_id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."notification_type" IS DISTINCT FROM OLD."notification_type"
       OR NEW."template_version" IS DISTINCT FROM OLD."template_version"
       OR NEW."locale" IS DISTINCT FROM OLD."locale"
       OR NEW."title" IS DISTINCT FROM OLD."title"
       OR NEW."body" IS DISTINCT FROM OLD."body"
       OR NEW."deep_link" IS DISTINCT FROM OLD."deep_link"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
        RAISE EXCEPTION 'user_notification % is write-once except for read_at', OLD."id";
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "user_notifications_guard_trigger"
    BEFORE UPDATE ON "user_notifications"
    FOR EACH ROW EXECUTE FUNCTION user_notifications_guard();

-- A delivery's identity is fixed; its progress is not.
CREATE OR REPLACE FUNCTION notification_deliveries_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."notification_id" IS DISTINCT FROM OLD."notification_id"
       OR NEW."channel" IS DISTINCT FROM OLD."channel"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
        RAISE EXCEPTION 'notification_delivery % identity is immutable', OLD."id";
    END IF;

    -- Terminal means terminal. Without this a stale worker could move a
    -- delivered email back to PENDING and send it a second time.
    IF OLD."status" IN ('DELIVERED', 'FAILED_PERMANENT', 'SKIPPED')
       AND NEW."status" IS DISTINCT FROM OLD."status"
    THEN
        RAISE EXCEPTION 'notification_delivery % is already %', OLD."id", OLD."status";
    END IF;

    IF NEW."attempt_count" < OLD."attempt_count" THEN
        RAISE EXCEPTION 'notification_delivery % attempt count cannot go backwards', OLD."id";
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "notification_deliveries_guard_trigger"
    BEFORE UPDATE ON "notification_deliveries"
    FOR EACH ROW EXECUTE FUNCTION notification_deliveries_guard();

CREATE TRIGGER "notification_deliveries_no_delete"
    BEFORE DELETE ON "notification_deliveries"
    FOR EACH ROW EXECUTE FUNCTION notification_history_is_append_only();

-- =============================================================================
-- 8. Emitting an event
--
-- Four narrow functions, one per authoritative source, and no generic emitter.
-- Each takes exactly one authoritative row id and derives *everything* it
-- writes from that row: the event type, the owner, the organization, the
-- aggregate and the time it happened. There is no parameter through which a
-- caller can state what happened — which is the difference between a log of
-- events and a log of claims.
--
-- Every one is idempotent through `domain_events_source_identity`, and returns
-- the existing event's id on a replay rather than raising. A retried job, a
-- retried transaction and a duplicate delivery all converge on one event.
--
-- `p_event_schema_version` is not a parameter either: the constant 1 here is
-- DOMAIN_EVENT_SCHEMA_VERSION in the contracts package, and a payload that
-- changes meaning changes both together.
-- =============================================================================

-- A caller must be a party to the row it is emitting about. SECURITY DEFINER
-- opens a door for the whole application role; this is the lock on it.
CREATE OR REPLACE FUNCTION app_notification_caller_is_party(
    p_owner_user_id uuid, p_organization_id uuid
) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT app_is_platform_admin()
        OR p_owner_user_id = app_current_user_id()
        OR p_organization_id = app_current_organization();
$$;

CREATE OR REPLACE FUNCTION app_domain_event_emit_submission_ready(p_revision_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    revision "submission_revisions"%ROWTYPE;
    v_event_type "NotificationType";
    v_id uuid;
BEGIN
    SELECT * INTO revision FROM "submission_revisions" WHERE "id" = p_revision_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'submission_revision % does not exist', p_revision_id;
    END IF;

    IF NOT app_notification_caller_is_party(revision."owner_user_id", revision."organization_id") THEN
        RAISE EXCEPTION 'submission_revision % is not the caller''s to report', p_revision_id;
    END IF;

    -- The event reports an authoritative state, so the state must be the one
    -- being reported. A revision that is not READY has nothing to announce.
    IF revision."processing_status" <> 'READY' OR revision."submitted_at" IS NULL THEN
        RAISE EXCEPTION 'submission_revision % is not READY', p_revision_id
            USING ERRCODE = 'check_violation';
    END IF;

    -- Derived from authoritative state, never from a caller's word for it: the
    -- first revision is a new submission, any later one is a resubmission.
    v_event_type := CASE WHEN revision."revision_number" = 1
        THEN 'SUBMISSION_READY'::"NotificationType"
        ELSE 'SUBMISSION_REVISION_READY'::"NotificationType" END;

    INSERT INTO "domain_events" (
        "id", "event_type", "event_schema_version", "source_type", "source_id",
        "aggregate_type", "aggregate_id", "owner_user_id", "organization_id",
        "occurred_at", "payload"
    ) VALUES (
        gen_random_uuid(), v_event_type, 1, 'SUBMISSION_REVISION', revision."id",
        'OFFICIAL_SUBMISSION', revision."submission_id",
        revision."owner_user_id", revision."organization_id",
        revision."submitted_at",
        jsonb_build_object(
            'submissionId', revision."submission_id",
            'submissionRevisionId', revision."id",
            'revisionNumber', revision."revision_number"
        )
    )
    ON CONFLICT ("source_type", "source_id", "event_type") DO NOTHING
    RETURNING "id" INTO v_id;

    IF v_id IS NULL THEN
        SELECT "id" INTO v_id FROM "domain_events"
         WHERE "source_type" = 'SUBMISSION_REVISION'
           AND "source_id" = revision."id"
           AND "event_type" = v_event_type;
    END IF;

    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION app_domain_event_emit_decision(p_decision_event_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    decision "submission_decision_events"%ROWTYPE;
    revision "submission_revisions"%ROWTYPE;
    v_event_type "NotificationType";
    v_id uuid;
BEGIN
    SELECT * INTO decision FROM "submission_decision_events" WHERE "id" = p_decision_event_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'submission_decision_event % does not exist', p_decision_event_id;
    END IF;

    IF NOT app_notification_caller_is_party(decision."owner_user_id", decision."organization_id") THEN
        RAISE EXCEPTION 'submission_decision_event % is not the caller''s to report',
            p_decision_event_id;
    END IF;

    -- SUBMITTED is the system's own first transition. It is reported by the
    -- READY event above, from the revision, and emitting it here as well would
    -- notify the same thing twice from two sources.
    v_event_type := CASE decision."to_status"
        WHEN 'UNDER_REVIEW' THEN 'SUBMISSION_UNDER_REVIEW'::"NotificationType"
        WHEN 'APPROVED' THEN 'SUBMISSION_APPROVED'::"NotificationType"
        WHEN 'REJECTED' THEN 'SUBMISSION_REJECTED'::"NotificationType"
        WHEN 'REVISION_REQUESTED' THEN 'SUBMISSION_REVISION_REQUESTED'::"NotificationType"
        ELSE NULL
    END;

    IF v_event_type IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT * INTO revision FROM "submission_revisions"
     WHERE "id" = decision."submission_revision_id";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'submission_revision % does not exist', decision."submission_revision_id";
    END IF;

    INSERT INTO "domain_events" (
        "id", "event_type", "event_schema_version", "source_type", "source_id",
        "aggregate_type", "aggregate_id", "owner_user_id", "organization_id",
        "occurred_at", "payload"
    ) VALUES (
        gen_random_uuid(), v_event_type, 1, 'SUBMISSION_DECISION_EVENT', decision."id",
        'OFFICIAL_SUBMISSION', revision."submission_id",
        decision."owner_user_id", decision."organization_id",
        decision."created_at",
        jsonb_build_object(
            'submissionId', revision."submission_id",
            'submissionRevisionId', decision."submission_revision_id",
            'institutionDecisionStatus', decision."to_status"
        )
    )
    ON CONFLICT ("source_type", "source_id", "event_type") DO NOTHING
    RETURNING "id" INTO v_id;

    IF v_id IS NULL THEN
        SELECT "id" INTO v_id FROM "domain_events"
         WHERE "source_type" = 'SUBMISSION_DECISION_EVENT'
           AND "source_id" = decision."id"
           AND "event_type" = v_event_type;
    END IF;

    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION app_domain_event_emit_comment(p_comment_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    comment_row "submission_comments"%ROWTYPE;
    revision "submission_revisions"%ROWTYPE;
    v_id uuid;
BEGIN
    SELECT * INTO comment_row FROM "submission_comments" WHERE "id" = p_comment_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'submission_comment % does not exist', p_comment_id;
    END IF;

    IF NOT app_notification_caller_is_party(
            comment_row."owner_user_id", comment_row."organization_id") THEN
        RAISE EXCEPTION 'submission_comment % is not the caller''s to report', p_comment_id;
    END IF;

    SELECT * INTO revision FROM "submission_revisions"
     WHERE "id" = comment_row."submission_revision_id";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'submission_revision % does not exist',
            comment_row."submission_revision_id";
    END IF;

    INSERT INTO "domain_events" (
        "id", "event_type", "event_schema_version", "source_type", "source_id",
        "aggregate_type", "aggregate_id", "owner_user_id", "organization_id",
        "occurred_at", "payload"
    ) VALUES (
        gen_random_uuid(), 'SUBMISSION_COMMENT_ADDED', 1,
        'SUBMISSION_COMMENT', comment_row."id",
        'OFFICIAL_SUBMISSION', revision."submission_id",
        comment_row."owner_user_id", comment_row."organization_id",
        comment_row."created_at",
        -- Deliberately not the body. "You have a new comment" is the
        -- notification; reading it requires signing in (§11).
        jsonb_build_object(
            'submissionId', revision."submission_id",
            'submissionRevisionId', comment_row."submission_revision_id"
        )
    )
    ON CONFLICT ("source_type", "source_id", "event_type") DO NOTHING
    RETURNING "id" INTO v_id;

    IF v_id IS NULL THEN
        SELECT "id" INTO v_id FROM "domain_events"
         WHERE "source_type" = 'SUBMISSION_COMMENT'
           AND "source_id" = comment_row."id"
           AND "event_type" = 'SUBMISSION_COMMENT_ADDED';
    END IF;

    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION app_domain_event_emit_certificate(p_certificate_event_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    certificate_event "certificate_events"%ROWTYPE;
    certificate "compliance_certificates"%ROWTYPE;
    v_event_type "NotificationType";
    v_id uuid;
BEGIN
    SELECT * INTO certificate_event FROM "certificate_events" WHERE "id" = p_certificate_event_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'certificate_event % does not exist', p_certificate_event_id;
    END IF;

    IF NOT app_notification_caller_is_party(
            certificate_event."owner_user_id", certificate_event."organization_id") THEN
        RAISE EXCEPTION 'certificate_event % is not the caller''s to report', p_certificate_event_id;
    END IF;

    v_event_type := CASE certificate_event."event_type"
        WHEN 'ISSUED' THEN 'CERTIFICATE_ISSUED'::"NotificationType"
        WHEN 'REVOKED' THEN 'CERTIFICATE_REVOKED'::"NotificationType"
        ELSE NULL
    END;

    IF v_event_type IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT * INTO certificate FROM "compliance_certificates"
     WHERE "id" = certificate_event."certificate_id";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'compliance_certificate % does not exist',
            certificate_event."certificate_id";
    END IF;

    INSERT INTO "domain_events" (
        "id", "event_type", "event_schema_version", "source_type", "source_id",
        "aggregate_type", "aggregate_id", "owner_user_id", "organization_id",
        "occurred_at", "payload"
    ) VALUES (
        gen_random_uuid(), v_event_type, 1, 'CERTIFICATE_EVENT', certificate_event."id",
        'COMPLIANCE_CERTIFICATE', certificate."id",
        certificate_event."owner_user_id", certificate_event."organization_id",
        certificate_event."created_at",
        -- Never the verification code, never the certificate number, never the
        -- claim or its hash: a notification must not be a way to obtain the
        -- capability to verify somebody else's certificate (Phase 15).
        jsonb_build_object(
            'certificateId', certificate."id",
            'submissionId', certificate."submission_id"
        )
    )
    ON CONFLICT ("source_type", "source_id", "event_type") DO NOTHING
    RETURNING "id" INTO v_id;

    IF v_id IS NULL THEN
        SELECT "id" INTO v_id FROM "domain_events"
         WHERE "source_type" = 'CERTIFICATE_EVENT'
           AND "source_id" = certificate_event."id"
           AND "event_type" = v_event_type;
    END IF;

    RETURN v_id;
END;
$$;

-- =============================================================================
-- 9. Resolving recipients
--
-- The reviewer audience is "the people who can actually review this", and that
-- is a permission question, so it is answered where permissions live rather
-- than by a service assembling a role list. The permission code is not a
-- parameter: a caller cannot ask "who holds certificate:revocation:write" and
-- get a mailing list out of it.
--
-- The organization is not a parameter either. It is derived from the event,
-- for the same reason the emitters derive everything from their source row: a
-- caller may ask about an event that exists, not about any organization it
-- likes.
--
-- Bounded and keyset-paginated, because an organization with ten thousand
-- reviewers must page rather than build one unbounded list in memory (§23).
-- =============================================================================
CREATE OR REPLACE FUNCTION app_notification_submission_reviewers(
    p_event_id uuid,
    p_limit integer DEFAULT 100,
    p_after uuid DEFAULT NULL
) RETURNS TABLE ("user_id" uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    event_row "domain_events"%ROWTYPE;
    v_limit integer;
BEGIN
    SELECT * INTO event_row FROM "domain_events" WHERE "id" = p_event_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'domain_event % does not exist', p_event_id;
    END IF;

    IF NOT app_notification_caller_is_party(
            event_row."owner_user_id", event_row."organization_id") THEN
        RAISE EXCEPTION 'domain_event % is not the caller''s to fan out', p_event_id;
    END IF;

    v_limit := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);

    RETURN QUERY
    SELECT DISTINCT m."user_id"
      FROM "organization_memberships" m
      JOIN "user_roles" ur
        ON ur."user_id" = m."user_id" AND ur."organization_id" = m."organization_id"
      JOIN "role_permissions" rp ON rp."role_id" = ur."role_id"
      JOIN "permissions" perm
        ON perm."id" = rp."permission_id" AND perm."code" = 'submission:review:read'
      JOIN "users" u ON u."id" = m."user_id"
     WHERE m."organization_id" = event_row."organization_id"
       AND m."status" = 'ACTIVE'
       -- §22, §65: authority is resolved now, not when the event happened. A
       -- reviewer who left the organization is not told about its work.
       AND u."status" = 'ACTIVE'
       AND (p_after IS NULL OR m."user_id" > p_after)
     ORDER BY m."user_id"
     LIMIT v_limit;
END;
$$;

-- =============================================================================
-- 10. Writing one recipient's copy
--
-- Fan-out writes for people who are not the caller, so it cannot be a
-- self-insert policy. It is this function instead: it derives the type and the
-- organization from the event, writes the rendered copy, and records the
-- in-app delivery in the same statement — because for IN_APP, delivery *is*
-- the row existing, and a notification without one would be a copy nobody was
-- ever shown.
--
-- Idempotent through `user_notifications_logical_identity`: a replayed fan-out
-- returns the id it wrote last time.
-- =============================================================================
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
    v_id uuid;
    v_created boolean := false;
    v_now timestamptz := now();
BEGIN
    SELECT * INTO event_row FROM "domain_events" WHERE "id" = p_source_event_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'domain_event % does not exist', p_source_event_id;
    END IF;

    IF NOT app_notification_caller_is_party(
            event_row."owner_user_id", event_row."organization_id") THEN
        RAISE EXCEPTION 'domain_event % is not the caller''s to fan out', p_source_event_id;
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

    v_created := v_id IS NOT NULL;

    IF NOT v_created THEN
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

-- =============================================================================
-- 11. Grants
--
-- Phase 2's default privileges already reach new tables, so the surface is
-- narrowed explicitly rather than assumed. The shape to notice is
-- `domain_events`: the application role may read the log and cannot write to
-- it at all. Every event in PalCert is therefore the work of one of the four
-- emitters above, not of anything that happens to hold a database connection.
-- =============================================================================
REVOKE ALL ON "domain_events" FROM "palcert_app";
GRANT SELECT ON "domain_events" TO "palcert_app";

REVOKE ALL ON "user_notifications" FROM "palcert_app";
-- No INSERT: fan-out goes through app_notification_create. No DELETE: a
-- notification is a record of what somebody was told.
GRANT SELECT, UPDATE ON "user_notifications" TO "palcert_app";

REVOKE ALL ON "notification_deliveries" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "notification_deliveries" TO "palcert_app";

REVOKE ALL ON "notification_delivery_attempts" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "notification_delivery_attempts" TO "palcert_app";

REVOKE ALL ON "notification_preferences" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "notification_preferences" TO "palcert_app";

GRANT EXECUTE ON FUNCTION app_is_notification_system_writer() TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_notification_caller_is_party(uuid, uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION notification_history_is_append_only() TO "palcert_app";
GRANT EXECUTE ON FUNCTION notification_delivery_attempts_guard() TO "palcert_app";
GRANT EXECUTE ON FUNCTION notification_deliveries_guard() TO "palcert_app";
GRANT EXECUTE ON FUNCTION user_notifications_guard() TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_domain_event_emit_submission_ready(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_domain_event_emit_decision(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_domain_event_emit_comment(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_domain_event_emit_certificate(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_notification_submission_reviewers(uuid, integer, uuid)
    TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_notification_create(
    uuid, uuid, uuid, text, text, text, text, text
) TO "palcert_app";

-- =============================================================================
-- 12. The isolation catalogue
-- =============================================================================
INSERT INTO "table_isolation_classification" ("table_name", "classification", "tenant_column", "notes")
VALUES
    ('domain_events', 'SYSTEM', NULL,
     'PalCert''s own append-only event log. No tenant or user reads it; the application role holds SELECT and no write privilege at all.'),
    ('user_notifications', 'USER_SCOPED', 'recipient_user_id',
     'One person''s private copy of an event. Never organization-readable: the organization id on the row is a label, not a second reader.'),
    ('notification_deliveries', 'SYSTEM', NULL,
     'Delivery machinery. Carries no message content beyond the channel and a normalized error code, and is exposed by no route.'),
    ('notification_delivery_attempts', 'SYSTEM', NULL,
     'Append-only attempt history. Enough to answer "was it attempted, and how did it end" without anyone reading somebody''s mail.'),
    ('notification_preferences', 'USER_SCOPED', 'user_id',
     'A person''s own email choices. A mandatory type cannot be switched off, and the database refuses a row that says otherwise.')
ON CONFLICT ("table_name") DO UPDATE
    SET "classification" = EXCLUDED."classification",
        "tenant_column" = EXCLUDED."tenant_column",
        "notes" = EXCLUDED."notes";

-- =============================================================================
-- 13. The two new job resource types
--
-- Both are PalCert's own work rather than one customer's: a fan-out serves
-- every recipient of an event, several of whom are reviewers in an
-- organization the subject does not belong to. Filing the job under the
-- subject's user id would say something false about whose work it is, so both
-- types join the system branch with neither column set — as the payment types
-- already do.
-- =============================================================================
ALTER TABLE "processing_jobs" DROP CONSTRAINT "processing_jobs_resource_type_known";
ALTER TABLE "processing_jobs"
    ADD CONSTRAINT "processing_jobs_resource_type_known"
    CHECK ("resource_type" IN (
        'DOCUMENT_VERSION', 'DOCUMENT', 'DOCUMENT_ANALYSIS', 'DOCUMENT_CHECK', 'CHECK_RUN', 'AI_REVIEW',
        'STANDARD_SOURCE_ASSET', 'RULE_EXTRACTION_RUN',
        'PAYMENT_PROVIDER_EVENT', 'PAYMENT_RECONCILIATION',
        'SMARTFIX_REQUEST', 'SUBMISSION_REVISION', 'COMPLIANCE_CERTIFICATE',
        'DOMAIN_EVENT', 'NOTIFICATION_DELIVERY'));

ALTER TABLE "processing_jobs" DROP CONSTRAINT "processing_jobs_tenancy_matches_type";
ALTER TABLE "processing_jobs"
    ADD CONSTRAINT "processing_jobs_tenancy_matches_type" CHECK (
        ("resource_type" IN ('STANDARD_SOURCE_ASSET', 'RULE_EXTRACTION_RUN')
            AND "organization_id" IS NOT NULL AND "owner_user_id" IS NOT NULL)
        OR ("resource_type" IN ('PAYMENT_PROVIDER_EVENT', 'PAYMENT_RECONCILIATION',
                                'DOMAIN_EVENT', 'NOTIFICATION_DELIVERY')
            AND "organization_id" IS NULL AND "owner_user_id" IS NULL)
        OR ("resource_type" NOT IN ('STANDARD_SOURCE_ASSET', 'RULE_EXTRACTION_RUN',
                                    'PAYMENT_PROVIDER_EVENT', 'PAYMENT_RECONCILIATION',
                                    'DOMAIN_EVENT', 'NOTIFICATION_DELIVERY')
            AND "organization_id" IS NULL AND "owner_user_id" IS NOT NULL)
    );

-- =============================================================================
-- 14. Permissions
--
-- Self-scoped, and granted to every role that holds the other self-service
-- permissions — derived from the catalogue rather than re-listed, so a role
-- added in a later phase cannot silently miss them.
--
-- Reading your inbox and changing what PalCert sends on your behalf are
-- separate authorities: the second is not a way of reading the first.
-- =============================================================================
INSERT INTO "permissions" ("id", "code", "description") VALUES
    (gen_random_uuid(), 'notification:read:self',
     'Read your own notifications and unread count'),
    (gen_random_uuid(), 'notification:write:self',
     'Mark your own notifications as read'),
    (gen_random_uuid(), 'notification:preference:write:self',
     'Choose which workflow emails PalCert sends you')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT DISTINCT rp."role_id", p."id"
FROM "role_permissions" rp
JOIN "permissions" anchor
  ON anchor."id" = rp."permission_id" AND anchor."code" = 'profile:read:self'
CROSS JOIN "permissions" p
WHERE p."code" IN (
    'notification:read:self', 'notification:write:self', 'notification:preference:write:self')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- =============================================================================
-- 15. Documentation
-- =============================================================================
COMMENT ON TABLE "domain_events" IS
    'Append-only log of authoritative workflow events (ADR-0116). Not a second outbox: ProcessingJob remains the one dispatch mechanism, and these rows are the source identity it refers to.';
COMMENT ON TABLE "user_notifications" IS
    'One recipient''s private copy of one event, rendered at fan-out time and never rewritten. Reports an event; is never the authority for it.';
COMMENT ON TABLE "notification_deliveries" IS
    'One logical delivery per (notification, channel). Unique, so duplicate events cannot schedule two emails; external exactly-once is not claimed.';
COMMENT ON TABLE "notification_delivery_attempts" IS
    'Append-only history of attempts. Carries no message content and no address.';
COMMENT ON TABLE "notification_preferences" IS
    'A person''s email choices. CERTIFICATE_REVOKED cannot be switched off, and the constraint says so rather than the service.';
