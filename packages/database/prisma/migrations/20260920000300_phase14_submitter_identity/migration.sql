-- =============================================================================
-- Phase 14 — the one thing an institution learns about a person (§85, §87)
--
-- A reviewer has to know whose thesis this is. `users` is USER_SCOPED and
-- stays that way: widening its policies so organizations could read members'
-- rows is exactly the move ADR-0031 forbids, and it would expose far more than
-- a name — status, locale, MFA state, lockouts, password metadata.
--
-- So identity is disclosed the same way the public catalogue is (ADR-0046): a
-- narrow SECURITY DEFINER function with a fixed search_path, no dynamic SQL,
-- three columns, and a WHERE clause that *is* the authorization boundary. It
-- answers only for submissions whose recipient is the caller's own
-- organization, and only for revisions that really reached READY — a
-- submission still being prepared has not been handed to anybody, so there is
-- nobody for it to name (§36).
--
-- An organization id the caller has not been granted tenant context for
-- returns no rows, because `app_current_organization()` reads the verified
-- context rather than anything the request supplied.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_submission_submitters(p_submission_ids uuid[])
RETURNS TABLE (
    "submission_id" uuid,
    "user_id" uuid,
    "display_name" text,
    "email" text
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT s."id", u."id", u."display_name", u."email"
    FROM "official_submissions" s
    JOIN "users" u ON u."id" = s."owner_user_id"
    WHERE s."id" = ANY(p_submission_ids)
      AND app_current_organization() IS NOT NULL
      AND s."organization_id" = app_current_organization()
      AND EXISTS (
          SELECT 1 FROM "submission_revisions" r
          WHERE r."submission_id" = s."id" AND r."processing_status" = 'READY'
      );
$$;

GRANT EXECUTE ON FUNCTION app_submission_submitters(uuid[]) TO "palcert_app";

-- -----------------------------------------------------------------------------
-- Is this organization accepting official submissions? (§18)
--
-- The submitter needs to know before they submit, and they are very often not
-- a member: §17 is explicit that submitting requires no membership anywhere.
-- `organizations` is TENANT_SCOPED and its SELECT policy quite rightly shows a
-- row only to its own members, so the answer comes through a function that
-- discloses a single boolean — no name, no id, no row.
--
-- Fail-closed by construction: an organization that does not exist, is not
-- ACTIVE, or is not VERIFIED yields false, and a new official submission is
-- refused (§18).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_submission_organization_eligible(p_organization_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM "organizations" o
        WHERE o."id" = p_organization_id
          AND o."status" = 'ACTIVE'
          AND o."verification_status" = 'VERIFIED'
    );
$$;

GRANT EXECUTE ON FUNCTION app_submission_organization_eligible(uuid) TO "palcert_app";
