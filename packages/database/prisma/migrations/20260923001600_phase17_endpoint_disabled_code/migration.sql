-- Phase 17 — one more failure code: an endpoint the organization disabled.
--
-- Verification against a DISABLED endpoint makes no network request at all, and
-- the operation that asked for it has to settle as something. None of the
-- existing codes says this: the receiver did not answer, nothing was superseded,
-- and no configuration disagreed with itself. The organization simply turned
-- the integration off, which is an answer of its own.
--
-- The vocabulary is a DOMAIN rather than an enum precisely so that adding a
-- code is one constraint swap instead of three.

ALTER DOMAIN "webhook_error_code" DROP CONSTRAINT "webhook_error_code_check";

ALTER DOMAIN "webhook_error_code" ADD CONSTRAINT "webhook_error_code_check"
    CHECK (VALUE IN (
        'DNS_TEMPORARY_FAILURE', 'CONNECT_TIMEOUT', 'CONNECTION_RESET',
        'TLS_INTERRUPTED', 'REQUEST_TIMEOUT',
        'HTTP_RETRYABLE', 'HTTP_PERMANENT', 'REDIRECT_REFUSED',
        'ENDPOINT_GONE', 'RESPONSE_TOO_LARGE',
        'DESTINATION_NOT_PUBLIC', 'DESTINATION_UNRESOLVABLE',
        'TLS_IDENTITY_INVALID', 'URL_POLICY_VIOLATION',
        'WEBHOOK_CONFIG_INTEGRITY_MISMATCH', 'CONFIG_SUPERSEDED',
        'ENCRYPTION_KEY_UNAVAILABLE', 'CHALLENGE_MISMATCH',
        'ENDPOINT_DISABLED',
        'WORKER_INTERRUPTED'
    ));
