-- =============================================================================
-- Standard versions — publishing a successor supersedes the version in force
--
-- Before this, publishing version 1.2 while 1.0 was in force was refused until
-- an administrator archived 1.0 by hand, and ARCHIVED then meant two different
-- things: "deliberately retired" and "replaced by a newer version". Now the
-- publish transaction moves the version in force to SUPERSEDED and records its
-- successor, and ARCHIVED keeps its one meaning.
--
--     DRAFT ──publish──> PUBLISHED ──publish a successor──> SUPERSEDED
--       │                    └──archive──> ARCHIVED
--       └──archive──> ARCHIVED
--
-- What this migration does NOT do:
--
--   * No existing row changes. There are no SUPERSEDED rows yet, and an
--     existing ARCHIVED version is not reinterpreted as superseded: it may have
--     been archived for a reason nobody recorded, and guessing would put a
--     false statement into history. Every id, hash, snapshot and reference is
--     left exactly as it is.
--   * The one-published-version index is unchanged. It is still the arbiter
--     of "at most one in force".
--   * A superseded version is never offered for a new check. The catalogue
--     functions keep selecting PUBLISHED only.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
ALTER TABLE "standard_versions"
    ADD COLUMN "superseded_at" TIMESTAMP(3),
    ADD COLUMN "superseded_by_version_id" UUID;

CREATE INDEX "standard_versions_superseded_by_version_id_idx"
    ON "standard_versions"("superseded_by_version_id");

-- The relation Prisma models. NO ACTION rather than RESTRICT so deleting a
-- whole organization, which cascades to both ends at once, is judged at the
-- end of the statement rather than refused half-way through.
ALTER TABLE "standard_versions"
    ADD CONSTRAINT "standard_versions_superseded_by_version_id_fkey"
    FOREIGN KEY ("superseded_by_version_id") REFERENCES "standard_versions"("id")
    ON DELETE NO ACTION ON UPDATE CASCADE;

-- A successor must come from the same tenant, as a clone source must.
ALTER TABLE "standard_versions"
    ADD CONSTRAINT "standard_versions_superseded_by_org_fkey"
    FOREIGN KEY ("superseded_by_version_id", "organization_id")
    REFERENCES "standard_versions" ("id", "organization_id")
    ON DELETE NO ACTION ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Invariants
-- ---------------------------------------------------------------------------

-- The publication fields, now with SUPERSEDED named explicitly: a superseded
-- version was published, so it always keeps its hash. Only ARCHIVED may have
-- none, because only a draft can be archived without ever being published.
ALTER TABLE "standard_versions" DROP CONSTRAINT "standard_versions_publication_fields";
ALTER TABLE "standard_versions"
    ADD CONSTRAINT "standard_versions_publication_fields"
    CHECK (
        CASE "status"
            WHEN 'DRAFT' THEN
                "content_hash" IS NULL AND "canonicalization_version" IS NULL
                AND "published_at" IS NULL
            WHEN 'PUBLISHED' THEN
                "content_hash" IS NOT NULL AND "canonicalization_version" IS NOT NULL
                AND "published_at" IS NOT NULL
            WHEN 'SUPERSEDED' THEN
                "content_hash" IS NOT NULL AND "canonicalization_version" IS NOT NULL
                AND "published_at" IS NOT NULL
            ELSE
                (
                    "content_hash" IS NOT NULL AND "canonicalization_version" IS NOT NULL
                    AND "published_at" IS NOT NULL
                )
                OR (
                    "content_hash" IS NULL AND "canonicalization_version" IS NULL
                    AND "published_at" IS NULL
                )
        END
    );

-- The supersession fields move together, exist exactly when the status is
-- SUPERSEDED, and never point at the row itself.
ALTER TABLE "standard_versions"
    ADD CONSTRAINT "standard_versions_supersession_fields"
    CHECK (
        ("status" = 'SUPERSEDED') = ("superseded_at" IS NOT NULL)
        AND ("superseded_at" IS NULL) = ("superseded_by_version_id" IS NULL)
        AND ("superseded_by_version_id" IS NULL OR "superseded_by_version_id" <> "id")
    );

-- ---------------------------------------------------------------------------
-- 3. Published immutability, extended to SUPERSEDED
--
--    The Phase 3 function, with two changes: PUBLISHED may now move to
--    SUPERSEDED (recording only the supersession itself), and SUPERSEDED is as
--    frozen as ARCHIVED. Every field that defines what the standard says is
--    still compared explicitly.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION standard_versions_freeze() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_successor_standard uuid;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."status" <> 'DRAFT' THEN
            RAISE EXCEPTION
                'standard_version % is % and cannot be deleted; archive it instead',
                OLD."id", OLD."status"
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN OLD;
    END IF;

    -- A draft is freely editable, but it cannot skip publication: the only
    -- way to become SUPERSEDED is to have been in force.
    IF OLD."status" = 'DRAFT' THEN
        IF NEW."status" = 'SUPERSEDED' THEN
            RAISE EXCEPTION
                'standard_version % is a draft; only a published version can be superseded',
                OLD."id"
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD."status" = 'ARCHIVED' THEN
        RAISE EXCEPTION 'standard_version % is archived and cannot be modified', OLD."id"
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD."status" = 'SUPERSEDED' THEN
        RAISE EXCEPTION
            'standard_version % is superseded and cannot be modified; clone it instead',
            OLD."id"
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- OLD.status = 'PUBLISHED'. It may be archived, or superseded by a
    -- successor, and nothing that defines what the standard says may move.
    IF NEW."status" NOT IN ('PUBLISHED', 'ARCHIVED', 'SUPERSEDED') THEN
        RAISE EXCEPTION
            'standard_version % is published; it cannot return to %',
            OLD."id", NEW."status"
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW."content_hash" IS DISTINCT FROM OLD."content_hash"
        OR NEW."canonicalization_version" IS DISTINCT FROM OLD."canonicalization_version"
        OR NEW."rule_schema_version" IS DISTINCT FROM OLD."rule_schema_version"
        OR NEW."version_label" IS DISTINCT FROM OLD."version_label"
        OR NEW."standard_id" IS DISTINCT FROM OLD."standard_id"
        OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
        OR NEW."effective_from" IS DISTINCT FROM OLD."effective_from"
        OR NEW."effective_until" IS DISTINCT FROM OLD."effective_until"
        OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
        OR NEW."published_by_user_id" IS DISTINCT FROM OLD."published_by_user_id"
        OR NEW."cloned_from_version_id" IS DISTINCT FROM OLD."cloned_from_version_id"
    THEN
        RAISE EXCEPTION
            'standard_version % is published; only archiving or superseding may change it',
            OLD."id"
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW."status" = 'SUPERSEDED' THEN
        -- Superseding is not retiring: the archive timestamp stays untouched.
        IF NEW."archived_at" IS DISTINCT FROM OLD."archived_at" THEN
            RAISE EXCEPTION
                'standard_version % is being superseded; archived_at must not change', OLD."id"
                USING ERRCODE = 'restrict_violation';
        END IF;

        -- The successor is another version of the same standard. The foreign
        -- keys already pin it to this tenant; this pins it to this standard.
        SELECT "standard_id" INTO v_successor_standard
        FROM "standard_versions" WHERE "id" = NEW."superseded_by_version_id";
        IF v_successor_standard IS DISTINCT FROM OLD."standard_id" THEN
            RAISE EXCEPTION
                'standard_version % can only be superseded by a version of the same standard',
                OLD."id"
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- A version is superseded only because its successor was published, in the
-- same transaction. Checked at commit, when the successor must be the one in
-- force: a supersession whose publish did not complete cannot be committed, so
-- a standard is never left with no version in force by a partial publish.
CREATE OR REPLACE FUNCTION standard_versions_supersession_requires_successor()
RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    v_successor_status text;
BEGIN
    IF NEW."status" <> 'SUPERSEDED' OR OLD."status" = 'SUPERSEDED' THEN
        RETURN NULL;
    END IF;

    SELECT "status"::text INTO v_successor_status
    FROM "standard_versions" WHERE "id" = NEW."superseded_by_version_id";

    IF v_successor_status IS DISTINCT FROM 'PUBLISHED' THEN
        RAISE EXCEPTION
            'standard_version % was superseded, but its successor % is %, not PUBLISHED',
            NEW."id", NEW."superseded_by_version_id", COALESCE(v_successor_status, 'missing')
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "standard_versions_supersession_requires_successor"
    AFTER UPDATE ON "standard_versions"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (NEW."status" = 'SUPERSEDED' AND OLD."status" <> 'SUPERSEDED')
    EXECUTE FUNCTION standard_versions_supersession_requires_successor();

-- ---------------------------------------------------------------------------
-- 4. Checks and reports keep resolving to the version they captured
--
--    These two read paths accepted PUBLISHED or ARCHIVED. Without SUPERSEDED,
--    publishing 1.2 would have made every check, report and certificate bound
--    to 1.0 unreadable — the opposite of what superseding means. Bodies are
--    otherwise identical to Phase 7; CREATE OR REPLACE keeps ownership and the
--    EXECUTE grants.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_check_standard_snapshot(p_standard_version_id uuid)
RETURNS TABLE (
    "standard_version_id" uuid,
    "canonical" jsonb,
    "content_hash" text,
    "canonicalization_version" integer,
    "rule_schema_version" integer,
    "rule_count" integer
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT snap."standard_version_id",
           snap."canonical",
           snap."content_hash",
           snap."canonicalization_version",
           snap."rule_schema_version",
           snap."rule_count"
    FROM "standard_version_snapshots" snap
    JOIN "standard_versions" sv ON sv."id" = snap."standard_version_id"
    WHERE snap."standard_version_id" = p_standard_version_id
      -- A draft has no snapshot worth evaluating; only a version that reached
      -- PUBLISHED (and may since have been superseded or archived) does.
      AND sv."status" IN ('PUBLISHED', 'SUPERSEDED', 'ARCHIVED');
$$;

CREATE OR REPLACE FUNCTION app_check_standard_identity(p_standard_version_id uuid)
RETURNS TABLE (
    "organization_id" uuid,
    "organization_name" text,
    "organization_verification" text,
    "document_type_id" uuid,
    "document_type_name" text,
    "standard_id" uuid,
    "standard_code" text,
    "standard_name_en" text,
    "standard_name_ar" text,
    "standard_version_id" uuid,
    "version_label" text,
    "content_hash" text,
    "canonicalization_version" integer,
    "rule_schema_version" integer
)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT o."id",
           o."display_name",
           o."verification_status"::text,
           dt."id",
           dt."name",
           st."id",
           st."code",
           st."name_en",
           st."name_ar",
           sv."id",
           sv."version_label",
           snap."content_hash",
           snap."canonicalization_version",
           snap."rule_schema_version"
    FROM "standard_versions" sv
    JOIN "standards" st ON st."id" = sv."standard_id"
    JOIN "organizations" o ON o."id" = st."organization_id"
    JOIN "document_types" dt ON dt."id" = st."document_type_id"
    JOIN "standard_version_snapshots" snap ON snap."standard_version_id" = sv."id"
    WHERE sv."id" = p_standard_version_id
      AND sv."status" IN ('PUBLISHED', 'SUPERSEDED', 'ARCHIVED');
$$;
