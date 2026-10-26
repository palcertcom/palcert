-- =============================================================================
-- Phase 16 — fan-out is system work, and says so
--
-- The first cut gave the fan-out functions the same party check the emitters
-- use, and the worker satisfied it by opening its transaction as
-- `withUser(event.owner_user_id)`. That worked, and it was wrong: the worker
-- was borrowing a customer's identity as its authority in order to enumerate
-- an organization's reviewers and write into their inboxes. The
-- NOTIFICATION_FANOUT job deliberately carries neither an owner nor an
-- organization precisely because it is nobody's work but PalCert's.
--
-- Two changes, and they are different in kind:
--
--   1. Fan-out functions require *system* context — no user, no organization.
--      Every request path sets `palcert.current_user_id` before it touches
--      anything, so an authenticated HTTP request cannot reach these
--      functions at all. The worker calls them with no scope set, which is
--      the truth about what it is.
--
--   2. `app_notification_create` validates the recipient against the event's
--      own audience, in the database. Until now the doorway was wider than
--      the product rule: pass the party check and any user id was accepted.
--      The service supplied the right one, but "the caller is careful" is not
--      an invariant. Now a valid event plus an arbitrary user id is refused,
--      so no future application bug can inject a notification into an
--      unrelated inbox.
--
-- Delivery-time reauthorization stays exactly as it is. The two solve
-- different races: this one refuses a recipient who was never eligible, and
-- that one refuses a recipient who stopped being eligible.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. What "system context" means
--
-- Not a flag a caller sets — `palcert_app` could set any flag it liked. The
-- *absence* of a tenant scope is the signal, and it is one the request path
-- cannot forge in the other direction: `TenantPrismaService` sets the user
-- GUC on every request-path transaction, so a route cannot arrive here
-- unscoped however it is written.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_is_notification_fanout_context() RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        app_current_user_id() IS NULL AND app_current_organization() IS NULL,
        false
    );
$$;

GRANT EXECUTE ON FUNCTION app_is_notification_fanout_context() TO "palcert_app";

-- ---------------------------------------------------------------------------
-- 2. Who an event is for, answered by the database
--
-- The audience rule lives in one place and both fan-out functions consult it.
-- Duplicating it in the service and here would be two things to keep in step,
-- and the first drift between them would be a notification delivered to
-- somebody the rule never named.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_notification_audience(p_event_type "NotificationType")
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_event_type IN ('SUBMISSION_READY', 'SUBMISSION_REVISION_READY')
            THEN 'ORGANIZATION_REVIEWERS'
        WHEN p_event_type IN ('CERTIFICATE_ISSUED', 'CERTIFICATE_REVOKED')
            THEN 'CERTIFICATE_OWNER'
        ELSE 'SUBMISSION_OWNER'
    END;
$$;

GRANT EXECUTE ON FUNCTION app_notification_audience("NotificationType") TO "palcert_app";

-- Is this person, right now, somebody who reviews for this organization?
-- Used by fan-out to validate a recipient and by the resolver to produce one,
-- so a recipient the resolver would never return cannot be accepted either.
CREATE OR REPLACE FUNCTION app_notification_is_reviewer(
    p_organization_id uuid, p_user_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1
          FROM "organization_memberships" m
          JOIN "user_roles" ur
            ON ur."user_id" = m."user_id" AND ur."organization_id" = m."organization_id"
          JOIN "role_permissions" rp ON rp."role_id" = ur."role_id"
          JOIN "permissions" perm
            ON perm."id" = rp."permission_id" AND perm."code" = 'submission:review:read'
          JOIN "users" u ON u."id" = m."user_id"
         WHERE m."organization_id" = p_organization_id
           AND m."user_id" = p_user_id
           AND m."status" = 'ACTIVE'
           AND u."status" = 'ACTIVE'
    );
$$;

GRANT EXECUTE ON FUNCTION app_notification_is_reviewer(uuid, uuid) TO "palcert_app";

-- ---------------------------------------------------------------------------
-- 3. The reviewer resolver, now system-only
--
-- The event id stays the parameter — deriving the organization from an
-- authoritative row is stronger than accepting one, and that part was right.
-- What changes is the authority: system context, not a borrowed customer.
-- ---------------------------------------------------------------------------
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
    IF NOT app_is_notification_fanout_context() THEN
        RAISE EXCEPTION 'resolving notification recipients is system work'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO event_row FROM "domain_events" WHERE "id" = p_event_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'domain_event % does not exist', p_event_id;
    END IF;

    -- Only the two event types whose audience is the reviewers. Asking about
    -- any other kind is a bug in the caller, not an empty answer to return.
    IF app_notification_audience(event_row."event_type") <> 'ORGANIZATION_REVIEWERS' THEN
        RAISE EXCEPTION 'domain_event % is not a reviewer-audience event', p_event_id
            USING ERRCODE = 'check_violation';
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
       AND u."status" = 'ACTIVE'
       AND (p_after IS NULL OR m."user_id" > p_after)
     ORDER BY m."user_id"
     LIMIT v_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Writing one copy, with the recipient checked against the audience
-- ---------------------------------------------------------------------------
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
    v_audience text;
    v_id uuid;
    v_now timestamptz := now();
BEGIN
    IF NOT app_is_notification_fanout_context() THEN
        RAISE EXCEPTION 'creating a notification is system work'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO event_row FROM "domain_events" WHERE "id" = p_source_event_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'domain_event % does not exist', p_source_event_id;
    END IF;

    v_audience := app_notification_audience(event_row."event_type");

    -- The rule, enforced where it cannot be bypassed. An owner-audience event
    -- is for its owner and nobody else; a reviewer-audience event is for
    -- somebody who reviews for that organization *now*.
    IF v_audience = 'ORGANIZATION_REVIEWERS' THEN
        IF NOT app_notification_is_reviewer(
                event_row."organization_id", p_recipient_user_id) THEN
            RAISE EXCEPTION
                'user % is not a reviewer for domain_event %',
                p_recipient_user_id, p_source_event_id
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    ELSIF p_recipient_user_id IS DISTINCT FROM event_row."owner_user_id" THEN
        RAISE EXCEPTION
            'domain_event % is for its owner, not for user %',
            p_source_event_id, p_recipient_user_id
            USING ERRCODE = 'insufficient_privilege';
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

    IF v_id IS NULL THEN
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

-- ---------------------------------------------------------------------------
-- 5. A code for an attempt nobody finished
--
-- A worker that died between claiming a delivery and hearing back from the
-- relay leaves an attempt that is neither a success nor a rejection. Recording
-- it as PROVIDER_UNAVAILABLE would say the relay did something; it did not.
-- The honest answer is that PalCert stopped, and an operator reading the
-- attempt history should be able to tell those apart.
-- ---------------------------------------------------------------------------
ALTER TABLE "notification_deliveries"
    DROP CONSTRAINT "notification_deliveries_error_code_known";
ALTER TABLE "notification_deliveries"
    ADD CONSTRAINT "notification_deliveries_error_code_known" CHECK (
        "last_error_code" IS NULL OR "last_error_code" IN
            ('PROVIDER_UNAVAILABLE', 'PROVIDER_REJECTED',
             'RECIPIENT_REJECTED', 'CONFIGURATION_REJECTED', 'WORKER_INTERRUPTED')
    );

ALTER TABLE "notification_delivery_attempts"
    DROP CONSTRAINT "notification_delivery_attempts_error_code_known";
ALTER TABLE "notification_delivery_attempts"
    ADD CONSTRAINT "notification_delivery_attempts_error_code_known" CHECK (
        "error_code" IS NULL OR "error_code" IN
            ('PROVIDER_UNAVAILABLE', 'PROVIDER_REJECTED',
             'RECIPIENT_REJECTED', 'CONFIGURATION_REJECTED', 'WORKER_INTERRUPTED')
    );

COMMENT ON FUNCTION app_is_notification_fanout_context() IS
    'True only with no user and no organization scope. Every request path sets a user scope, so a route cannot reach fan-out.';
COMMENT ON FUNCTION app_notification_create(uuid, uuid, uuid, text, text, text, text, text) IS
    'Writes one recipient copy. Refuses a recipient the event audience does not name, so a valid event plus an arbitrary user id cannot inject a notification.';
