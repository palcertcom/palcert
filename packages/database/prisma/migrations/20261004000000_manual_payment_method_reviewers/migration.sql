-- =============================================================================
-- Manual payment method reviewers (ADR-0148)
--
-- An administrator names, per manual payment method, the PalCert finance staff
-- who review top-ups sent through it. A submission alert goes to those people
-- — re-checked against their authority as it stands — instead of to every
-- finance reviewer.
--
-- Additive only:
--   * one new table, empty at creation, so every existing method keeps today's
--     behaviour (the whole PLATFORM_FINANCE_REVIEWERS audience) until an
--     administrator assigns somebody;
--   * the platform branch of the reviewer resolver gains a method-specific
--     path and falls back to the global audience when no assigned reviewer
--     still qualifies — every other branch is reproduced unchanged;
--   * the top-up facts doorway gains one allow-listed column, submitted_at;
--   * two read-only functions: routing (for the fan-out to record a fallback)
--     and the delivery report (for the admin diagnostics panel).
--
-- No existing row is touched: no request, no ledger entry, no snapshot, no
-- notification, no method.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The assignment
-- -----------------------------------------------------------------------------
CREATE TABLE "manual_payment_method_reviewers" (
    "payment_method_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID,

    CONSTRAINT "manual_payment_method_reviewers_pkey" PRIMARY KEY ("payment_method_id", "user_id")
);

CREATE INDEX "manual_payment_method_reviewers_user_idx"
    ON "manual_payment_method_reviewers"("user_id");

ALTER TABLE "manual_payment_method_reviewers"
    ADD CONSTRAINT "manual_payment_method_reviewers_method_fkey"
    FOREIGN KEY ("payment_method_id") REFERENCES "manual_payment_methods"("id") ON DELETE RESTRICT;
ALTER TABLE "manual_payment_method_reviewers"
    ADD CONSTRAINT "manual_payment_method_reviewers_user_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "manual_payment_method_reviewers"
    ADD CONSTRAINT "manual_payment_method_reviewers_created_by_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;

-- Only somebody who holds finance:manual-topup:review through a GLOBAL role,
-- and is ACTIVE, can be assigned. An organization role of any kind never
-- qualifies, and an arbitrary address cannot be stored at all — the column is
-- a user id. Checked here so that no client, however written, can name a
-- reviewer the email could reach but the review page would refuse.
CREATE OR REPLACE FUNCTION manual_payment_method_reviewers_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT app_notification_is_platform_reviewer(NEW."user_id", 'finance:manual-topup:review') THEN
        RAISE EXCEPTION 'user % does not hold finance:manual-topup:review through a platform role',
            NEW."user_id"
            USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
        SELECT 1 FROM "manual_payment_methods" m
         WHERE m."id" = NEW."payment_method_id" AND m."archived_at" IS NOT NULL)
    THEN
        RAISE EXCEPTION 'manual_payment_method % is archived', NEW."payment_method_id"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "manual_payment_method_reviewers_guard"
    BEFORE INSERT ON "manual_payment_method_reviewers"
    FOR EACH ROW EXECUTE FUNCTION manual_payment_method_reviewers_guard();

ALTER TABLE "manual_payment_method_reviewers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "manual_payment_method_reviewers" FORCE ROW LEVEL SECURITY;
-- PalCert's own configuration: read and written only through the audited
-- platform elevation. Customers and organizations never see who reviews.
CREATE POLICY "manual_payment_method_reviewers_admin" ON "manual_payment_method_reviewers" FOR ALL
    USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());

-- An assignment is configuration, not financial history: removing a reviewer
-- deletes the row, and the audit trail records who changed it. Rows are never
-- updated in place.
GRANT SELECT, INSERT, DELETE ON "manual_payment_method_reviewers" TO "palcert_app";
REVOKE UPDATE, TRUNCATE ON "manual_payment_method_reviewers" FROM "palcert_app";

INSERT INTO "table_isolation_classification" ("table_name", "classification", "tenant_column", "notes")
VALUES
    ('manual_payment_method_reviewers', 'SYSTEM', NULL,
     'PalCert finance staff assigned to review top-ups for one manual payment method. Written by platform administrators; only GLOBAL holders of finance:manual-topup:review may be assigned.')
ON CONFLICT ("table_name") DO UPDATE
    SET "classification" = EXCLUDED."classification",
        "tenant_column" = EXCLUDED."tenant_column",
        "notes" = EXCLUDED."notes";

-- -----------------------------------------------------------------------------
-- 2. Routing a submission
-- -----------------------------------------------------------------------------

-- The method a manual top-up event is about. NULL for any other event.
CREATE OR REPLACE FUNCTION app_manual_topup_event_method(p_event_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT r."payment_method_id"
      FROM "domain_events" e
      JOIN "manual_topup_requests" r ON r."id" = e."aggregate_id"
     WHERE e."id" = p_event_id
       AND e."aggregate_type" = 'MANUAL_TOPUP_REQUEST';
$$;

-- How a submission's reviewers are chosen, and how many there are:
--   METHOD_REVIEWERS          assigned reviewers who still qualify exist
--   FALLBACK_NO_ELIGIBLE      reviewers are assigned, none still qualifies:
--                             the global audience is used, and the fan-out
--                             records that it was
--   GLOBAL_NOT_CONFIGURED     nobody is assigned: today's behaviour
CREATE OR REPLACE FUNCTION app_manual_topup_reviewer_routing(p_event_id uuid)
RETURNS TABLE (
    "routing" text,
    "payment_method_id" uuid,
    "configured_count" integer,
    "eligible_count" integer,
    "global_count" integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_method uuid;
    v_configured integer;
    v_eligible integer;
    v_global integer;
BEGIN
    IF NOT app_is_notification_fanout_context() THEN
        RAISE EXCEPTION 'resolving notification recipients is system work'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    v_method := app_manual_topup_event_method(p_event_id);

    SELECT count(*)::integer,
           count(*) FILTER (WHERE app_notification_is_platform_reviewer(
               mr."user_id", 'finance:manual-topup:review'))::integer
      INTO v_configured, v_eligible
      FROM "manual_payment_method_reviewers" mr
     WHERE mr."payment_method_id" = v_method;

    SELECT count(DISTINCT ur."user_id")::integer INTO v_global
      FROM "user_roles" ur
      JOIN "role_permissions" rp ON rp."role_id" = ur."role_id"
      JOIN "permissions" perm
        ON perm."id" = rp."permission_id" AND perm."code" = 'finance:manual-topup:review'
      JOIN "users" u ON u."id" = ur."user_id"
     WHERE ur."scope" = 'GLOBAL' AND ur."organization_id" IS NULL AND u."status" = 'ACTIVE';

    RETURN QUERY SELECT
        CASE
            WHEN v_eligible > 0 THEN 'METHOD_REVIEWERS'
            WHEN v_configured > 0 THEN 'FALLBACK_NO_ELIGIBLE'
            ELSE 'GLOBAL_NOT_CONFIGURED'
        END,
        v_method, v_configured, v_eligible, v_global;
END;
$$;

-- The reviewer resolver. Organization audiences are resolved exactly as
-- before. The platform audience now prefers the submission's method's
-- assigned reviewers who still qualify, and otherwise resolves from every
-- GLOBAL role holder exactly as before — so a method with nobody assigned,
-- or whose assignees all lost their authority, still reaches finance.
CREATE OR REPLACE FUNCTION app_notification_submission_reviewers(
    p_event_id uuid,
    p_limit integer DEFAULT 100,
    p_after uuid DEFAULT NULL
) RETURNS TABLE ("user_id" uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    event_row "domain_events"%ROWTYPE;
    v_limit integer;
    v_audience text;
    v_permission text;
    v_method uuid;
BEGIN
    IF NOT app_is_notification_fanout_context() THEN
        RAISE EXCEPTION 'resolving notification recipients is system work'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO event_row FROM "domain_events" WHERE "id" = p_event_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'domain_event % does not exist', p_event_id;
    END IF;

    v_audience := app_notification_audience(event_row."event_type");
    v_permission := app_notification_reviewer_permission(v_audience);
    IF v_permission IS NULL THEN
        RAISE EXCEPTION 'domain_event % is not a reviewer-audience event', p_event_id
            USING ERRCODE = 'check_violation';
    END IF;

    v_limit := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);

    IF app_notification_is_platform_audience(v_audience) THEN
        IF event_row."organization_id" IS NOT NULL THEN
            RAISE EXCEPTION 'domain_event % names an organization but is platform-scoped', p_event_id
                USING ERRCODE = 'check_violation';
        END IF;

        v_method := app_manual_topup_event_method(p_event_id);
        IF v_method IS NOT NULL AND EXISTS (
            SELECT 1 FROM "manual_payment_method_reviewers" mr
             WHERE mr."payment_method_id" = v_method
               AND app_notification_is_platform_reviewer(mr."user_id", v_permission))
        THEN
            RETURN QUERY
            SELECT mr."user_id"
              FROM "manual_payment_method_reviewers" mr
             WHERE mr."payment_method_id" = v_method
               AND app_notification_is_platform_reviewer(mr."user_id", v_permission)
               AND (p_after IS NULL OR mr."user_id" > p_after)
             ORDER BY mr."user_id"
             LIMIT v_limit;
            RETURN;
        END IF;

        RETURN QUERY
        SELECT DISTINCT ur."user_id"
          FROM "user_roles" ur
          JOIN "role_permissions" rp ON rp."role_id" = ur."role_id"
          JOIN "permissions" perm
            ON perm."id" = rp."permission_id" AND perm."code" = v_permission
          JOIN "users" u ON u."id" = ur."user_id"
         WHERE ur."scope" = 'GLOBAL'
           AND ur."organization_id" IS NULL
           AND u."status" = 'ACTIVE'
           AND (p_after IS NULL OR ur."user_id" > p_after)
         ORDER BY ur."user_id"
         LIMIT v_limit;
        RETURN;
    END IF;

    RETURN QUERY
    SELECT DISTINCT m."user_id"
      FROM "organization_memberships" m
      JOIN "user_roles" ur
        ON ur."user_id" = m."user_id" AND ur."organization_id" = m."organization_id"
      JOIN "role_permissions" rp ON rp."role_id" = ur."role_id"
      JOIN "permissions" perm
        ON perm."id" = rp."permission_id" AND perm."code" = v_permission
      JOIN "users" u ON u."id" = m."user_id"
     WHERE m."organization_id" = event_row."organization_id"
       AND m."status" = 'ACTIVE'
       AND u."status" = 'ACTIVE'
       AND (p_after IS NULL OR m."user_id" > p_after)
     ORDER BY m."user_id"
     LIMIT v_limit;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. The email's facts gain the submitted time
-- -----------------------------------------------------------------------------
-- The return type changes, so the function is replaced rather than amended.
-- Same doorway, same authority rule; one more allow-listed column.
DROP FUNCTION app_manual_topup_notification_facts(uuid, uuid);

CREATE FUNCTION app_manual_topup_notification_facts(
    p_event_id uuid, p_recipient_user_id uuid
) RETURNS TABLE (
    "amount_minor" bigint,
    "currency" text,
    "method_name_en" text,
    "method_name_ar" text,
    "reference" text,
    "rejection_reason" text,
    "submitted_at" timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    event_row "domain_events"%ROWTYPE;
BEGIN
    SELECT * INTO event_row FROM "domain_events" WHERE "id" = p_event_id;
    IF NOT FOUND OR event_row."aggregate_type" <> 'MANUAL_TOPUP_REQUEST' THEN
        RETURN;
    END IF;

    IF NOT app_is_notification_fanout_context() THEN
        IF app_current_user_id() IS NULL
           OR app_current_user_id() <> p_recipient_user_id
           OR NOT EXISTS (
                SELECT 1 FROM "user_notifications" n
                 WHERE n."source_event_id" = p_event_id
                   AND n."recipient_user_id" = p_recipient_user_id)
        THEN
            RAISE EXCEPTION 'manual top-up notification facts are for their recipient'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;

    RETURN QUERY
    SELECT r."amount_minor",
           r."currency"::text,
           r."payment_method_snapshot"->>'nameEn',
           r."payment_method_snapshot"->>'nameAr',
           r."reference_original"::text,
           r."rejection_reason"::text,
           r."submitted_at"
      FROM "manual_topup_requests" r
     WHERE r."id" = event_row."aggregate_id";
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. "No email arrived": the delivery report behind the admin panel
-- -----------------------------------------------------------------------------
-- One row per person a request's submission alert was created for, with the
-- in-app and email delivery state and the skip reason. Platform elevation
-- only (the route requires admin:payment-method:manage). Notification rows are
-- otherwise readable by their recipient alone, so this is the narrow doorway:
-- routing metadata and statuses, never a title, body or link.
CREATE OR REPLACE FUNCTION app_manual_topup_notification_report(p_request_id uuid)
RETURNS TABLE (
    "recipient_user_id" uuid,
    "display_name" text,
    "email" text,
    "email_verified" boolean,
    "account_status" text,
    "notified_at" timestamptz,
    "read_at" timestamptz,
    "in_app_status" text,
    "email_status" text,
    "email_skip_reason" text,
    "email_attempts" integer,
    "email_error_code" text,
    "email_updated_at" timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_is_platform_admin() THEN
        RAISE EXCEPTION 'the manual top-up notification report is for PalCert administrators'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN QUERY
    SELECT n."recipient_user_id",
           u."display_name"::text,
           u."email"::text,
           (u."email_verified_at" IS NOT NULL),
           u."status"::text,
           n."created_at",
           n."read_at",
           ia."status"::text,
           em."status"::text,
           em."skip_reason"::text,
           em."attempt_count",
           em."last_error_code"::text,
           em."updated_at"
      FROM "domain_events" e
      JOIN "user_notifications" n ON n."source_event_id" = e."id"
      JOIN "users" u ON u."id" = n."recipient_user_id"
      LEFT JOIN "notification_deliveries" ia
        ON ia."notification_id" = n."id" AND ia."channel" = 'IN_APP'
      LEFT JOIN "notification_deliveries" em
        ON em."notification_id" = n."id" AND em."channel" = 'EMAIL'
     WHERE e."aggregate_type" = 'MANUAL_TOPUP_REQUEST'
       AND e."aggregate_id" = p_request_id
       AND e."event_type" = 'MANUAL_TOPUP_SUBMITTED'
     ORDER BY n."created_at", n."recipient_user_id";
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Function privileges
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION manual_payment_method_reviewers_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_manual_topup_event_method(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_manual_topup_reviewer_routing(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_manual_topup_notification_facts(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_manual_topup_notification_report(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_manual_topup_reviewer_routing(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_manual_topup_notification_facts(uuid, uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_manual_topup_notification_report(uuid) TO "palcert_app";

COMMENT ON TABLE "manual_payment_method_reviewers" IS
    'Finance staff who review top-ups sent through one manual payment method. Assignment grants no permission; a reviewer must still hold finance:manual-topup:review through a GLOBAL role, re-checked at fan-out and at send.';
