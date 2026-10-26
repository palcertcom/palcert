-- =============================================================================
-- Phase 17 (B2) — the database cutover point
--
-- From here on, a DomainEvent created without an explicit value is eligible to
-- become a webhook. Rows written before this migration keep `false`, because a
-- column default changes what *new* rows get and never rewrites old ones.
--
-- HONEST DEPLOYMENT SEMANTICS — read this before assuming an ordering.
--
-- `prisma migrate deploy` applies every pending migration in one run. Placing
-- this file last in the directory therefore proves that it runs after the
-- other Phase 17 migrations, and proves NOTHING about which application
-- version is running when it does. In a rolling deployment the database will
-- be at this point while some processes are still on Phase 16 code.
--
-- So this migration is treated as the database cutover point, option (B) of
-- the two the phase allows, and the consequence is stated plainly:
--
--   A Phase 16 process that creates a DomainEvent after this migration has
--   run will create it with `webhook_eligible = true` — the default — and
--   will NOT enqueue WEBHOOK_FANOUT, because its code has never heard of that
--   job type.
--
-- That gap is real and it is not closed by file ordering. It is closed by
-- `WebhookFanoutReconciler`, which scans eligible events lacking their durable
-- WEBHOOK_FANOUT job and creates exactly the missing job — idempotently,
-- through the existing ProcessingJob uniqueness, and without making any
-- network request itself. The reconciler is therefore mandatory, not an
-- optimization, and a deployment that disables it has a hole here.
--
-- A deployment that genuinely supports a two-stage rollout — schema through
-- (D), every process upgraded, then this migration — closes the gap ahead of
-- time. The reconciler stays correct either way; it simply finds nothing.
--
-- What does NOT change: historical Phase 16 rows. They were written with
-- `false` and stay `false` for ever, so no submission approved last year is
-- announced to an integration today. A replayed historical source returns its
-- existing row through the Phase 16 source identity index, and that row is
-- still `false`.
-- =============================================================================

ALTER TABLE "domain_events"
    ALTER COLUMN "webhook_eligible" SET DEFAULT true;

COMMENT ON COLUMN "domain_events"."webhook_eligible" IS
    'Whether this event may be projected outward as a webhook. False for every row written before the Phase 17 cutover, and for any replay of a historical source. New rows default to true; a Phase 16 process writing one is caught by WebhookFanoutReconciler.';
