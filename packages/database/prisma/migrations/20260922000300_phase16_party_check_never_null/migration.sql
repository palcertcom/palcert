-- =============================================================================
-- Phase 16 — a caller check that cannot answer "maybe"
--
-- `app_notification_caller_is_party` compared the row's owner and organization
-- against the session GUCs. When a GUC is unset those functions return NULL,
-- and `x = NULL` is NULL rather than false — so the whole predicate evaluated
-- to NULL, `IF NOT NULL THEN` never fired, and the guard let the caller
-- through. A caller with no organization context could resolve any
-- organization's reviewers, and emit an event about a row they had nothing to
-- do with.
--
-- SQL's three-valued logic is the whole of the defect: the comparison was
-- right and the answer was "unknown", which an authorization check must read
-- as no. Each side now requires its context to exist before it can match, and
-- the result is coalesced, so the function returns true or false and never
-- NULL.
--
-- Found by the database-invariant test that asserts an outsider cannot ask
-- who reviews for a tenant they have nothing to do with.
-- =============================================================================
CREATE OR REPLACE FUNCTION app_notification_caller_is_party(
    p_owner_user_id uuid, p_organization_id uuid
) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        app_is_platform_admin()
        OR (app_current_user_id() IS NOT NULL AND p_owner_user_id = app_current_user_id())
        OR (app_current_organization() IS NOT NULL
            AND p_organization_id = app_current_organization()),
        false
    );
$$;
