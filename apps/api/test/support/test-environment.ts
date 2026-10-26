/**
 * Hermetic environment for authentication tests.
 *
 * Phase 0 found ambient-environment contamination in the Python suite; the same
 * defect is prevented here by replacing `process.env` wholesale with an
 * explicit, complete set of values rather than layering on top of whatever the
 * developer's shell happens to export (Phase 1 §40).
 *
 * Only the database and Redis URLs are inherited, because those must point at
 * the real services the test runner provisioned.
 */
export interface TestEnvironmentOverrides {
  readonly [key: string]: string;
}

const INHERITED_KEYS = [
  'DATABASE_URL',
  'DATABASE_ADMIN_URL',
  'REDIS_URL',
  'STORAGE_ENDPOINT',
  'STORAGE_BUCKET',
  'STORAGE_QUARANTINE_BUCKET',
  'STORAGE_DERIVED_BUCKET',
  'DOC_ENGINE_URL',
  'STORAGE_ACCESS_KEY_ID',
  'STORAGE_SECRET_ACCESS_KEY',
  'PATH',
  'HOME',
  'NODE_ENV',
] as const;

export function applyTestEnvironment(overrides: TestEnvironmentOverrides = {}): () => void {
  const original = { ...process.env };

  const inherited: Record<string, string> = {};
  for (const key of INHERITED_KEYS) {
    const value = process.env[key];
    if (value !== undefined) inherited[key] = value;
  }

  const base: Record<string, string> = {
    NODE_ENV: 'test',
    APP_NAME: 'palcert-api-test',
    APP_VERSION: '0.1.0-test',
    LOG_LEVEL: process.env['LOG_LEVEL'] ?? 'error',
    LOG_PRETTY: 'false',

    // The request path must use the least-privileged role in tests too —
    // otherwise every row-level security assertion would be vacuous.
    DATABASE_URL:
      inherited.DATABASE_URL ??
      'postgresql://palcert_app:palcert_app_local_dev_password@localhost:5432/palcert',
    DATABASE_ADMIN_URL:
      inherited.DATABASE_ADMIN_URL ??
      'postgresql://palcert:palcert_local_dev@localhost:5432/palcert',
    DATABASE_ENFORCE_LEAST_PRIVILEGE: 'true',
    REDIS_URL: inherited.REDIS_URL ?? 'redis://localhost:6379',

    // Object storage: a real S3-compatible service (MinIO in CI and locally),
    // inherited so the runner can point at whichever it provisioned. The
    // buckets are created by `pnpm storage:provision` before the suite runs.
    STORAGE_ENDPOINT: inherited.STORAGE_ENDPOINT ?? 'http://127.0.0.1:9000',
    STORAGE_BUCKET: inherited.STORAGE_BUCKET ?? 'palcert-test-documents',
    STORAGE_QUARANTINE_BUCKET: inherited.STORAGE_QUARANTINE_BUCKET ?? 'palcert-test-quarantine',
    STORAGE_DERIVED_BUCKET: inherited.STORAGE_DERIVED_BUCKET ?? 'palcert-test-derived',
    DOC_ENGINE_URL: inherited.DOC_ENGINE_URL ?? 'http://127.0.0.1:8099',
    DOC_ENGINE_ANALYSIS_TIMEOUT_MS: '20000',
    DOC_ENGINE_READINESS_TIMEOUT_MS: '1000',
    STORAGE_ACCESS_KEY_ID: inherited.STORAGE_ACCESS_KEY_ID ?? 'test-access-key',
    STORAGE_SECRET_ACCESS_KEY: inherited.STORAGE_SECRET_ACCESS_KEY ?? 'test-secret-key',
    STORAGE_FORCE_PATH_STYLE: 'true',
    STORAGE_UPLOAD_URL_TTL_SECONDS: '120',
    STORAGE_DOWNLOAD_URL_TTL_SECONDS: '60',

    // Small, controlled limits so oversize and bomb cases stay tiny (§18).
    UPLOAD_MAX_DOCX_BYTES: String(256 * 1024),
    UPLOAD_MAX_PDF_BYTES: String(256 * 1024),
    UPLOAD_SESSION_TTL_SECONDS: '600',
    // No background sweeping in tests: suites drive the sweeps explicitly.
    UPLOAD_SWEEP_INTERVAL_MS: String(60 * 60 * 1000),
    INGEST_MAX_ARCHIVE_ENTRIES: '64',
    INGEST_MAX_ARCHIVE_ENTRY_BYTES: String(4 * 1024 * 1024),
    INGEST_MAX_ARCHIVE_TOTAL_BYTES: String(8 * 1024 * 1024),
    INGEST_MAX_COMPRESSION_RATIO: '50',
    INGEST_MAX_INSPECTED_PART_BYTES: String(1024 * 1024),
    INGEST_VALIDATION_TIMEOUT_MS: '20000',
    INGEST_SCAN_TIMEOUT_MS: '20000',

    // AI is on in tests, served by the deterministic double. The real
    // adapter is proved separately against a controlled HTTP server; these
    // suites are about orchestration, isolation and the guarantees around it.
    AI_ENABLED: 'true',
    AI_PRIMARY_PROVIDER: 'fake',
    // Phase 10. The double confirms payments nobody made, which is exactly
    // what the financial suites need and exactly why configuration refuses it
    // in production.
    PAYMENTS_ENABLED: 'true',
    PAYMENT_PROVIDER: 'fake',
    PALCERT_ENABLED_CURRENCIES: 'USD,EUR,JPY',
    PALCERT_DEFAULT_CURRENCY: 'USD',
    TOPUP_MIN_MINOR: '500',
    TOPUP_MAX_MINOR: '200000',
    // Short so a test can drive reconciliation without waiting.
    PAYMENT_RECONCILE_AFTER_SECONDS: '30',
    AI_MAX_RULES_PER_REQUEST: '5',
    AI_RETRY_BASE_MS: '100',
    AI_RETRY_MAX_MS: '1000',
    QUEUE_MAX_ATTEMPTS: '3',
    QUEUE_BACKOFF_BASE_MS: '100',
    QUEUE_BACKOFF_MAX_MS: '1000',
    QUEUE_LEASE_SECONDS: '30',
    WORKER_CONCURRENCY: '2',
    WORKER_PORT: '4998',

    // supertest connects over loopback, so declaring loopback trusted is what
    // lets a suite present distinct client addresses to the per-IP throttles.
    // It is a real deployment shape — "one proxy, on this host" — not a test
    // affordance, and a suite that boots with it empty proves the opposite
    // case (Phase 20 Checkpoint 7).
    API_TRUSTED_PROXIES: 'loopback',

    // The fake scanner behind the real port; tests flip it into an outage.
    MALWARE_SCANNER: 'fake',

    // Phase 16. The double behind the real port: it records what was sent
    // without sending it, so the suites can exercise the whole delivery path
    // — success, outage, permanent rejection, the retry ladder — without an
    // SMTP server or a mailbox. Configuration refuses it in production,
    // because a transport that accepts every message and sends none would
    // record deliveries that never happened.
    NOTIFICATION_EMAIL_PROVIDER: 'fake',
    NOTIFICATION_EMAIL_FROM: 'no-reply@palcert.test',

    AUTH_MFA_SECRET_KEY: Buffer.alloc(32, 42).toString('base64'),
    CERTIFICATE_VERIFICATION_SECRET_KEY: Buffer.alloc(32, 43).toString('base64'),
    API_CLIENT_REVEAL_SECRET_KEY: Buffer.alloc(32, 44).toString('base64'),

    // Two keys, with the second active: the e2e suite then exercises the
    // decrypt-only path on every read of a row sealed under the first, rather
    // than only the single-key happy case a one-key ring would prove.
    // A second allowed port so the suite can prove that a rotation re-seals a
    // non-default port and a deep path exactly. A port outside this list is
    // still refused, which is what the URL-policy test asserts.
    WEBHOOK_ALLOWED_PORTS: '443,8443',
    WEBHOOK_ENCRYPTION_ACTIVE_KID: 'k2',
    WEBHOOK_ENCRYPTION_KEYS: [
      `k1:${Buffer.alloc(32, 44).toString('base64')}`,
      `k2:${Buffer.alloc(32, 45).toString('base64')}`,
    ].join(','),
    // Withdrawals (ADR-0150): a two-key ring, so a test can prove rotation.
    PAYOUT_DESTINATION_ENCRYPTION_ACTIVE_KID: 'p2',
    PAYOUT_DESTINATION_ENCRYPTION_KEYS: [
      `p1:${Buffer.alloc(32, 71).toString('base64')}`,
      `p2:${Buffer.alloc(32, 72).toString('base64')}`,
    ].join(','),

    API_PORT: '4999',
    API_DOCS_ENABLED: 'true',
    API_CORS_ORIGINS: 'http://localhost:3000,https://app.palcert.test',
    // High enough that ordinary tests never trip it; throttling tests override it.
    API_RATE_LIMIT_LIMIT: '10000',
    API_RATE_LIMIT_TTL_SECONDS: '60',

    APP_PUBLIC_WEB_URL: 'http://localhost:3000',

    // Fast, deliberately weak Argon2 parameters. Production floors are enforced
    // separately by configuration validation, which has its own test.
    AUTH_ARGON2_MEMORY_KIB: '1024',
    AUTH_ARGON2_TIME_COST: '1',
    AUTH_ARGON2_PARALLELISM: '1',

    AUTH_PASSWORD_MIN_LENGTH: '12',
    AUTH_SESSION_IDLE_MINUTES: '60',
    AUTH_SESSION_ABSOLUTE_MINUTES: '720',
    AUTH_PRIVILEGED_SESSION_IDLE_MINUTES: '15',
    AUTH_PRIVILEGED_SESSION_ABSOLUTE_MINUTES: '480',
    AUTH_MFA_PENDING_MINUTES: '5',
    AUTH_REAUTH_WINDOW_MINUTES: '15',
    AUTH_EMAIL_VERIFICATION_TTL_MINUTES: '1440',
    AUTH_PASSWORD_RESET_TTL_MINUTES: '30',

    AUTH_LOGIN_MAX_ATTEMPTS_PER_ACCOUNT: '5',
    AUTH_LOGIN_MAX_ATTEMPTS_PER_IP: '50',
    AUTH_LOGIN_THROTTLE_WINDOW_MINUTES: '15',
    AUTH_MFA_MAX_ATTEMPTS: '5',
    AUTH_PASSWORD_RESET_MAX_REQUESTS: '5',
    AUTH_MFA_RECOVERY_CODE_COUNT: '10',
    AUTH_COOKIE_SAMESITE: 'lax',
  };

  process.env = { ...inherited, ...base, ...overrides } as NodeJS.ProcessEnv;

  return () => {
    process.env = original;
  };
}
