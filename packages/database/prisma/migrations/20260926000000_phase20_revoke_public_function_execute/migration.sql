-- Take EXECUTE on PalCert's functions away from PUBLIC
-- (Phase 20 Checkpoint 7).
--
-- PostgreSQL grants EXECUTE on every new function to PUBLIC by default. For
-- ordinary functions that is harmless; for the sixty-four `app_*` functions it
-- is not, because those are SECURITY DEFINER — they run as the schema owner —
-- and many of them write: `app_certificate_issue`, `app_webhook_config_create`,
-- `app_notification_create`, `app_submission_finalize_revision`.
--
-- Concretely, this is how the backup role's contract was escapable. That role
-- is deliberately read-only: it holds no INSERT, UPDATE, DELETE or TRUNCATE
-- grant anywhere, and `verify-backup-role.mjs` asserts as much. But it could
-- connect, and PUBLIC could execute, so a leaked backup credential could have
-- called a definer function and written through it. A read-only role that can
-- issue a certificate is not read-only.
--
-- The remedy is the ordinary one: revoke the default, and grant explicitly to
-- the one role that is supposed to call these — the application. Nothing about
-- what the application may do changes; what changes is that everything else
-- must now be granted deliberately rather than by default.
--
-- `ALTER DEFAULT PRIVILEGES` carries the same rule forward, so a function
-- added by a later migration is not quietly public the day it lands.

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- The application role is created by the deployment, not by migrations, and a
-- development database may legitimately not have it yet. Granting only when it
-- exists keeps this migration applicable to both without pretending the role
-- is optional in production — configuration refuses a production deployment
-- whose request-path and admin connections are the same role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'palcert_app') THEN
    EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO palcert_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO palcert_app';
  END IF;
END
$$;
