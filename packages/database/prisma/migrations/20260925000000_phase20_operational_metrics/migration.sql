-- Phase 20 Checkpoint 3: operational aggregates for telemetry.
--
-- Checkpoint 20.1 classified "no metrics, no alert hooks" as a release
-- blocker. The metrics that answer it — queue depth, backlog age, the
-- terminal DEAD count, delivery and issuance state — have to be read from the
-- database, because the database is the authority: a counter in the worker
-- would reset on every restart and disagree between replicas.
--
-- Reading them from the request-path role directly does not work, and failing
-- quietly is the dangerous part:
--
--   * `webhook_deliveries` carries no SELECT grant for `palcert_app` at all,
--     so the query errors outright (which at least announces itself);
--   * `document_analyses`, `compliance_certificates`, `balance_topups` and
--     `api_clients` have row-level security FORCEd, so the same query outside
--     a tenant context returns *zero rows* and the gauge reports a confident,
--     wrong 0. A dashboard showing no backlog because it cannot see the
--     backlog is worse than no dashboard.
--
-- So the aggregates come from SECURITY DEFINER functions, the same mechanism
-- Phase 17 uses for system-authority reads (`app_webhook_deliveries_due`).
-- What this widens is deliberately narrow:
--
--   * counts and timestamps only — no row, no identifier, no payload, no
--     amount and no address ever leaves these functions;
--   * grouped by columns that are database enums or short closed sets, so a
--     caller cannot use them to enumerate anything;
--   * read-only, and granted EXECUTE rather than table SELECT, so the app
--     role's table privileges are exactly what they were.
--
-- The tenancy model is untouched. No caller can reach a row through these,
-- and nothing here relaxes a policy.

-- Counts, in one round trip instead of seven.
--
-- `metric` names the family, `a` and `b` are its grouping labels. A single
-- shape rather than seven functions because every one of these is "group by a
-- closed set and count", and a caller that has to remember seven signatures
-- is a caller that will eventually forget one.
CREATE OR REPLACE FUNCTION app_operational_counts()
RETURNS TABLE (metric text, a text, b text, n bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT 'jobs', j."job_type"::text, j."status"::text, count(*)
      FROM "processing_jobs" j GROUP BY 1, 2, 3
    UNION ALL
    SELECT 'job_expired_leases', NULL, NULL, count(*)
      FROM "processing_jobs"
     WHERE "status" IN ('DISPATCHED', 'RUNNING') AND "lease_expires_at" <= now()
    UNION ALL
    SELECT 'notification_deliveries', d."channel"::text, d."status"::text, count(*)
      FROM "notification_deliveries" d GROUP BY 1, 2, 3
    UNION ALL
    SELECT 'webhook_deliveries', w."status"::text, NULL, count(*)
      FROM "webhook_deliveries" w GROUP BY 1, 2, 3
    UNION ALL
    SELECT 'document_analyses', coalesce(x."analyzer_name", 'unknown'), x."status"::text, count(*)
      FROM "document_analyses" x GROUP BY 1, 2, 3
    UNION ALL
    SELECT 'certificates', c."issuance_status"::text, NULL, count(*)
      FROM "compliance_certificates" c GROUP BY 1, 2, 3
    UNION ALL
    SELECT 'balance_topups', t."status"::text, NULL, count(*)
      FROM "balance_topups" t GROUP BY 1, 2, 3
    UNION ALL
    SELECT 'api_clients', k."status"::text, NULL, count(*)
      FROM "api_clients" k GROUP BY 1, 2, 3;
$$;

-- Ages, which answer a different question from depth: a small queue that never
-- drains is worse than a large one that does.
CREATE OR REPLACE FUNCTION app_operational_ages()
RETURNS TABLE (metric text, a text, seconds double precision)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT 'jobs_queued', j."job_type"::text,
           EXTRACT(EPOCH FROM (now() - min(j."available_at")))::float8
      FROM "processing_jobs" j
     WHERE j."status" IN ('PENDING', 'RETRY_PENDING')
     GROUP BY 1, 2
    UNION ALL
    SELECT 'jobs_running', j."job_type"::text,
           EXTRACT(EPOCH FROM (now() - min(coalesce(j."started_at", j."dispatched_at"))))::float8
      FROM "processing_jobs" j
     WHERE j."status" IN ('DISPATCHED', 'RUNNING')
     GROUP BY 1, 2
    UNION ALL
    SELECT 'notifications_pending', d."channel"::text,
           EXTRACT(EPOCH FROM (now() - min(d."created_at")))::float8
      FROM "notification_deliveries" d
     WHERE d."status" IN ('PENDING', 'SENDING', 'FAILED_RETRYABLE')
     GROUP BY 1, 2
    UNION ALL
    SELECT 'webhooks_pending', NULL,
           EXTRACT(EPOCH FROM (now() - min(w."created_at")))::float8
      FROM "webhook_deliveries" w
     WHERE w."status" IN ('PENDING', 'SENDING', 'FAILED_RETRYABLE');
$$;

GRANT EXECUTE ON FUNCTION app_operational_counts() TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_operational_ages() TO "palcert_app";
