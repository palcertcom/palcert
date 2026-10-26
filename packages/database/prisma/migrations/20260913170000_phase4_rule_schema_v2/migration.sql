-- ===========================================================================
-- Phase 4 — Rule schema version 2: blocking semantics
--
-- Phase 3 required a blocking rule to be DETERMINISTIC. That was deliberately
-- conservative and turned out to be too restrictive for the real product: a
-- scientific journal may legitimately make blind-review anonymization, an
-- ethics declaration, a conflict-of-interest statement or a data-availability
-- statement a *blocking* requirement, and judging those needs a model or a
-- person.
--
-- Version 2 permits blocking in any evaluation mode. The safety property is
-- not dropped, it moves:
--
--   A rule may be blocking regardless of evaluation mode, but an unresolved
--   non-deterministic blocking rule prevents a final compliance decision
--   until it has been resolved.
--
-- The engine enforces that half by returning INDETERMINATE with
-- requiresReview for every AI-assisted and manual rule; it never fabricates a
-- verdict. Compliance aggregation (Phase 7) must refuse to finalise while such
-- a result is outstanding.
--
-- NOTHING PUBLISHED IS REWRITTEN. Existing rows keep rule_schema_version = 1
-- and keep v1 semantics, existing content hashes are untouched, and the
-- canonicalization algorithm is unchanged (so STANDARD_CANONICALIZATION_VERSION
-- stays 1). See ADR-0030.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The version-aware blocking constraint
--
--    Replaces the Phase 3 constraint rather than dropping the invariant. Every
--    existing row already satisfies the new form: they are all
--    rule_schema_version = 1, and they all satisfied the stricter v1 rule, so
--    the ALTER cannot fail on historical data.
-- ---------------------------------------------------------------------------
ALTER TABLE "standard_rules"
    DROP CONSTRAINT "standard_rules_blocking_requires_deterministic";

ALTER TABLE "standard_rules"
    ADD CONSTRAINT "standard_rules_blocking_requires_deterministic_v1"
    CHECK (
        "rule_schema_version" >= 2
        OR "blocking" = false
        OR "evaluation_mode" = 'DETERMINISTIC'
    );

-- ---------------------------------------------------------------------------
-- 2. Schema versions this release understands
--
--    A stored version outside the supported range would mean a rule written by
--    a future release, whose meaning this code has never seen. Refusing it in
--    the database as well as in the engine keeps "do not guess" true even if a
--    downgrade ever puts an older binary in front of a newer database.
-- ---------------------------------------------------------------------------
ALTER TABLE "standard_rules"
    ADD CONSTRAINT "standard_rules_schema_version_supported"
    CHECK ("rule_schema_version" BETWEEN 1 AND 2);

ALTER TABLE "standard_versions"
    ADD CONSTRAINT "standard_versions_schema_version_supported"
    CHECK ("rule_schema_version" BETWEEN 1 AND 2);

-- ---------------------------------------------------------------------------
-- 3. New content defaults to the current schema version
--
--    A column default only affects rows inserted from now on. Existing rows are
--    not touched, which is the point: a published v1 standard must still be a
--    v1 standard tomorrow, and its hash must still verify.
-- ---------------------------------------------------------------------------
ALTER TABLE "standard_rules" ALTER COLUMN "rule_schema_version" SET DEFAULT 2;
ALTER TABLE "standard_versions" ALTER COLUMN "rule_schema_version" SET DEFAULT 2;

-- ---------------------------------------------------------------------------
-- 4. A rule's schema version must match its version's
--
--    A draft is published as one document with one canonical snapshot, and the
--    snapshot records a single ruleSchemaVersion. A version whose rules
--    disagreed with it would hash something that did not describe its own
--    contents.
--
--    Enforced by trigger rather than by a foreign key because the check spans a
--    parent and a child column, which no constraint can express.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION standard_rules_schema_version_matches() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_version integer;
BEGIN
    SELECT "rule_schema_version" INTO v_version
    FROM "standard_versions"
    WHERE "id" = NEW."standard_version_id";

    -- No parent visible: the row-level security policies confine this read to
    -- the current tenant, and the composite foreign key already guarantees the
    -- parent exists in it. Nothing to check.
    IF v_version IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW."rule_schema_version" <> v_version THEN
        RAISE EXCEPTION
            'Rule schema version % does not match standard version %''s schema version %',
            NEW."rule_schema_version", NEW."standard_version_id", v_version
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "standard_rules_schema_version_matches"
    BEFORE INSERT OR UPDATE ON "standard_rules"
    FOR EACH ROW EXECUTE FUNCTION standard_rules_schema_version_matches();

GRANT EXECUTE ON FUNCTION standard_rules_schema_version_matches() TO palcert_app;

-- ---------------------------------------------------------------------------
-- 5. Documentation of the amendment, in the database itself
--
--    So an operator reading the schema finds the reasoning without having to
--    locate the ADR.
-- ---------------------------------------------------------------------------
COMMENT ON CONSTRAINT "standard_rules_blocking_requires_deterministic_v1" ON "standard_rules" IS
    'Rule schema v1 required blocking rules to be DETERMINISTIC. v2 permits any evaluation '
    'mode; the safety property moves to the engine, which returns INDETERMINATE with '
    'requiresReview for AI-assisted and manual rules so compliance cannot be finalised while '
    'one is unresolved. See ADR-0030.';

COMMENT ON COLUMN "standard_rules"."rule_schema_version" IS
    'The rule-schema version this rule was authored under. Never rewritten: a published v1 rule '
    'keeps v1 semantics and its standard keeps its original content hash.';
