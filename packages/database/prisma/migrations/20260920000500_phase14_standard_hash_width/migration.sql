-- =============================================================================
-- Phase 14 — the standard's content hash is stored the way the standard stores
-- it (§28, §30, §137)
--
-- `standard_versions.content_hash` is a prefixed digest — `sha256:` followed by
-- 64 hex characters — and Phase 3 enforces exactly that shape. The submission
-- revision copied it into a CHAR(64), which cannot hold it.
--
-- The fix is the column, not the value. A submission copies identity verbatim
-- and never transforms it (§31): stripping the prefix here would mean the
-- evidence hash covered a digest string that appears nowhere else in PalCert,
-- and a reviewer comparing the submission against the published standard would
-- be comparing two different spellings of the same thing.
-- =============================================================================

ALTER TABLE "submission_revisions"
    ALTER COLUMN "standard_content_hash" TYPE TEXT;

ALTER TABLE "submission_revisions"
    ADD CONSTRAINT "submission_revisions_standard_content_hash_format"
    CHECK ("standard_content_hash" ~ '^sha256:[0-9a-f]{64}$');
