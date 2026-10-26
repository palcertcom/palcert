-- Why did a manual top-up submission not reach a finance reviewer by email?
--
-- Read-only. Prints no secret: no password hash, no API key, no token, no
-- receipt — only account flags, role codes, statuses and skip reasons.
--
-- Local stack:
--   docker exec -i palcert-local-postgres-1 psql -U palcert -d palcert \
--     < scripts/diagnostics/manual-topup-notifications.sql
--
-- Each block answers one question in the order the pipeline asks it.

\pset footer off

\echo '1. Latest manual top-up submissions (the domain event exists?)'
SELECT e.id AS event_id, e.occurred_at, e.aggregate_id AS manual_topup_request_id
  FROM domain_events e
 WHERE e.event_type = 'MANUAL_TOPUP_SUBMITTED'
 ORDER BY e.occurred_at DESC
 LIMIT 5;

\echo '2. Was the fan-out job processed? (NOTIFICATION_FANOUT for those events)'
SELECT j.status, j.attempt_count, j.last_failure_code, j.created_at, j.updated_at
  FROM processing_jobs j
 WHERE j.job_type = 'NOTIFICATION_FANOUT'
   AND j.resource_id IN (SELECT id FROM domain_events WHERE event_type = 'MANUAL_TOPUP_SUBMITTED')
 ORDER BY j.created_at DESC
 LIMIT 5;

\echo '3. Who can receive it: GLOBAL holders of finance:manual-topup:review'
SELECT u.status, (u.email_verified_at IS NOT NULL) AS email_verified, r.code AS role,
       regexp_replace(u.email, '^(.).*(@.*)$', '\1***\2') AS email_masked
  FROM user_roles ur
  JOIN roles r ON r.id = ur.role_id
  JOIN role_permissions rp ON rp.role_id = r.id
  JOIN permissions p ON p.id = rp.permission_id AND p.code = 'finance:manual-topup:review'
  JOIN users u ON u.id = ur.user_id
 WHERE ur.scope = 'GLOBAL' AND ur.organization_id IS NULL;

\echo '4. In-app copies created for the latest submissions (none = no eligible reviewer at fan-out)'
SELECT n.created_at, regexp_replace(u.email, '^(.).*(@.*)$', '\1***\2') AS recipient
  FROM user_notifications n
  JOIN users u ON u.id = n.recipient_user_id
 WHERE n.notification_type = 'MANUAL_TOPUP_SUBMITTED'
 ORDER BY n.created_at DESC
 LIMIT 10;

\echo '5. Email deliveries for them, with status and skip reason'
SELECT d.status, d.skip_reason, d.provider, d.attempt_count, d.last_error_code, d.updated_at
  FROM notification_deliveries d
  JOIN user_notifications n ON n.id = d.notification_id
 WHERE n.notification_type = 'MANUAL_TOPUP_SUBMITTED'
   AND d.channel = 'EMAIL'
 ORDER BY d.updated_at DESC
 LIMIT 10;

\echo '6. Did the email job run? (NOTIFICATION_EMAIL_SEND)'
SELECT j.status, j.attempt_count, j.last_failure_code, j.updated_at
  FROM processing_jobs j
 WHERE j.job_type = 'NOTIFICATION_EMAIL_SEND'
 ORDER BY j.updated_at DESC
 LIMIT 5;

\echo '7. Recipients who switched this email off'
SELECT regexp_replace(u.email, '^(.).*(@.*)$', '\1***\2') AS user_email, np.email_enabled
  FROM notification_preferences np
  JOIN users u ON u.id = np.user_id
 WHERE np.notification_type = 'MANUAL_TOPUP_SUBMITTED';

\echo '8. Admin email settings (no key is printed)'
SELECT provider, enabled, workflow_email_enabled, (api_key_ciphertext IS NOT NULL) AS key_saved
  FROM platform_email_settings;

\echo '9. Provider-side records for those deliveries (Resend path only)'
SELECT ed.status, ed.skip_reason, ed.failure_code, ed.updated_at
  FROM email_deliveries ed
 WHERE ed.notification_delivery_id IN (
        SELECT d.id FROM notification_deliveries d
          JOIN user_notifications n ON n.id = d.notification_id
         WHERE n.notification_type = 'MANUAL_TOPUP_SUBMITTED')
 ORDER BY ed.updated_at DESC
 LIMIT 10;
