-- =============================================================================
-- Phase 14 — write authority on the submission domain
--
-- The first cut of these tables gave each one a single `FOR ALL` policy naming
-- both parties. That was right about *reading* and wrong about *writing*.
--
-- `DUAL_PARTY_SCOPED` means:
--
--     READ    submitter OR recipient organization
--     WRITE   depends on the exact table and the exact workflow action
--
-- It does not mean both parties may generically INSERT and UPDATE everything.
-- A single `FOR ALL` policy said they could, and left the real boundary
-- resting on the HTTP controller — which is not a boundary at all, because a
-- service that forgot to check would silently be allowed.
--
-- So the policies are split by command, and the two authorities are told apart
-- by *context* rather than by identity:
--
--   * `withUser`    sets only the user    -> acting as the submitter
--   * `withTenant`  sets the organization -> acting as the organization
--
-- That discriminator is what makes the rules well-defined even for a person
-- who happens to be both the author and a member of the receiving institution.
--
-- Two things RLS cannot express on its own, and how each is handled:
--
--   * **Which columns** an organization-originated UPDATE may touch. PostgreSQL
--     policies are row-level, and column GRANTs are per-role while both parties
--     share `palcert_app`. A trigger does it, restricting organization writes
--     to the institution-decision columns and nothing else.
--   * **The system's own first event.** The preparation worker legitimately
--     records `null -> SUBMITTED`, and it runs in the submitter's context. It
--     gets a narrow SECURITY DEFINER function rather than a policy letting the
--     submitter insert decision events generally — the difference between one
--     audited doorway and an open wall.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. A decision event says who caused it
-- ---------------------------------------------------------------------------

ALTER TABLE "submission_decision_events"
    ADD COLUMN "event_source" TEXT NOT NULL DEFAULT 'ORGANIZATION';

ALTER TABLE "submission_decision_events"
    ALTER COLUMN "event_source" DROP DEFAULT;

ALTER TABLE "submission_decision_events"
    ADD CONSTRAINT "submission_decision_events_event_source_check"
    CHECK ("event_source" IN ('SYSTEM', 'ORGANIZATION'));

-- A system event is only ever the first transition, and has no human actor.
-- An organization event is always a named person exercising the institution's
-- authority. Neither shape can be forged into the other.
ALTER TABLE "submission_decision_events"
    ADD CONSTRAINT "submission_decision_events_system_shape"
    CHECK ("event_source" <> 'SYSTEM' OR (
        "actor_user_id" IS NULL
        AND "from_status" IS NULL
        AND "to_status" = 'SUBMITTED'
        AND "reason_code" IS NULL
    ));

ALTER TABLE "submission_decision_events"
    ADD CONSTRAINT "submission_decision_events_organization_shape"
    CHECK ("event_source" <> 'ORGANIZATION' OR (
        "actor_user_id" IS NOT NULL
        AND "from_status" IS NOT NULL
        AND "to_status" <> 'SUBMITTED'
    ));

-- ---------------------------------------------------------------------------
-- 2. official_submissions
--
--   SELECT  submitter, recipient organization, audited platform admin
--   INSERT  submitter only  (an organization must never create a submission
--           on somebody's behalf — that would be an institution helping itself
--           to a document, which is the whole thing this phase prevents)
--   UPDATE  submitter and the workflow running in their scope
--   DELETE  nobody: the privilege is revoked, and there is no policy either
-- ---------------------------------------------------------------------------

DROP POLICY "official_submissions_dual_party" ON "official_submissions";

CREATE POLICY "official_submissions_read" ON "official_submissions" FOR SELECT
    USING (app_is_platform_admin()
        OR "owner_user_id" = app_current_user_id()
        OR "organization_id" = app_current_organization());

CREATE POLICY "official_submissions_insert" ON "official_submissions" FOR INSERT
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

CREATE POLICY "official_submissions_update" ON "official_submissions" FOR UPDATE
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

-- ---------------------------------------------------------------------------
-- 3. submission_revisions
--
--   SELECT  submitter, recipient organization, audited platform admin
--   INSERT  submitter only. An organization cannot manufacture a revision, and
--           therefore cannot manufacture a revisionNumber, a sourceCheckId, a
--           sourceReportId, a document version, a standard version, a snapshot
--           identity, a determination, a score or an evidence hash.
--   UPDATE  either party may be the writer, but which *columns* they may write
--           is decided by the trigger below — the organization gets the
--           institution-decision columns and nothing else.
--   DELETE  nobody.
-- ---------------------------------------------------------------------------

DROP POLICY "submission_revisions_dual_party" ON "submission_revisions";

CREATE POLICY "submission_revisions_read" ON "submission_revisions" FOR SELECT
    USING (app_is_platform_admin()
        OR "owner_user_id" = app_current_user_id()
        OR "organization_id" = app_current_organization());

CREATE POLICY "submission_revisions_insert" ON "submission_revisions" FOR INSERT
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

CREATE POLICY "submission_revisions_update" ON "submission_revisions" FOR UPDATE
    USING (app_is_platform_admin()
        OR "owner_user_id" = app_current_user_id()
        OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin()
        OR "owner_user_id" = app_current_user_id()
        OR "organization_id" = app_current_organization());

-- ---------------------------------------------------------------------------
-- 4. submission_decision_events
--
--   SELECT  submitter, recipient organization, audited platform admin
--   INSERT  the organization only, and only as the authenticated reviewer:
--           `actor_user_id` must equal the caller, so a service that passed an
--           actor from a request body could not put somebody else's name on a
--           decision. The system's own first event goes through the SECURITY
--           DEFINER function below instead.
--   UPDATE  nobody
--   DELETE  nobody
-- ---------------------------------------------------------------------------

DROP POLICY "submission_decision_events_dual_party" ON "submission_decision_events";

CREATE POLICY "submission_decision_events_read" ON "submission_decision_events" FOR SELECT
    USING (app_is_platform_admin()
        OR "owner_user_id" = app_current_user_id()
        OR "organization_id" = app_current_organization());

CREATE POLICY "submission_decision_events_insert" ON "submission_decision_events" FOR INSERT
    WITH CHECK (app_is_platform_admin()
        OR ("organization_id" = app_current_organization()
            AND "event_source" = 'ORGANIZATION'
            AND "actor_user_id" = app_current_user_id()));

-- ---------------------------------------------------------------------------
-- 5. submission_comments
--
--   SELECT  submitter, recipient organization, audited platform admin — the
--           submitter reads them because they are addressed to them (§67)
--   INSERT  the organization only, as the authenticated author. Phase 14 does
--           not model user replies, and the table being dual-party is not a
--           reason to quietly allow them (§68).
--   UPDATE  nobody
--   DELETE  nobody
-- ---------------------------------------------------------------------------

DROP POLICY "submission_comments_dual_party" ON "submission_comments";

CREATE POLICY "submission_comments_read" ON "submission_comments" FOR SELECT
    USING (app_is_platform_admin()
        OR "owner_user_id" = app_current_user_id()
        OR "organization_id" = app_current_organization());

CREATE POLICY "submission_comments_insert" ON "submission_comments" FOR INSERT
    WITH CHECK (app_is_platform_admin()
        OR ("organization_id" = app_current_organization()
            AND "author_side" = 'ORGANIZATION'
            AND "author_user_id" = app_current_user_id()));

-- ===========================================================================
-- 6. The system writer
--
-- Two of the writes Phase 14 needs belong to neither party. When the
-- preparation worker has copied the exact bytes and verified them, the
-- revision becomes READY and the case enters the institution's queue as
-- SUBMITTED (§33, §34). That first `null → SUBMITTED` transition is a
-- workflow event, not a human institution decision (§43) — so it must not be
-- reachable by letting the submitter insert arbitrary decision events, and it
-- must not be reachable by letting the submitter set a decision status.
--
-- It gets one narrow SECURITY DEFINER function instead. Being recognised as
-- the system writer requires two things at once:
--
--   * `current_user IS DISTINCT FROM session_user` — true only inside a
--     SECURITY DEFINER function owned by a privileged role. `palcert_app`
--     cannot reach this state on its own; it is not a member of any role it
--     could SET ROLE to.
--   * a transaction-local flag this function sets and clears.
--
-- The flag alone would be forgeable — `palcert_app` may call `set_config` on
-- any custom GUC. The role switch alone is the real boundary. Requiring both
-- means a forged flag buys nothing, and an unrelated definer function cannot
-- drift into this authority by accident.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app_is_submission_system_writer() RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT current_user IS DISTINCT FROM session_user
       AND COALESCE(current_setting('palcert.submission_system_write', true), 'off') = 'on';
$$;

-- The system's insert path for the one event it owns. Narrow on purpose: the
-- shape CHECK above already pins SYSTEM events to `null → SUBMITTED` with no
-- actor and no reason, so this policy cannot widen into decision authority.
CREATE POLICY "submission_decision_events_system_insert" ON "submission_decision_events" FOR INSERT
    WITH CHECK (app_is_submission_system_writer() AND "event_source" = 'SYSTEM');

-- ---------------------------------------------------------------------------
-- 7. Column authority
--
-- RLS decides which rows a caller may touch; it cannot decide which columns.
-- Both parties share one database role, so column GRANTs cannot separate them
-- either. The separation is therefore a trigger, and it keys off context
-- rather than identity: a caller with organization context is acting as the
-- institution even if that same human also owns the document.
--
--   organization context  → may change only the institution's own decision
--                           fields. Never the revision identity, the bound
--                           check/report/version, the snapshot, the
--                           determination, the score or the evidence hash
--                           (§2, §3, §40, §41).
--   submitter context     → may never set an institution decision (§4, §43).
--   system writer         → the finalisation below, and nothing else.
--
-- Written as a whole-row comparison with the permitted columns removed, so a
-- column added in a later phase is refused by default rather than silently
-- becoming organization-writable.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION submission_revisions_column_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    organization_context boolean;
BEGIN
    IF app_is_submission_system_writer() OR app_is_platform_admin() THEN
        RETURN NEW;
    END IF;

    organization_context := app_current_organization() IS NOT DISTINCT FROM OLD."organization_id"
        AND app_current_organization() IS NOT NULL;

    IF organization_context THEN
        IF (to_jsonb(NEW) - 'institution_decision_status' - 'review_started_at'
                          - 'decided_at' - 'updated_at')
           IS DISTINCT FROM
           (to_jsonb(OLD) - 'institution_decision_status' - 'review_started_at'
                          - 'decided_at' - 'updated_at')
        THEN
            RAISE EXCEPTION
                'submission_revision %: the receiving organization may change only its own decision',
                OLD."id";
        END IF;
        RETURN NEW;
    END IF;

    -- Anything else is the submitter's own context. The institution's decision
    -- is not theirs to write, in any direction.
    IF NEW."institution_decision_status" IS DISTINCT FROM OLD."institution_decision_status"
       OR NEW."review_started_at" IS DISTINCT FROM OLD."review_started_at"
       OR NEW."decided_at" IS DISTINCT FROM OLD."decided_at"
    THEN
        RAISE EXCEPTION
            'submission_revision %: the submitter cannot write an institution decision',
            OLD."id";
    END IF;

    RETURN NEW;
END;
$$;

-- Runs before the identity guard so the clearer message wins when a caller is
-- both in the wrong context and touching a write-once column.
CREATE TRIGGER "submission_revisions_column_authority_trigger"
    BEFORE UPDATE ON "submission_revisions"
    FOR EACH ROW EXECUTE FUNCTION submission_revisions_column_authority();

-- §2, §40: the case row carries no institution decision at all, so the
-- organization has nothing to write on it. Refuse the whole command rather
-- than rely on there being no column worth changing today.
CREATE OR REPLACE FUNCTION official_submissions_column_authority() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF app_is_submission_system_writer() OR app_is_platform_admin() THEN
        RETURN NEW;
    END IF;

    IF app_current_organization() IS NOT NULL
       AND app_current_organization() = OLD."organization_id"
    THEN
        RAISE EXCEPTION
            'official_submission %: the receiving organization cannot modify the case',
            OLD."id";
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "official_submissions_column_authority_trigger"
    BEFORE UPDATE ON "official_submissions"
    FOR EACH ROW EXECUTE FUNCTION official_submissions_column_authority();

-- ---------------------------------------------------------------------------
-- 8. Finalisation
--
-- One statement, because the database refuses the halfway state: a revision
-- is READY only when every snapshot identity, the evidence hash and the
-- SUBMITTED status are present together (`submission_revisions_ready_requires_snapshots`).
-- Splitting this across the worker's own updates would mean either relaxing
-- that constraint or letting the submitter write SUBMITTED. It does the whole
-- handoff instead, and is idempotent: a retried job that finds the revision
-- already READY returns false and changes nothing (§34).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_submission_finalize_revision(
    p_revision_id uuid,
    p_document_snapshot_key text,
    p_document_snapshot_version_id text,
    p_document_snapshot_sha256 text,
    p_document_snapshot_size_bytes integer,
    p_report_snapshot_key text,
    p_report_snapshot_version_id text,
    p_report_snapshot_sha256 text,
    p_report_snapshot_size_bytes integer,
    p_evidence_schema_version integer,
    p_evidence_canonicalization_version integer,
    p_evidence_hash text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    revision "submission_revisions"%ROWTYPE;
    finalized_at timestamptz := now();
BEGIN
    SELECT * INTO revision FROM "submission_revisions"
        WHERE "id" = p_revision_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'submission_revision % does not exist', p_revision_id;
    END IF;

    -- The caller must be the revision's own submitter. Without this the
    -- function would be a way for any authenticated user to drive somebody
    -- else's handoff, which is exactly the hole SECURITY DEFINER opens if the
    -- body forgets to close it.
    IF revision."owner_user_id" IS DISTINCT FROM app_current_user_id() THEN
        RAISE EXCEPTION 'submission_revision % is not the caller''s to finalize', p_revision_id;
    END IF;

    IF revision."processing_status" = 'READY' THEN
        RETURN false;
    END IF;

    IF revision."processing_status" <> 'PREPARING' THEN
        RAISE EXCEPTION 'submission_revision % is %, not PREPARING',
            p_revision_id, revision."processing_status";
    END IF;

    PERFORM set_config('palcert.submission_system_write', 'on', true);

    UPDATE "submission_revisions" SET
        "document_snapshot_key" = p_document_snapshot_key,
        "document_snapshot_version_id" = p_document_snapshot_version_id,
        "document_snapshot_sha256" = p_document_snapshot_sha256,
        "document_snapshot_size_bytes" = p_document_snapshot_size_bytes,
        "report_snapshot_key" = p_report_snapshot_key,
        "report_snapshot_version_id" = p_report_snapshot_version_id,
        "report_snapshot_sha256" = p_report_snapshot_sha256,
        "report_snapshot_size_bytes" = p_report_snapshot_size_bytes,
        "evidence_schema_version" = p_evidence_schema_version,
        "evidence_canonicalization_version" = p_evidence_canonicalization_version,
        "evidence_hash" = p_evidence_hash,
        "processing_status" = 'READY',
        "failure_code" = NULL,
        "failure_detail" = NULL,
        "institution_decision_status" = 'SUBMITTED',
        "submitted_at" = finalized_at,
        "updated_at" = finalized_at
    WHERE "id" = p_revision_id;

    INSERT INTO "submission_decision_events" (
        "id", "submission_revision_id", "owner_user_id", "organization_id",
        "event_source", "actor_user_id", "from_status", "to_status",
        "reason_code", "created_at"
    ) VALUES (
        gen_random_uuid(), revision."id",
        revision."owner_user_id", revision."organization_id",
        'SYSTEM', NULL, NULL, 'SUBMITTED', NULL, finalized_at
    );

    UPDATE "official_submissions" SET
        "current_revision_id" = revision."id",
        "updated_at" = finalized_at
    WHERE "id" = revision."submission_id";

    PERFORM set_config('palcert.submission_system_write', 'off', true);

    RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION app_is_submission_system_writer() TO "palcert_app";
GRANT EXECUTE ON FUNCTION submission_revisions_column_authority() TO "palcert_app";
GRANT EXECUTE ON FUNCTION official_submissions_column_authority() TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_submission_finalize_revision(
    uuid, text, text, text, integer, text, text, text, integer, integer, integer, text
) TO "palcert_app";
