-- =============================================================================
-- Phase 17 — organization integrations and secure outbound webhooks
--
--     A webhook is an external projection of an authoritative DomainEvent.
--     It never becomes the authoritative record itself.
--
-- Nothing created here may be consulted to decide whether a submission was
-- approved or whether a certificate is valid. Phase 14 and Phase 15 keep that
-- authority, Phase 16's `domain_events` remains the only business-event
-- source, and `processing_jobs` remains the one dispatch and retry mechanism.
--
-- Two things are true of every row below and are worth stating once:
--
--   - No customer-controlled URL and no signing secret is stored in plaintext.
--     Both are sealed with the Phase 17 keyring, which records the key id per
--     row so a key can be rotated without a flag day.
--
--   - No text a remote endpoint produced is stored anywhere. Not a response
--     body, not a response header, not an error message. These rows are read
--     by support staff, and a third party's error page routinely echoes the
--     request back into its own text.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Vocabularies
--
-- Native enums, so an unknown value is refused even where the application was
-- bypassed. The event type deliberately uses the *public* dotted names: these
-- rows are what gets sent, and keeping the internal name here would mean a
-- translation step that could drift.
-- -----------------------------------------------------------------------------
CREATE TYPE "WebhookEndpointStatus" AS ENUM (
    'PENDING_VERIFICATION', 'ACTIVE', 'PAUSED', 'DISABLED'
);

CREATE TYPE "WebhookConfigStatus" AS ENUM (
    'PENDING', 'VERIFIED', 'RETIRED', 'SUPERSEDED'
);

CREATE TYPE "WebhookEventType" AS ENUM (
    'submission.ready',
    'submission.revision_ready',
    'submission.under_review',
    'submission.approved',
    'submission.rejected',
    'submission.revision_requested',
    'submission.comment_added',
    'certificate.issued',
    'certificate.revoked'
);

CREATE TYPE "WebhookDeliveryKind" AS ENUM ('ORIGINAL', 'REPLAY', 'TEST');

CREATE TYPE "WebhookDeliveryStatus" AS ENUM (
    'PENDING', 'SENDING', 'DELIVERED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT', 'SKIPPED'
);

CREATE TYPE "WebhookSkipReason" AS ENUM ('ENDPOINT_INACTIVE', 'UNSUBSCRIBED');

CREATE TYPE "WebhookAttemptOutcome" AS ENUM (
    'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT'
);

CREATE TYPE "WebhookManagementOperationType" AS ENUM (
    'CREATE_ENDPOINT', 'UPDATE_URL', 'VERIFY_CONFIG',
    'TEST_ENDPOINT', 'ROTATE_SECRET', 'REPLAY_DELIVERY'
);

-- The normalized failure vocabulary. A domain rather than an enum because it
-- appears in three tables and because adding a code must not require rewriting
-- three CHECK constraints in lockstep.
CREATE DOMAIN "webhook_error_code" AS TEXT
    CHECK (VALUE IN (
        'DNS_TEMPORARY_FAILURE', 'CONNECT_TIMEOUT', 'CONNECTION_RESET',
        'TLS_INTERRUPTED', 'REQUEST_TIMEOUT',
        'HTTP_RETRYABLE', 'HTTP_PERMANENT', 'REDIRECT_REFUSED',
        'ENDPOINT_GONE', 'RESPONSE_TOO_LARGE',
        'DESTINATION_NOT_PUBLIC', 'DESTINATION_UNRESOLVABLE',
        'TLS_IDENTITY_INVALID', 'URL_POLICY_VIOLATION',
        'WEBHOOK_CONFIG_INTEGRITY_MISMATCH', 'CONFIG_SUPERSEDED',
        'ENCRYPTION_KEY_UNAVAILABLE', 'CHALLENGE_MISMATCH',
        'WORKER_INTERRUPTED'
    ));

-- -----------------------------------------------------------------------------
-- 2. The endpoint
--
-- The logical integration. Its URL and secret are *not* here: those live in
-- immutable configuration versions, and the endpoint points at the current one
-- and at whichever one is waiting to be verified.
--
-- `slot` is how the ten-endpoint limit becomes a database invariant rather than
-- a check a service performs. Two concurrent creates at the boundary both read
-- "nine endpoints" and both pass an application check; here they collide on a
-- unique index and one of them loses. A disabled endpoint releases its slot,
-- because it is no longer an integration — it is a tombstone.
-- -----------------------------------------------------------------------------
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,

    "description" TEXT NOT NULL,
    "status" "WebhookEndpointStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',

    "current_config_version_id" UUID,
    "pending_config_version_id" UUID,

    "slot" SMALLINT,

    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "disabled_at" TIMESTAMPTZ(6),

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "webhook_endpoints_description_bounded"
        CHECK (length("description") BETWEEN 1 AND 200),

    -- Ten live integrations per organization, held by the schema.
    CONSTRAINT "webhook_endpoints_slot_shape" CHECK (
        ("status" = 'DISABLED' AND "slot" IS NULL)
        OR ("status" <> 'DISABLED' AND "slot" BETWEEN 1 AND 10)
    ),

    -- A configuration cannot be both live and waiting. Without this an
    -- activation that forgot to clear the pointer would leave an endpoint
    -- whose pending config is its current one, and a later verification would
    -- "activate" what is already active.
    CONSTRAINT "webhook_endpoints_current_is_not_pending" CHECK (
        "current_config_version_id" IS NULL
        OR "current_config_version_id" IS DISTINCT FROM "pending_config_version_id"
    ),

    -- An endpoint is ACTIVE because a configuration proved reachable. It
    -- cannot be ACTIVE or PAUSED with nothing to send to.
    CONSTRAINT "webhook_endpoints_active_has_config" CHECK (
        "status" NOT IN ('ACTIVE', 'PAUSED') OR "current_config_version_id" IS NOT NULL
    ),
    CONSTRAINT "webhook_endpoints_disabled_shape" CHECK (
        ("status" = 'DISABLED') = ("disabled_at" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "webhook_endpoints_slot_key"
    ON "webhook_endpoints"("organization_id", "slot");

CREATE INDEX "webhook_endpoints_organization_idx"
    ON "webhook_endpoints"("organization_id", "created_at", "id");

ALTER TABLE "webhook_endpoints"
    ADD CONSTRAINT "webhook_endpoints_organization_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
ALTER TABLE "webhook_endpoints"
    ADD CONSTRAINT "webhook_endpoints_created_by_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;

-- Supports the composite references Phase 17 (D) adds, so a child row can
-- never name an endpoint belonging to another organization.
CREATE UNIQUE INDEX "webhook_endpoints_id_organization_key"
    ON "webhook_endpoints"("id", "organization_id");

-- -----------------------------------------------------------------------------
-- 3. The configuration version
--
-- Immutable, and the unit everything else binds to. A delivery created under
-- one configuration keeps using that configuration's URL and secret even after
-- a rotation, which is why the receiver must keep the previous secret working
-- until those deliveries settle.
--
-- The plaintext URL is never stored. What *is* stored beside the ciphertext is
-- its SHA-256, host and port — recomputed from the decrypted URL before every
-- network attempt and compared. That turns "somebody edited a ciphertext" from
-- an undetectable redirection into a permanent, zero-network failure.
-- -----------------------------------------------------------------------------
CREATE TABLE "webhook_endpoint_config_versions" (
    "id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "status" "WebhookConfigStatus" NOT NULL DEFAULT 'PENDING',

    "url_ciphertext" TEXT NOT NULL,
    "url_iv" TEXT NOT NULL,
    "url_auth_tag" TEXT NOT NULL,
    "url_encryption_key_id" TEXT NOT NULL,

    -- Recomputed and compared before every attempt (§16). Immutable metadata.
    "url_sha256" CHAR(64) NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,

    "secret_ciphertext" TEXT NOT NULL,
    "secret_iv" TEXT NOT NULL,
    "secret_auth_tag" TEXT NOT NULL,
    "secret_encryption_key_id" TEXT NOT NULL,
    -- A truncated HMAC of the secret under a fixed label: enough to prove the
    -- decrypted secret is the one this row was created with, and not enough to
    -- help anybody who reads the row guess it.
    "secret_fingerprint" CHAR(64) NOT NULL,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_at" TIMESTAMPTZ(6),
    "retired_at" TIMESTAMPTZ(6),
    "last_verification_error" "webhook_error_code",
    "last_verification_at" TIMESTAMPTZ(6),

    CONSTRAINT "webhook_endpoint_config_versions_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "webhook_config_versions_number_positive" CHECK ("version_number" >= 1),
    CONSTRAINT "webhook_config_versions_url_sha_lower"
        CHECK ("url_sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "webhook_config_versions_fingerprint_lower"
        CHECK ("secret_fingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "webhook_config_versions_port_range"
        CHECK ("port" BETWEEN 1 AND 65535),
    -- The host is a name. An IP literal here would mean the URL policy was
    -- bypassed, and the row is refused rather than trusted.
    --
    -- The second condition is the one that does that work: a dotted quad
    -- matches every "looks like a hostname" pattern there is, because its
    -- labels are ordinary labels that happen to be digits. What no hostname
    -- has is a final label starting with a digit, so that is what is required.
    CONSTRAINT "webhook_config_versions_host_is_a_name" CHECK (
        "host" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
        AND "host" ~ '\.[a-z][a-z0-9-]*$'
        AND length("host") BETWEEN 4 AND 253
    ),
    CONSTRAINT "webhook_config_versions_verified_shape"
        CHECK (("status" IN ('VERIFIED', 'RETIRED')) = ("verified_at" IS NOT NULL)),
    CONSTRAINT "webhook_config_versions_retired_shape"
        CHECK (("status" = 'RETIRED') = ("retired_at" IS NOT NULL))
);

CREATE UNIQUE INDEX "webhook_config_versions_identity"
    ON "webhook_endpoint_config_versions"("endpoint_id", "version_number");

-- At most one configuration waiting per endpoint (§11). Saving a new URL
-- supersedes the previous pending one atomically; this index is what makes
-- "atomically" true under concurrency rather than aspirational.
CREATE UNIQUE INDEX "webhook_config_versions_one_pending"
    ON "webhook_endpoint_config_versions"("endpoint_id") WHERE "status" = 'PENDING';

CREATE INDEX "webhook_config_versions_key_idx"
    ON "webhook_endpoint_config_versions"("url_encryption_key_id");
CREATE INDEX "webhook_config_versions_secret_key_idx"
    ON "webhook_endpoint_config_versions"("secret_encryption_key_id");

ALTER TABLE "webhook_endpoint_config_versions"
    ADD CONSTRAINT "webhook_config_versions_endpoint_fkey"
    FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE RESTRICT;

-- Supports the endpoint's two config pointers being checked against the
-- *same* endpoint, so an endpoint can never point at another's configuration.
CREATE UNIQUE INDEX "webhook_config_versions_id_endpoint_key"
    ON "webhook_endpoint_config_versions"("id", "endpoint_id");

-- -----------------------------------------------------------------------------
-- 4. Subscriptions
--
-- Normalized rows over a closed enum. No wildcard, and a missing row means not
-- subscribed — so a new event type added in a later phase reaches nobody until
-- somebody asks for it, rather than starting to flow to every existing
-- integration on the day it ships.
-- -----------------------------------------------------------------------------
CREATE TABLE "webhook_subscriptions" (
    "id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "event_type" "WebhookEventType" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webhook_subscriptions_identity"
    ON "webhook_subscriptions"("endpoint_id", "event_type");

CREATE INDEX "webhook_subscriptions_event_idx"
    ON "webhook_subscriptions"("event_type", "organization_id");

-- -----------------------------------------------------------------------------
-- 5. The external projection of an event
--
-- One DomainEvent produces at most one WebhookEvent, for ever, enforced by a
-- unique index rather than by a worker remembering. The canonical body is
-- hashed here and verified before every attempt, so an automatic retry sends
-- the same bytes and a receiver's signature check cannot fail for a reason
-- nobody can reproduce.
-- -----------------------------------------------------------------------------
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "domain_event_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,

    "event_type" "WebhookEventType" NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    -- Identifiers and decision status only, and asserted so by a sentinel test.
    "data" JSONB NOT NULL,
    "body_sha256" CHAR(64) NOT NULL,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_events_data_is_object" CHECK (jsonb_typeof("data") = 'object'),
    CONSTRAINT "webhook_events_schema_version_positive" CHECK ("schema_version" >= 1),
    CONSTRAINT "webhook_events_body_sha_lower" CHECK ("body_sha256" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "webhook_events_domain_event_key"
    ON "webhook_events"("domain_event_id");

CREATE INDEX "webhook_events_organization_idx"
    ON "webhook_events"("organization_id", "created_at", "id");

-- Supports the delivery's composite reference to its event and tenancy.
CREATE UNIQUE INDEX "webhook_events_id_organization_key"
    ON "webhook_events"("id", "organization_id");

-- -----------------------------------------------------------------------------
-- 6. Delivery
--
-- One row per (event, endpoint) for an original; a replay is a *new* row that
-- names the one it replays. TEST deliveries carry no event at all, which is
-- why `webhook_event_id` is nullable and why the shape constraints below spell
-- out what each kind may carry.
-- -----------------------------------------------------------------------------
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "webhook_event_id" UUID,
    "endpoint_id" UUID NOT NULL,
    "endpoint_config_version_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,

    "kind" "WebhookDeliveryKind" NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "skip_reason" "WebhookSkipReason",

    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "last_error_code" "webhook_error_code",
    "last_http_status" INTEGER,

    "replay_of_delivery_id" UUID,

    -- TEST only: the immutable timestamp its body is built from, so every
    -- retry reproduces the same bytes rather than re-reading the clock.
    "control_occurred_at" TIMESTAMPTZ(6),
    "body_sha256" CHAR(64),

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "delivered_at" TIMESTAMPTZ(6),

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id"),

    -- A business delivery projects an event; a test does not, and must carry
    -- its own body identity instead.
    CONSTRAINT "webhook_deliveries_kind_shape" CHECK (
        ("kind" IN ('ORIGINAL', 'REPLAY')
            AND "webhook_event_id" IS NOT NULL
            AND "control_occurred_at" IS NULL AND "body_sha256" IS NULL)
        OR ("kind" = 'TEST'
            AND "webhook_event_id" IS NULL
            AND "control_occurred_at" IS NOT NULL AND "body_sha256" IS NOT NULL)
    ),
    CONSTRAINT "webhook_deliveries_replay_shape" CHECK (
        ("kind" = 'REPLAY') = ("replay_of_delivery_id" IS NOT NULL)
    ),
    CONSTRAINT "webhook_deliveries_skip_shape" CHECK (
        ("status" = 'SKIPPED' AND "skip_reason" IS NOT NULL)
        OR ("status" <> 'SKIPPED' AND "skip_reason" IS NULL)
    ),
    CONSTRAINT "webhook_deliveries_delivered_shape"
        CHECK ("status" <> 'DELIVERED' OR "delivered_at" IS NOT NULL),
    CONSTRAINT "webhook_deliveries_failure_shape" CHECK (
        "status" NOT IN ('FAILED_RETRYABLE', 'FAILED_PERMANENT')
        OR "last_error_code" IS NOT NULL
    ),
    CONSTRAINT "webhook_deliveries_retry_shape"
        CHECK ("next_attempt_at" IS NULL OR "status" IN ('PENDING', 'FAILED_RETRYABLE')),
    CONSTRAINT "webhook_deliveries_attempts_sane" CHECK ("attempt_count" >= 0),
    CONSTRAINT "webhook_deliveries_http_status_range"
        CHECK ("last_http_status" IS NULL OR "last_http_status" BETWEEN 100 AND 599),
    CONSTRAINT "webhook_deliveries_body_sha_lower"
        CHECK ("body_sha256" IS NULL OR "body_sha256" ~ '^[0-9a-f]{64}$')
);

-- At most one ORIGINAL per (event, endpoint) (§32). A replay does not weaken
-- this: replays are excluded from the index, so no number of them can produce
-- a second original.
CREATE UNIQUE INDEX "webhook_deliveries_original_identity"
    ON "webhook_deliveries"("webhook_event_id", "endpoint_id") WHERE "kind" = 'ORIGINAL';

CREATE INDEX "webhook_deliveries_due_idx"
    ON "webhook_deliveries"("status", "next_attempt_at");
CREATE INDEX "webhook_deliveries_endpoint_idx"
    ON "webhook_deliveries"("endpoint_id", "created_at", "id");
-- The unsettled count a rotation exposes, without decrypting anything (§39).
CREATE INDEX "webhook_deliveries_config_unsettled_idx"
    ON "webhook_deliveries"("endpoint_config_version_id")
    WHERE "status" IN ('PENDING', 'SENDING', 'FAILED_RETRYABLE');

-- Supports the management operation's reference to a delivery of the same
-- organization, so a replay request cannot name somebody else's delivery.
CREATE UNIQUE INDEX "webhook_deliveries_id_organization_key"
    ON "webhook_deliveries"("id", "organization_id");

-- Supports the replay's composite reference: a replay must name a delivery of
-- the same endpoint, the same organization and the same event.
CREATE UNIQUE INDEX "webhook_deliveries_replay_source_key"
    ON "webhook_deliveries"("id", "endpoint_id", "organization_id", "webhook_event_id");

-- -----------------------------------------------------------------------------
-- 7. Attempts
--
-- Append-only, except that one open attempt may be closed. That exception is
-- what lets a crashed worker's attempt be settled as WORKER_INTERRUPTED rather
-- than staying open for ever — the failure mode Phase 16 shipped a fix for.
-- -----------------------------------------------------------------------------
CREATE TABLE "webhook_delivery_attempts" (
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,

    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "outcome" "WebhookAttemptOutcome",
    "error_code" "webhook_error_code",
    "http_status" INTEGER,
    "duration_ms" INTEGER,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_delivery_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_delivery_attempts_finished_shape" CHECK (
        ("outcome" IS NULL AND "finished_at" IS NULL)
        OR ("outcome" IS NOT NULL AND "finished_at" IS NOT NULL)
    ),
    CONSTRAINT "webhook_delivery_attempts_failure_shape" CHECK (
        "outcome" IS NULL OR "outcome" = 'SUCCEEDED' OR "error_code" IS NOT NULL
    ),
    CONSTRAINT "webhook_delivery_attempts_number_positive" CHECK ("attempt_number" >= 1),
    CONSTRAINT "webhook_delivery_attempts_http_status_range"
        CHECK ("http_status" IS NULL OR "http_status" BETWEEN 100 AND 599),
    CONSTRAINT "webhook_delivery_attempts_duration_sane"
        CHECK ("duration_ms" IS NULL OR "duration_ms" >= 0)
);

CREATE UNIQUE INDEX "webhook_delivery_attempts_identity"
    ON "webhook_delivery_attempts"("delivery_id", "attempt_number");

ALTER TABLE "webhook_delivery_attempts"
    ADD CONSTRAINT "webhook_delivery_attempts_delivery_fkey"
    FOREIGN KEY ("delivery_id") REFERENCES "webhook_deliveries"("id") ON DELETE RESTRICT;

-- -----------------------------------------------------------------------------
-- 8. Verification attempts
--
-- Every real network verification gets a row. What it may hold is deliberately
-- tiny: no challenge, no signature, no URL, no body, no response. The
-- challenge in particular is generated inside one attempt, compared against
-- the immediate response and then forgotten — a persisted challenge is a
-- persisted answer key.
-- -----------------------------------------------------------------------------
CREATE TABLE "webhook_verification_attempts" (
    "id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "config_version_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,

    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "outcome" "WebhookAttemptOutcome",
    "error_code" "webhook_error_code",
    "http_status" INTEGER,
    "duration_ms" INTEGER,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_verification_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_verification_attempts_finished_shape" CHECK (
        ("outcome" IS NULL AND "finished_at" IS NULL)
        OR ("outcome" IS NOT NULL AND "finished_at" IS NOT NULL)
    ),
    CONSTRAINT "webhook_verification_attempts_failure_shape" CHECK (
        "outcome" IS NULL OR "outcome" = 'SUCCEEDED' OR "error_code" IS NOT NULL
    ),
    CONSTRAINT "webhook_verification_attempts_number_positive"
        CHECK ("attempt_number" >= 1),
    CONSTRAINT "webhook_verification_attempts_http_status_range"
        CHECK ("http_status" IS NULL OR "http_status" BETWEEN 100 AND 599),
    CONSTRAINT "webhook_verification_attempts_duration_sane"
        CHECK ("duration_ms" IS NULL OR "duration_ms" >= 0)
);

CREATE UNIQUE INDEX "webhook_verification_attempts_identity"
    ON "webhook_verification_attempts"("operation_id", "attempt_number");

CREATE INDEX "webhook_verification_attempts_config_idx"
    ON "webhook_verification_attempts"("config_version_id", "started_at");

-- -----------------------------------------------------------------------------
-- 9. Management operations
--
-- The durable identity of an HTTP mutation, and the reason an idempotency key
-- means something across a lost response.
--
-- The raw key is never stored — only its hash — because an idempotency key
-- travels in a header and would otherwise be a client-supplied string sitting
-- in a database beside the resources it can re-address.
--
-- Two operations carry a secret in their response, and only those two hold
-- encrypted reveal material. It is held for a bounded window and is *not*
-- erased when the response is written: an HTTP write is not a client receipt,
-- and a client that never saw the body has to be able to ask again.
-- -----------------------------------------------------------------------------
CREATE TABLE "webhook_management_operations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "operation" "WebhookManagementOperationType" NOT NULL,

    -- SHA-256 of the Idempotency-Key. Never the key itself.
    "idempotency_key_hash" CHAR(64) NOT NULL,
    -- SHA-256 of the canonical request, so the same key with a different body
    -- is refused instead of returning somebody else's result.
    "request_fingerprint" CHAR(64) NOT NULL,
    "actor_user_id" UUID NOT NULL,

    "endpoint_id" UUID,
    "config_version_id" UUID,
    "delivery_id" UUID,

    -- Secret-bearing operations only.
    "reveal_ciphertext" TEXT,
    "reveal_iv" TEXT,
    "reveal_auth_tag" TEXT,
    "reveal_encryption_key_id" TEXT,
    "reveal_expires_at" TIMESTAMPTZ(6),

    "settled_at" TIMESTAMPTZ(6),
    "settled_error_code" "webhook_error_code",

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "webhook_management_operations_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "webhook_management_operations_key_hash_lower"
        CHECK ("idempotency_key_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "webhook_management_operations_fingerprint_lower"
        CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),

    -- Reveal material is all present or all absent. A half-written envelope is
    -- an envelope that cannot be opened, discovered at the worst moment.
    CONSTRAINT "webhook_management_operations_reveal_shape" CHECK (
        ("reveal_ciphertext" IS NULL AND "reveal_iv" IS NULL
         AND "reveal_auth_tag" IS NULL AND "reveal_encryption_key_id" IS NULL)
        OR ("reveal_ciphertext" IS NOT NULL AND "reveal_iv" IS NOT NULL
            AND "reveal_auth_tag" IS NOT NULL AND "reveal_encryption_key_id" IS NOT NULL
            AND "reveal_expires_at" IS NOT NULL)
    ),

    -- Only the two secret-bearing operations may hold one at all.
    CONSTRAINT "webhook_management_operations_reveal_is_secret_bearing" CHECK (
        "reveal_ciphertext" IS NULL
        OR "operation" IN ('CREATE_ENDPOINT', 'ROTATE_SECRET')
    )
);

-- The idempotency identity (§9). Scoped to the organization and the operation:
-- the same key used for two different operations is two different intentions.
CREATE UNIQUE INDEX "webhook_management_operations_identity"
    ON "webhook_management_operations"("organization_id", "operation", "idempotency_key_hash");

-- The sweeper's index. Only rows still holding material are scanned.
CREATE INDEX "webhook_management_operations_reveal_expiry_idx"
    ON "webhook_management_operations"("reveal_expires_at")
    WHERE "reveal_ciphertext" IS NOT NULL;

CREATE INDEX "webhook_management_operations_reveal_key_idx"
    ON "webhook_management_operations"("reveal_encryption_key_id")
    WHERE "reveal_ciphertext" IS NOT NULL;

ALTER TABLE "webhook_management_operations"
    ADD CONSTRAINT "webhook_management_operations_organization_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
ALTER TABLE "webhook_management_operations"
    ADD CONSTRAINT "webhook_management_operations_actor_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;

-- =============================================================================
-- 10. Isolation
--
--   webhook_endpoints                 TENANT_SCOPED  organization_id
--   webhook_subscriptions             TENANT_SCOPED  organization_id
--   webhook_endpoint_config_versions  SYSTEM   — holds sealed URL and secret
--   webhook_events                    SYSTEM   — PalCert's own projection
--   webhook_deliveries                SYSTEM   — machinery
--   webhook_delivery_attempts         SYSTEM   — machinery
--   webhook_verification_attempts     SYSTEM   — machinery
--   webhook_management_operations     SYSTEM   — holds reveal material
--
-- The classification name is the repository's own: TENANT_SCOPED. There is no
-- ORGANIZATION_SCOPED in PalCert and inventing one here would leave the
-- coverage test checking a category nothing else uses.
--
-- Everything holding key material or a remote address is SYSTEM. An
-- organization reads its own configuration through narrow projections that
-- return the host and the port, never the ciphertext and never the secret.
-- =============================================================================

ALTER TABLE "webhook_endpoints" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_endpoints" FORCE ROW LEVEL SECURITY;
ALTER TABLE "webhook_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_subscriptions" FORCE ROW LEVEL SECURITY;

-- Recognised exactly as Phase 14, 15 and 16 recognise theirs: a role switch
-- only a SECURITY DEFINER function owned by a privileged role can reach, *and*
-- a transaction-local flag. The flag alone is forgeable by `palcert_app` and
-- buys nothing; the role switch is the real boundary.
CREATE OR REPLACE FUNCTION app_is_webhook_system_writer() RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT current_user IS DISTINCT FROM session_user
       AND COALESCE(current_setting('palcert.webhook_system_write', true), 'off') = 'on';
$$;

-- --- webhook_endpoints -----------------------------------------------------
-- The organization's own, in all four commands, plus the system writer for the
-- worker paths that activate a configuration or disable an endpoint after a
-- terminal failure. DELETE is refused outright: an integration that received
-- events leaves a history, and removing the endpoint would orphan it.
CREATE POLICY "webhook_endpoints_read" ON "webhook_endpoints" FOR SELECT
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization());

CREATE POLICY "webhook_endpoints_insert" ON "webhook_endpoints" FOR INSERT
    WITH CHECK ("organization_id" = app_current_organization());

CREATE POLICY "webhook_endpoints_update" ON "webhook_endpoints" FOR UPDATE
    USING (app_is_webhook_system_writer() OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_webhook_system_writer() OR "organization_id" = app_current_organization());

CREATE POLICY "webhook_endpoints_delete" ON "webhook_endpoints" FOR DELETE
    USING (false);

-- --- webhook_subscriptions -------------------------------------------------
-- Entirely the organization's. Deleting a row is how an organization stops
-- receiving an event type, and it must take effect before the next attempt
-- rather than only for future events.
CREATE POLICY "webhook_subscriptions_read" ON "webhook_subscriptions" FOR SELECT
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization());

CREATE POLICY "webhook_subscriptions_insert" ON "webhook_subscriptions" FOR INSERT
    WITH CHECK ("organization_id" = app_current_organization());

-- A subscription is created or removed, never edited: changing the event type
-- of an existing row would rewrite history rather than express a new choice.
-- Stated in both clauses, because a write policy without a WITH CHECK is a
-- policy that says nothing about the row being written.
CREATE POLICY "webhook_subscriptions_update" ON "webhook_subscriptions" FOR UPDATE
    USING (false)
    WITH CHECK (false);

CREATE POLICY "webhook_subscriptions_delete" ON "webhook_subscriptions" FOR DELETE
    USING ("organization_id" = app_current_organization());

-- =============================================================================
-- 11. Immutability
--
-- A configuration version is what an organization committed to. A webhook
-- event is what PalCert projected. An attempt is what happened on the wire.
-- None of the three is editable in the parts that give it meaning.
-- =============================================================================

CREATE OR REPLACE FUNCTION webhook_history_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% rows are immutable once written', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "webhook_events_append_only"
    BEFORE UPDATE OR DELETE ON "webhook_events"
    FOR EACH ROW EXECUTE FUNCTION webhook_history_is_append_only();

CREATE TRIGGER "webhook_delivery_attempts_no_delete"
    BEFORE DELETE ON "webhook_delivery_attempts"
    FOR EACH ROW EXECUTE FUNCTION webhook_history_is_append_only();

CREATE TRIGGER "webhook_verification_attempts_no_delete"
    BEFORE DELETE ON "webhook_verification_attempts"
    FOR EACH ROW EXECUTE FUNCTION webhook_history_is_append_only();

CREATE TRIGGER "webhook_deliveries_no_delete"
    BEFORE DELETE ON "webhook_deliveries"
    FOR EACH ROW EXECUTE FUNCTION webhook_history_is_append_only();

CREATE TRIGGER "webhook_config_versions_no_delete"
    BEFORE DELETE ON "webhook_endpoint_config_versions"
    FOR EACH ROW EXECUTE FUNCTION webhook_history_is_append_only();

/*
 * A configuration's semantic identity — where it points and what signs it — is
 * fixed at creation. Only its lifecycle and its cryptographic envelope may
 * change, and the envelope only under a rewrap that reproduces the identical
 * plaintext.
 *
 * This is what makes a rewrap safe to run as a maintenance job over every row
 * in the table: it cannot be used to re-point a URL, because the metadata the
 * worker compares against before every attempt is not writable here.
 */
CREATE OR REPLACE FUNCTION webhook_config_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."endpoint_id" IS DISTINCT FROM OLD."endpoint_id"
       OR NEW."version_number" IS DISTINCT FROM OLD."version_number"
       OR NEW."url_sha256" IS DISTINCT FROM OLD."url_sha256"
       OR NEW."host" IS DISTINCT FROM OLD."host"
       OR NEW."port" IS DISTINCT FROM OLD."port"
       OR NEW."secret_fingerprint" IS DISTINCT FROM OLD."secret_fingerprint"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
        RAISE EXCEPTION 'webhook config version % identity is immutable', OLD."id";
    END IF;

    -- Terminal means terminal. A stale verification must not revive a
    -- configuration that was superseded while it was in flight.
    IF OLD."status" IN ('RETIRED', 'SUPERSEDED')
       AND NEW."status" IS DISTINCT FROM OLD."status"
    THEN
        RAISE EXCEPTION 'webhook config version % is already %', OLD."id", OLD."status";
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "webhook_config_versions_guard_trigger"
    BEFORE UPDATE ON "webhook_endpoint_config_versions"
    FOR EACH ROW EXECUTE FUNCTION webhook_config_versions_guard();

-- A delivery's identity is fixed; its progress is not. Terminal means terminal
-- here too: without it a stale worker could move a delivered webhook back to
-- PENDING and send somebody a second approval.
CREATE OR REPLACE FUNCTION webhook_deliveries_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."webhook_event_id" IS DISTINCT FROM OLD."webhook_event_id"
       OR NEW."endpoint_id" IS DISTINCT FROM OLD."endpoint_id"
       OR NEW."endpoint_config_version_id" IS DISTINCT FROM OLD."endpoint_config_version_id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."kind" IS DISTINCT FROM OLD."kind"
       OR NEW."replay_of_delivery_id" IS DISTINCT FROM OLD."replay_of_delivery_id"
       OR NEW."control_occurred_at" IS DISTINCT FROM OLD."control_occurred_at"
       OR NEW."body_sha256" IS DISTINCT FROM OLD."body_sha256"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
        RAISE EXCEPTION 'webhook delivery % identity is immutable', OLD."id";
    END IF;

    IF OLD."status" IN ('DELIVERED', 'FAILED_PERMANENT', 'SKIPPED')
       AND NEW."status" IS DISTINCT FROM OLD."status"
    THEN
        RAISE EXCEPTION 'webhook delivery % is already %', OLD."id", OLD."status";
    END IF;

    IF NEW."attempt_count" < OLD."attempt_count" THEN
        RAISE EXCEPTION 'webhook delivery % attempt count cannot go backwards', OLD."id";
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "webhook_deliveries_guard_trigger"
    BEFORE UPDATE ON "webhook_deliveries"
    FOR EACH ROW EXECUTE FUNCTION webhook_deliveries_guard();

-- An attempt is written when it starts and closed once when it ends. The one
-- permitted update is that closing; nothing may reopen it or rewrite how it
-- went. Shared by both attempt tables because the rule is the same.
CREATE OR REPLACE FUNCTION webhook_attempt_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."attempt_number" IS DISTINCT FROM OLD."attempt_number"
       OR NEW."started_at" IS DISTINCT FROM OLD."started_at"
    THEN
        RAISE EXCEPTION '% % identity is immutable', TG_TABLE_NAME, OLD."id";
    END IF;

    IF OLD."outcome" IS NOT NULL THEN
        RAISE EXCEPTION '% % is already %', TG_TABLE_NAME, OLD."id", OLD."outcome";
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "webhook_delivery_attempts_guard_trigger"
    BEFORE UPDATE ON "webhook_delivery_attempts"
    FOR EACH ROW EXECUTE FUNCTION webhook_attempt_guard();

CREATE TRIGGER "webhook_verification_attempts_guard_trigger"
    BEFORE UPDATE ON "webhook_verification_attempts"
    FOR EACH ROW EXECUTE FUNCTION webhook_attempt_guard();

/*
 * A management operation records one intention. Its identity, its actor and
 * the resources it produced never change, because the whole point of the row
 * is that the same key returns the same answer.
 *
 * Reveal material may only ever be removed, never replaced or extended — that
 * is expiry and the sweeper, not a way to hand out a different secret under an
 * old key. Rewrapping is permitted, and the rewrap path proves the plaintext
 * is unchanged before it writes.
 */
CREATE OR REPLACE FUNCTION webhook_management_operations_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."operation" IS DISTINCT FROM OLD."operation"
       OR NEW."idempotency_key_hash" IS DISTINCT FROM OLD."idempotency_key_hash"
       OR NEW."request_fingerprint" IS DISTINCT FROM OLD."request_fingerprint"
       OR NEW."actor_user_id" IS DISTINCT FROM OLD."actor_user_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
        RAISE EXCEPTION 'webhook management operation % identity is immutable', OLD."id";
    END IF;

    -- The window is set once. Extending it would mean a secret stays
    -- recoverable for longer than the caller was told, decided after the fact.
    IF OLD."reveal_expires_at" IS NOT NULL
       AND NEW."reveal_expires_at" IS NOT NULL
       AND NEW."reveal_expires_at" IS DISTINCT FROM OLD."reveal_expires_at"
    THEN
        RAISE EXCEPTION 'webhook management operation % reveal window is fixed', OLD."id";
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "webhook_management_operations_guard_trigger"
    BEFORE UPDATE ON "webhook_management_operations"
    FOR EACH ROW EXECUTE FUNCTION webhook_management_operations_guard();

CREATE TRIGGER "webhook_management_operations_no_delete"
    BEFORE DELETE ON "webhook_management_operations"
    FOR EACH ROW EXECUTE FUNCTION webhook_history_is_append_only();

-- =============================================================================
-- 12. Privileges
--
-- `palcert_app` gets no DELETE anywhere in this phase: nothing here is
-- deletable, and the grant says so rather than relying on a trigger alone.
-- Subscriptions are the exception — removing one is how an organization
-- unsubscribes.
-- =============================================================================
REVOKE ALL ON "webhook_endpoints" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "webhook_endpoints" TO "palcert_app";

REVOKE ALL ON "webhook_endpoint_config_versions" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "webhook_endpoint_config_versions" TO "palcert_app";

REVOKE ALL ON "webhook_subscriptions" FROM "palcert_app";
GRANT SELECT, INSERT, DELETE ON "webhook_subscriptions" TO "palcert_app";

REVOKE ALL ON "webhook_events" FROM "palcert_app";
GRANT SELECT, INSERT ON "webhook_events" TO "palcert_app";

REVOKE ALL ON "webhook_deliveries" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "webhook_deliveries" TO "palcert_app";

REVOKE ALL ON "webhook_delivery_attempts" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "webhook_delivery_attempts" TO "palcert_app";

REVOKE ALL ON "webhook_verification_attempts" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "webhook_verification_attempts" TO "palcert_app";

REVOKE ALL ON "webhook_management_operations" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "webhook_management_operations" TO "palcert_app";

GRANT EXECUTE ON FUNCTION app_is_webhook_system_writer() TO "palcert_app";
GRANT EXECUTE ON FUNCTION webhook_history_is_append_only() TO "palcert_app";
GRANT EXECUTE ON FUNCTION webhook_config_versions_guard() TO "palcert_app";
GRANT EXECUTE ON FUNCTION webhook_deliveries_guard() TO "palcert_app";
GRANT EXECUTE ON FUNCTION webhook_attempt_guard() TO "palcert_app";
GRANT EXECUTE ON FUNCTION webhook_management_operations_guard() TO "palcert_app";

-- =============================================================================
-- 13. The isolation catalogue
-- =============================================================================
INSERT INTO "table_isolation_classification" ("table_name", "classification", "tenant_column", "notes")
VALUES
    ('webhook_endpoints', 'TENANT_SCOPED', 'organization_id',
     'An organization''s integrations. Holds no URL and no secret: those live in immutable configuration versions, sealed with the Phase 17 keyring.'),
    ('webhook_subscriptions', 'TENANT_SCOPED', 'organization_id',
     'Which event types an endpoint receives. Normalized rows over a closed enum; a missing row means not subscribed, so a new event type reaches nobody until asked for.'),
    ('webhook_endpoint_config_versions', 'SYSTEM', NULL,
     'Sealed URL and signing secret plus the immutable metadata recomputed and compared before every network attempt. Never tenant-readable; organizations see host and port through a narrow projection.'),
    ('webhook_events', 'SYSTEM', NULL,
     'PalCert''s external projection of a DomainEvent. One per event, for ever. Never authority for anything: Phase 14 and Phase 15 keep that.'),
    ('webhook_deliveries', 'SYSTEM', NULL,
     'One delivery of one body to one endpoint under one configuration. Carries no response body and no remote header.'),
    ('webhook_delivery_attempts', 'SYSTEM', NULL,
     'Append-only attempt history: a normalized error code, a status and a duration. No URL, no signature, no secret, no remote text.'),
    ('webhook_verification_attempts', 'SYSTEM', NULL,
     'Append-only history of endpoint verification. Deliberately holds no challenge: a persisted challenge is a persisted answer key.'),
    ('webhook_management_operations', 'SYSTEM', NULL,
     'The durable identity of an HTTP mutation. Stores the idempotency key''s hash and never the key, and for the two secret-bearing operations a bounded encrypted reveal.')
ON CONFLICT ("table_name") DO UPDATE
    SET "classification" = EXCLUDED."classification",
        "tenant_column" = EXCLUDED."tenant_column",
        "notes" = EXCLUDED."notes";

-- =============================================================================
-- 14. The three new job resource types
--
-- All three are PalCert's own work rather than one customer's. A fan-out
-- serves every subscribed endpoint of an organization, a delivery is machinery,
-- and a verification belongs to the integration rather than to the person who
-- happened to click the button. Filing them under a user id would say something
-- false about whose work they are, so all three join the system branch with
-- neither column set — as the payment and notification types already do.
-- =============================================================================
ALTER TABLE "processing_jobs" DROP CONSTRAINT "processing_jobs_resource_type_known";
ALTER TABLE "processing_jobs"
    ADD CONSTRAINT "processing_jobs_resource_type_known"
    CHECK ("resource_type" IN (
        'DOCUMENT_VERSION', 'DOCUMENT', 'DOCUMENT_ANALYSIS', 'DOCUMENT_CHECK', 'CHECK_RUN', 'AI_REVIEW',
        'STANDARD_SOURCE_ASSET', 'RULE_EXTRACTION_RUN',
        'PAYMENT_PROVIDER_EVENT', 'PAYMENT_RECONCILIATION',
        'SMARTFIX_REQUEST', 'SUBMISSION_REVISION', 'COMPLIANCE_CERTIFICATE',
        'DOMAIN_EVENT', 'NOTIFICATION_DELIVERY',
        'WEBHOOK_DELIVERY', 'WEBHOOK_VERIFICATION_OPERATION'));

ALTER TABLE "processing_jobs" DROP CONSTRAINT "processing_jobs_tenancy_matches_type";
ALTER TABLE "processing_jobs"
    ADD CONSTRAINT "processing_jobs_tenancy_matches_type" CHECK (
        ("resource_type" IN ('STANDARD_SOURCE_ASSET', 'RULE_EXTRACTION_RUN')
            AND "organization_id" IS NOT NULL AND "owner_user_id" IS NOT NULL)
        OR ("resource_type" IN ('PAYMENT_PROVIDER_EVENT', 'PAYMENT_RECONCILIATION',
                                'DOMAIN_EVENT', 'NOTIFICATION_DELIVERY',
                                'WEBHOOK_DELIVERY', 'WEBHOOK_VERIFICATION_OPERATION')
            AND "organization_id" IS NULL AND "owner_user_id" IS NULL)
        OR ("resource_type" NOT IN ('STANDARD_SOURCE_ASSET', 'RULE_EXTRACTION_RUN',
                                    'PAYMENT_PROVIDER_EVENT', 'PAYMENT_RECONCILIATION',
                                    'DOMAIN_EVENT', 'NOTIFICATION_DELIVERY',
                                    'WEBHOOK_DELIVERY', 'WEBHOOK_VERIFICATION_OPERATION')
            AND "organization_id" IS NULL AND "owner_user_id" IS NOT NULL)
    );

-- =============================================================================
-- 15. Permissions
--
-- Organization-scoped, and granted only to the roles that already hold
-- `organization:profile:update` — the administrative anchor. A reviewer
-- deciding submissions must not be able to redirect where those decisions are
-- announced, and a template manager authoring rules has no business minting a
-- signing secret.
--
-- Four permissions rather than one, because the four acts differ in
-- consequence: reading a delivery log is support work, managing an endpoint
-- changes where events go, rotating mints a credential, and replaying re-sends
-- events a receiver may act on a second time.
-- =============================================================================
INSERT INTO "permissions" ("id", "code", "description") VALUES
    (gen_random_uuid(), 'integration:webhook:read',
     'Read this organization''s webhook endpoints and delivery history'),
    (gen_random_uuid(), 'integration:webhook:manage',
     'Create, update, verify, test, pause and disable webhook endpoints'),
    (gen_random_uuid(), 'integration:webhook:secret:rotate',
     'Rotate a webhook signing secret'),
    (gen_random_uuid(), 'integration:webhook:replay',
     'Replay a past webhook delivery')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT DISTINCT rp."role_id", p."id"
FROM "role_permissions" rp
JOIN "permissions" anchor
  ON anchor."id" = rp."permission_id" AND anchor."code" = 'organization:profile:update'
CROSS JOIN "permissions" p
WHERE p."code" IN (
    'integration:webhook:read', 'integration:webhook:manage',
    'integration:webhook:secret:rotate', 'integration:webhook:replay')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- =============================================================================
-- 16. Documentation
-- =============================================================================
COMMENT ON TABLE "webhook_endpoints" IS
    'An organization''s outbound integration. Ten live per organization, held by a slot unique index rather than by an application check.';
COMMENT ON TABLE "webhook_endpoint_config_versions" IS
    'Immutable configuration: sealed URL and signing secret, plus metadata recomputed and compared before every attempt so a tampered ciphertext fails permanently with zero network.';
COMMENT ON TABLE "webhook_subscriptions" IS
    'Closed-enum subscriptions with no wildcard. A missing row means not subscribed.';
COMMENT ON TABLE "webhook_events" IS
    'The external projection of a DomainEvent (one per event, for ever). A projection, never the authority.';
COMMENT ON TABLE "webhook_deliveries" IS
    'One body to one endpoint under one configuration. At most one ORIGINAL per (event, endpoint); replays are new rows that name the one they replay.';
COMMENT ON TABLE "webhook_delivery_attempts" IS
    'Append-only wire history. Normalized codes only; no remote text is ever stored.';
COMMENT ON TABLE "webhook_verification_attempts" IS
    'Append-only verification history. Holds no challenge, no signature, no URL and no response.';
COMMENT ON TABLE "webhook_management_operations" IS
    'Durable identity of an HTTP mutation. Stores the idempotency key''s hash, never the key, and a bounded encrypted reveal for the two secret-bearing operations.';
