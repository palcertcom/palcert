import { z } from 'zod';

/**
 * Centralized environment schema (§46: centralized configuration).
 *
 * Configuration is validated ONCE at process start. A process must refuse to
 * boot with invalid configuration rather than fail later at request time.
 *
 * No default value in this file may ever be a usable production secret.
 */

/**
 * Treat an empty environment variable as unset.
 *
 * Containers make this necessary: `ARG X=""` followed by `ENV X=${X}` sets the
 * variable to an empty string, which is *present* as far as a schema is
 * concerned, so `.optional()` alone does not cover it.
 */
const emptyAsUndefined = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value === '' ? undefined : value));

const booleanFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

/**
 * The same rule, for a process that cannot validate its whole environment at
 * boot.
 *
 * The Next.js web server reads a couple of variables directly, because it has
 * no startup hook where this schema could run. Those reads were hand-written —
 * `X !== 'false' && X !== '0'` — which accepts anything: a deployment that
 * wrote `METRICS_ENABLED=no` meaning *off* got it left on, with no error to
 * say so. That is the Checkpoint 20.2 defect with its sign flipped, and the
 * fix is not another hand-written comparison but the same parser.
 *
 * An unrecognized value resolves to `false` rather than to the default. A
 * deployment that put something in the variable was trying to control
 * something; when the instruction cannot be read and the subject is an
 * exposure surface, the safe reading is "do not expose".
 */
export function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const parsed = booleanFromEnv.safeParse(value);
  return parsed.success ? parsed.data : false;
}

export const NodeEnv = z.enum(['development', 'test', 'production']);
export type NodeEnv = z.infer<typeof NodeEnv>;

const port = z.coerce.number().int().min(1).max(65535);

/** Secrets must be long enough to resist offline brute force (§38). */
const secret = z.string().min(32, 'must be at least 32 characters');

export const baseEnvSchema = z.object({
  NODE_ENV: NodeEnv.default('development'),
  APP_NAME: z.string().min(1).default('palcert'),
  APP_VERSION: z.string().min(1).default('0.1.0'),

  /**
   * The Git commit this build came from (Phase 20 Checkpoint 2).
   *
   * Baked into the image at build time, not set by a deployment. `APP_VERSION`
   * is a hand-maintained string that two different builds can share, so it
   * cannot answer "did the rollback actually land?". Optional, because a
   * process started from source has no commit and should still boot.
   */
  //
  // An empty string reads as absent. A Dockerfile that declares
  // `ARG APP_COMMIT=""` and is built without the argument sets the variable to
  // the empty string rather than leaving it unset, and refusing to boot over
  // a missing build label would turn a cosmetic gap into an outage.
  APP_COMMIT: emptyAsUndefined.pipe(
    z
      .string()
      .regex(/^[0-9a-f]{40}$/, 'must be a full 40-character commit SHA')
      .optional(),
  ),
  /**
   * When the image was built, RFC 3339.
   *
   * Deliberately not part of content identity: it is read at runtime and never
   * used to derive a cache key or a digest, so two builds of the same source
   * still produce the same layers.
   */
  APP_BUILT_AT: emptyAsUndefined.pipe(z.string().datetime({ offset: true }).optional()),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: booleanFromEnv.default('false'),
});

const postgresUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith('postgres://') || value.startsWith('postgresql://'), {
    message: 'must be a PostgreSQL connection string',
  });

export const databaseEnvSchema = z.object({
  /**
   * The request-path connection.
   *
   * MUST be the least-privileged application role: not a superuser, without
   * BYPASSRLS, and not the schema owner. The API asserts this at boot and
   * refuses to start otherwise, because every row-level security policy is
   * decoration if the application can bypass it (ADR-0018).
   */
  DATABASE_URL: postgresUrl,
  /**
   * The schema-owning connection, used by the Prisma CLI for migrations only.
   * The running application never connects with it.
   */
  DATABASE_ADMIN_URL: postgresUrl.optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /**
   * Refuse to serve traffic when the request-path role can bypass row-level
   * security. Disabling it is only ever appropriate for a local experiment.
   */
  DATABASE_ENFORCE_LEAST_PRIVILEGE: booleanFromEnv.default('true'),
});

export const redisEnvSchema = z.object({
  REDIS_URL: z
    .string()
    .url()
    .refine((value) => value.startsWith('redis://') || value.startsWith('rediss://'), {
      message: 'REDIS_URL must be a Redis connection string',
    }),
});

/** S3 bucket naming rules, so a typo fails at boot rather than at first upload. */
const bucketName = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, 'must be a valid S3 bucket name');

/**
 * Object storage (Phase 5, ADR-0032/0033).
 *
 * Two buckets in two trust zones: everything a browser uploads lands in the
 * quarantine bucket and nothing leaves it except through validation and
 * scanning into the clean bucket. Users never name a bucket or a key.
 */
export const storageEnvSchema = z.object({
  STORAGE_ENDPOINT: z.string().url(),
  /**
   * The endpoint browsers reach for presigned uploads and downloads, when it
   * differs from the one the API uses internally (a Docker network name
   * versus a public hostname). Defaults to STORAGE_ENDPOINT.
   *
   * Required in production, and pinned there to the origin of
   * APP_PUBLIC_WEB_URL: the web app's CSP lets a browser connect only to its
   * own origin, so the proxy in front of it routes the bucket paths to
   * storage (Phase 20 Checkpoint 9).
   */
  STORAGE_PUBLIC_ENDPOINT: z.string().url().optional(),
  STORAGE_REGION: z.string().min(1).default('us-east-1'),
  /** Clean, private, authoritative documents. */
  STORAGE_BUCKET: bucketName,
  /** Unscanned uploads. Never served to users. */
  STORAGE_QUARANTINE_BUCKET: bucketName,
  /**
   * Derived artifacts: PalCert's own analysis of a user's document (Phase 6).
   * Written only by workers, never presigned for a browser (ADR-0042).
   */
  STORAGE_DERIVED_BUCKET: bucketName,

  // --- Document engine (Phase 6) -------------------------------------------
  /** Base URL of the Python analyzer. Internal; never reached by a browser. */
  DOC_ENGINE_URL: z.string().url().default('http://localhost:8000'),
  /** Budget for one analysis call, which streams a whole document. */
  DOC_ENGINE_ANALYSIS_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(1_800_000)
    .default(300_000),
  DOC_ENGINE_READINESS_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(2_000),
  /**
   * Budget for one rule evaluation call (Phase 7).
   *
   * Shorter than analysis on purpose: evaluation carries no document bytes,
   * only a fact set and the published rules, so a call that runs long is a
   * symptom rather than a large upload.
   */
  DOC_ENGINE_EVALUATION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .default(120_000),

  // --- Checks (Phase 7) ------------------------------------------------------
  /**
   * How many violations are stored per rule.
   *
   * A document can violate one rule on every paragraph, and neither a report
   * page nor a report row is improved by ten thousand of them. The rule's
   * `totalViolationCount` always carries the true number, and the result is
   * marked truncated, so the stored list never pretends to be exhaustive.
   */
  CHECK_MAX_STORED_VIOLATIONS_PER_RULE: z.coerce.number().int().min(1).max(1_000).default(200),
  /** How many violations one API response may return for a single rule. */
  CHECK_MAX_RETURNED_VIOLATIONS_PER_RULE: z.coerce.number().int().min(1).max(500).default(50),
  /** Upper bound on a check list page, whatever the caller asks for. */
  CHECK_MAX_PAGE_SIZE: z.coerce.number().int().min(1).max(200).default(50),

  // --- AI review (Phase 8) ---------------------------------------------------
  /**
   * Whether PalCert offers AI review at all.
   *
   * Off by default. AI review sends document content to a third party, and a
   * capability with that consequence should require a deliberate act to turn
   * on — not merely the absence of one to turn it off (§14).
   */
  // `booleanFromEnv`, not `z.coerce.boolean()`. Coercion runs the string
  // through JavaScript's `Boolean`, and `Boolean('false')` is `true` — so
  // `AI_ENABLED=false` switched AI *on*, and the only reason no deployment
  // noticed is that the cross-field guard then demanded an Anthropic key and
  // every environment had one. It was the sole coercion left in this schema;
  // every other flag already used the enum, which accepts only
  // true/false/1/0 and rejects anything else instead of guessing.
  AI_ENABLED: booleanFromEnv.default('false'),
  AI_PRIMARY_PROVIDER: z.enum(['anthropic', 'fake']).default('anthropic'),
  /**
   * The server-side provider credential.
   *
   * Never reaches a browser, a response, a log, an audit row, a queue payload
   * or the database (§8). Optional in the schema so a deployment with AI
   * switched off needs no placeholder; validated as present when AI is on.
   */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /**
   * The exact model, as configuration.
   *
   * Deliberately not a constant in the code: which model is preferred will
   * change, and PalCert's identity must not be tied to one generation of one
   * vendor's product (§4, §95). The value is persisted with every invocation,
   * so changing it here never rewrites what past reviews recorded.
   */
  ANTHROPIC_MODEL: z.string().min(1).default('claude-opus-5'),
  ANTHROPIC_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(64_000).default(8_000),
  ANTHROPIC_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  /**
   * Optional, model-aware effort. Left unset by default: not every model
   * accepts it, and sending an unsupported control is how an integration
   * breaks on a model upgrade (§7).
   */
  ANTHROPIC_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  /** Base URL override, so adapter tests can face a controlled mock server (§92). */
  ANTHROPIC_BASE_URL: z.string().url().optional(),

  /** Budgets. An academic document is never sent unbounded (§49). */
  AI_MAX_INPUT_TOKENS: z.coerce.number().int().min(1_000).max(500_000).default(60_000),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(64_000).default(8_000),
  AI_MAX_RULES_PER_REQUEST: z.coerce.number().int().min(1).max(100).default(10),
  AI_MAX_CONTEXT_CHARS: z.coerce.number().int().min(1_000).max(400_000).default(60_000),
  /** Per-node text cap, so one reference list cannot consume the whole budget (§88). */
  AI_MAX_NODE_CHARS: z.coerce.number().int().min(100).max(8_000).default(2_000),
  AI_MAX_CONTEXT_NODES: z.coerce.number().int().min(1).max(400).default(120),
  /** Bounded retries with jitter; never indefinite (§56). */
  AI_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  AI_RETRY_BASE_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  AI_RETRY_MAX_MS: z.coerce.number().int().min(100).max(300_000).default(30_000),
  /**
   * What PalCert tells users about the provider's data handling.
   *
   * Configuration rather than hard-coded copy: provider terms change, and text
   * baked into a binary outlives the arrangement it described (§69, §70).
   */
  AI_PROVIDER_RETENTION_POLICY: z
    .enum(['PROVIDER_STANDARD', 'ZERO_DATA_RETENTION'])
    .default('PROVIDER_STANDARD'),
  AI_PROVIDER_POLICY_URL: z.string().url().optional(),

  /**
   * Rule extraction limits (Phase 9, §89, §134, §135).
   *
   * Deliberately separate from the Phase 5 upload limits. A 200 MB PDF is a
   * perfectly acceptable thing to store and a completely unacceptable thing to
   * send to a model, and conflating the two would mean either refusing uploads
   * PalCert can keep or attempting requests no provider will accept.
   */
  AI_EXTRACTION_MAX_SOURCES: z.coerce.number().int().min(1).max(50).default(10),
  /** The provider's own PDF request ceiling is 32 MB; stay well inside it. */
  AI_EXTRACTION_MAX_PDF_BYTES: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(31_457_280)
    .default(20_971_520),
  AI_EXTRACTION_MAX_SOURCE_PAGES: z.coerce.number().int().min(1).max(600).default(200),
  AI_EXTRACTION_MAX_DOCX_TEXT_CHARS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(2_000_000)
    .default(400_000),
  AI_EXTRACTION_MAX_DOCX_BLOCKS: z.coerce.number().int().min(10).max(5_000).default(1_200),
  AI_EXTRACTION_MAX_EVIDENCE_BLOCKS: z.coerce.number().int().min(1).max(2_000).default(400),
  AI_EXTRACTION_MAX_EVIDENCE_CHARS: z.coerce.number().int().min(100).max(20_000).default(2_000),
  AI_EXTRACTION_MAX_TEMPLATE_OBSERVATIONS: z.coerce.number().int().min(1).max(1_000).default(200),
  AI_EXTRACTION_MAX_PROPOSALS: z.coerce.number().int().min(1).max(200).default(150),
  /** Characters of evidence handed to the structuring pass in one request. */
  AI_EXTRACTION_MAX_CONTEXT_CHARS: z.coerce.number().int().min(1_000).max(400_000).default(120_000),
  /** Largest document the API will hand the analyzer. */
  ANALYSIS_MAX_SOURCE_BYTES: z.coerce.number().int().min(1).default(209_715_200),
  /** Largest artifact PalCert will store. */
  ANALYSIS_MAX_ARTIFACT_BYTES: z.coerce.number().int().min(1).default(134_217_728),
  STORAGE_ACCESS_KEY_ID: z.string().min(1),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
  STORAGE_FORCE_PATH_STYLE: booleanFromEnv.default('true'),
  /** Server-side encryption requested on every write the API makes. */
  STORAGE_SERVER_SIDE_ENCRYPTION: z.enum(['none', 'AES256', 'aws:kms']).default('none'),
  STORAGE_KMS_KEY_ID: z.string().min(1).optional(),
  /** Every storage call is bounded; a hung PUT must not hang a worker. */
  STORAGE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
  /** Lifetime of a presigned upload authorization — bearer material. */
  STORAGE_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(900),
  /** Lifetime of a presigned download. Short: the link is a credential. */
  STORAGE_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(10).max(3600).default(300),
});

/**
 * Upload and ingestion policy (Phase 5).
 *
 * Every numeric limit the pipeline enforces lives here, not in the code that
 * enforces it (§18, §63). Defaults are sized for academic documents: a
 * 400-page thesis with figures is tens of megabytes, not hundreds.
 */
export const uploadEnvSchema = z.object({
  UPLOAD_MAX_DOCX_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .default(100 * 1024 * 1024),
  UPLOAD_MAX_PDF_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .default(200 * 1024 * 1024),
  /** How long an upload session (and its staged object) may stay unfinalized. */
  UPLOAD_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .default(30 * 60),
  /** How often the API sweeps expired sessions and pending outbox rows. */
  UPLOAD_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1000).default(60_000),

  // --- DOCX container limits (ZIP-bomb defence, §17) ------------------------
  INGEST_MAX_ARCHIVE_ENTRIES: z.coerce.number().int().min(1).default(2000),
  INGEST_MAX_ARCHIVE_ENTRY_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .default(256 * 1024 * 1024),
  INGEST_MAX_ARCHIVE_TOTAL_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .default(1024 * 1024 * 1024),
  /** Uncompressed / compressed, over the whole archive. XML compresses ~10:1. */
  INGEST_MAX_COMPRESSION_RATIO: z.coerce.number().int().min(1).default(100),
  /** Largest package part PalCert will read into memory to inspect (content types, rels). */
  INGEST_MAX_INSPECTED_PART_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(4 * 1024 * 1024),

  // --- Time budgets ---------------------------------------------------------
  INGEST_VALIDATION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
  INGEST_SCAN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(300_000),

  // --- Queue and worker policy ---------------------------------------------
  /** Total attempts for a transient failure before the job is DEAD. */
  QUEUE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  QUEUE_BACKOFF_BASE_MS: z.coerce.number().int().min(100).default(5_000),
  QUEUE_BACKOFF_MAX_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .default(10 * 60_000),
  /** A RUNNING job whose lease lapses is treated as abandoned and re-dispatched. */
  QUEUE_LEASE_SECONDS: z.coerce.number().int().min(10).default(600),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),
  WORKER_PORT: port.default(4100),
  WORKER_HOST: z.string().min(1).default('0.0.0.0'),
});

/**
 * Malware scanning (Phase 5, ADR-0035).
 *
 * `clamav` streams the file to a clamd daemon; `fake` is for tests and
 * exercises the same port. Production refuses `fake` at configuration time.
 */
export const scannerEnvSchema = z.object({
  MALWARE_SCANNER: z.enum(['clamav', 'fake']).default('clamav'),
  CLAMAV_HOST: z.string().min(1).default('localhost'),
  CLAMAV_PORT: port.default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
  /** clamd's StreamMaxLength must be at least this, or large files are refused mid-stream. */
  CLAMAV_CHUNK_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(1024 * 1024),
});

/**
 * Authentication, session, password and MFA configuration (Phase 1).
 *
 * Every security-relevant duration and cost parameter is here rather than
 * scattered through the code, so a deployment can tune policy without a code
 * change and tests can use explicit fast values (ADR-0011, ADR-0012).
 */
export const authEnvSchema = z.object({
  /** Public origin of the web app, used to build verification/reset links. */
  APP_PUBLIC_WEB_URL: z.string().url().default('http://localhost:3000'),

  // --- Session lifetimes ---------------------------------------------------
  /** Rolling inactivity window for a standard session. */
  AUTH_SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).default(60),
  /** Hard ceiling for a standard session, regardless of activity. */
  AUTH_SESSION_ABSOLUTE_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .default(12 * 60),
  /** Stricter inactivity window for sessions holding a privileged role. */
  AUTH_PRIVILEGED_SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).default(15),
  /** Stricter hard ceiling for privileged sessions. */
  AUTH_PRIVILEGED_SESSION_ABSOLUTE_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .default(8 * 60),
  /** Lifetime of the constrained pre-MFA session. */
  AUTH_MFA_PENDING_MINUTES: z.coerce.number().int().min(1).default(5),
  /** How recently a user must have authenticated to perform sensitive actions. */
  AUTH_REAUTH_WINDOW_MINUTES: z.coerce.number().int().min(1).default(15),

  // --- Cookies -------------------------------------------------------------
  AUTH_COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('lax'),
  AUTH_COOKIE_DOMAIN: z.string().optional(),

  // --- Credential token lifetimes ------------------------------------------
  AUTH_EMAIL_VERIFICATION_TTL_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .default(24 * 60),
  AUTH_PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(1).default(30),

  // --- Password policy (NIST SP 800-63B: length over composition) ----------
  AUTH_PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).default(12),
  /** Upper bound exists only to bound hashing cost; passwords are never truncated. */
  AUTH_PASSWORD_MAX_LENGTH: z.coerce.number().int().min(64).max(4096).default(256),
  /** Enables the breached-password check when a provider is configured. */
  AUTH_BREACHED_PASSWORD_CHECK_ENABLED: booleanFromEnv.default('false'),

  // --- Argon2id parameters -------------------------------------------------
  /** Memory cost in KiB. OWASP baseline for Argon2id is 19456 (19 MiB). */
  AUTH_ARGON2_MEMORY_KIB: z.coerce.number().int().min(512).default(19456),
  AUTH_ARGON2_TIME_COST: z.coerce.number().int().min(1).default(2),
  AUTH_ARGON2_PARALLELISM: z.coerce.number().int().min(1).default(1),

  // --- Throttling ----------------------------------------------------------
  AUTH_LOGIN_MAX_ATTEMPTS_PER_ACCOUNT: z.coerce.number().int().min(1).default(10),
  AUTH_LOGIN_MAX_ATTEMPTS_PER_IP: z.coerce.number().int().min(1).default(50),
  AUTH_LOGIN_THROTTLE_WINDOW_MINUTES: z.coerce.number().int().min(1).default(15),
  AUTH_MFA_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  AUTH_PASSWORD_RESET_MAX_REQUESTS: z.coerce.number().int().min(1).default(5),

  // --- MFA -----------------------------------------------------------------
  /**
   * AES-256-GCM key protecting TOTP secrets at rest, base64-encoded 32 bytes.
   * Generate with: openssl rand -base64 32
   */
  AUTH_MFA_SECRET_KEY: z.string().refine((value) => bytesLengthOfBase64(value) === 32, {
    message: 'must be exactly 32 bytes, base64-encoded (openssl rand -base64 32)',
  }),
  AUTH_MFA_ISSUER: z.string().min(1).default('PalCert'),
  AUTH_MFA_RECOVERY_CODE_COUNT: z.coerce.number().int().min(4).max(32).default(10),

  // --- Certificates --------------------------------------------------------
  /**
   * AES-256-GCM key protecting a verification code between the transaction
   * that schedules a certificate and the worker that issues it, base64-encoded
   * 32 bytes. Held here and never by PostgreSQL, so a database compromise on
   * its own cannot turn a certificate row back into a working verification.
   *
   * Generate with: openssl rand -base64 32
   */
  CERTIFICATE_VERIFICATION_SECRET_KEY: z
    .string()
    .refine((value) => bytesLengthOfBase64(value) === 32, {
      message: 'must be exactly 32 bytes, base64-encoded (openssl rand -base64 32)',
    }),

  // --- API clients (Phase 19) ----------------------------------------------
  /**
   * AES-256-GCM key protecting an API-client secret during its show-once
   * recovery window, base64-encoded 32 bytes.
   *
   * Its own key rather than the MFA or certificate one. Key separation is not
   * ceremony here: this is the only key in PalCert that can turn stored bytes
   * back into a *working inbound credential*, so the blast radius of losing it
   * is different in kind from the others, and it must be rotatable on its own
   * schedule. The window is 24 hours and the read path refuses on time before
   * decrypting, so what this key protects is small and short-lived by design.
   *
   * Generate with: openssl rand -base64 32
   */
  API_CLIENT_REVEAL_SECRET_KEY: z.string().refine((value) => bytesLengthOfBase64(value) === 32, {
    message: 'must be exactly 32 bytes, base64-encoded (openssl rand -base64 32)',
  }),
});

/**
 * Phase 16 — workflow notification email.
 *
 * Separate from `AUTH_*` mail settings on purpose. Verification and reset mail
 * carries single-use credentials and notification mail must never be able to;
 * keeping the two transports configurable independently means a deployment can
 * switch workflow mail off entirely without disabling the mail that lets people
 * recover their accounts.
 */
const headerSafeText = (field: string, max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !/[\r\n]/.test(value), {
      message: `${field} must not contain a carriage return or line feed`,
    });

const notificationEmailEnvSchema = z.object({
  /**
   * Which transport sends workflow mail.
   *
   * `disabled` is the default and a legitimate production choice: a deployment
   * with no SMTP relay records CHANNEL_DISABLED skips rather than accumulating
   * retries against a transport that was never going to exist. `fake` is a
   * deterministic in-memory double for tests and is refused in production.
   */
  NOTIFICATION_EMAIL_PROVIDER: z.enum(['disabled', 'fake', 'smtp']).default('disabled'),

  /** The envelope sender. A bare address — the display name is separate. */
  NOTIFICATION_EMAIL_FROM: z.string().email().optional(),
  /**
   * The sender's display name.
   *
   * Validated for CR/LF here rather than at send time, because a deployment
   * whose sender name contains a newline is misconfigured and should be told at
   * boot, not on the first notification of the day.
   */
  NOTIFICATION_EMAIL_FROM_NAME: headerSafeText('NOTIFICATION_EMAIL_FROM_NAME', 200).default(
    'PalCert',
  ),

  NOTIFICATION_SMTP_HOST: z.string().min(1).optional(),
  NOTIFICATION_SMTP_PORT: port.default(587),
  NOTIFICATION_SMTP_SECURE: booleanFromEnv.default('false'),
  NOTIFICATION_SMTP_USER: z.string().min(1).optional(),
  NOTIFICATION_SMTP_PASSWORD: secret.optional(),
  /** Bounded so one unreachable relay cannot hold a worker lease open. */
  NOTIFICATION_SMTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),

  /** How many recipients one fan-out page resolves. Matches the SQL bound. */
  NOTIFICATION_FANOUT_PAGE_SIZE: z.coerce.number().int().min(1).max(500).default(100),
});

/**
 * Phase 17 — outbound webhooks.
 *
 * Two things live here that nothing else in PalCert needs: a keyring rather
 * than a single key, and a description of where PalCert is willing to open a
 * socket.
 *
 * The keyring exists because Phase 15 taught the lesson the hard way — a
 * single `*_SECRET_KEY` cannot be rotated without a flag day, since every
 * stored ciphertext and the one key have to change in the same instant. Rows
 * carry the id of the key they were sealed under, the active key seals new
 * material, and old keys stay readable until nothing references them.
 */
const webhookKid = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface WebhookKeyringEntry {
  readonly kid: string;
  readonly key: Buffer;
}

/*
 * A malformed keyring stops the process at boot. A keyring that is wrong is a
 * keyring that cannot decrypt a URL, and a worker discovering that on its
 * first delivery of the day would report it as a delivery failure against
 * somebody's endpoint rather than as the configuration error it is.
 */
export interface WebhookKeyringParse {
  readonly entries: readonly WebhookKeyringEntry[];
  readonly errors: readonly string[];
}

/**
 * Parse `kid:base64key` pairs, comma-separated.
 *
 * Returns errors rather than throwing so the same function can report them
 * through Zod at boot and be reused by the service that builds the keyring —
 * two parsers would eventually disagree about what a valid ring is, and the
 * disagreement would surface as a process that booted and then could not
 * decrypt anything.
 *
 * Errors name the key id and never the key material.
 */
export function parseWebhookKeyring(value: string): WebhookKeyringParse {
  const entries: WebhookKeyringEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(',')) {
    const item = raw.trim();
    if (item.length === 0) continue;
    const separator = item.indexOf(':');
    if (separator <= 0) {
      errors.push('entries must be kid:key');
      continue;
    }
    const kid = item.slice(0, separator);
    const encoded = item.slice(separator + 1);
    if (!webhookKid.test(kid)) {
      errors.push('key id must be lowercase alphanumeric with dashes');
      continue;
    }
    if (seen.has(kid)) {
      errors.push(`key id ${kid} is listed twice`);
      continue;
    }
    if (bytesLengthOfBase64(encoded) !== 32) {
      errors.push(`key ${kid} must be exactly 32 bytes, base64-encoded`);
      continue;
    }
    seen.add(kid);
    entries.push({ kid, key: Buffer.from(encoded, 'base64') });
  }
  if (entries.length === 0 && errors.length === 0) {
    errors.push('must list at least one key');
  }
  return { entries, errors };
}

const webhookEnvSchema = z.object({
  /**
   * Which key seals new webhook URLs and signing secrets.
   *
   * Must appear in `WEBHOOK_ENCRYPTION_KEYS`. Every other key in the ring is
   * decrypt-only: readable for the rows that still reference it, never chosen
   * for anything new.
   */
  WEBHOOK_ENCRYPTION_ACTIVE_KID: z.string().regex(webhookKid).optional(),
  /** `kid:base64key` pairs, comma-separated. 32 bytes per key. */
  WEBHOOK_ENCRYPTION_KEYS: z.string().min(1).optional(),

  /**
   * Ports an organization may point a webhook at.
   *
   * 443 alone by default. Anything else is a platform decision, not a tenant
   * one: letting an organization name a port turns a webhook endpoint into a
   * port scanner that reports its findings through delivery error codes.
   */
  WEBHOOK_ALLOWED_PORTS: z.string().default('443'),

  /**
   * PalCert's own public hostnames, comma-separated.
   *
   * Refused as webhook destinations. An endpoint pointed at PalCert's own API
   * would make PalCert's outbound requests arrive as inbound ones carrying
   * whatever ambient trust the network grants them.
   */
  WEBHOOK_OWN_HOSTS: z.string().default(''),

  /**
   * Bounds on one attempt (§60).
   *
   * Every one of these exists to stop a slow or hostile receiver holding a
   * worker lease. The total deadline is the one that matters: without it a
   * receiver that accepts a connection and then says nothing costs PalCert a
   * worker for as long as it cares to stay silent.
   */
  WEBHOOK_DNS_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3_000),
  WEBHOOK_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
  WEBHOOK_TLS_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
  WEBHOOK_TOTAL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),

  /**
   * Caps on bytes (§57, §59).
   *
   * There is deliberately no response-body cap, because PalCert reads no
   * response body at all — which is stricter than any cap. The header bound
   * below is real and is enforced by the HTTP parser.
   */
  WEBHOOK_MAX_REQUEST_BYTES: z.coerce.number().int().min(1_024).max(1_048_576).default(65_536),
  WEBHOOK_MAX_RESPONSE_HEADER_BYTES: z.coerce.number().int().min(1_024).max(65_536).default(16_384),
});

function bytesLengthOfBase64(value: string): number {
  try {
    return Buffer.from(value, 'base64').length;
  } catch {
    return -1;
  }
}

function originOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * Admin-managed transactional email (ADR-0146).
 *
 * The provider, sender and credential are chosen by a platform administrator
 * in the dashboard and stored in the database. Only two things stay in the
 * environment: the root key that seals the stored credential, and — for
 * tests and local development only — where the Resend API lives.
 *
 * The root key is a keyring in the same `kid:base64key` form as the webhook
 * keyring, and for the same reason: rotation without a flag day. It is
 * optional. A deployment without it boots and behaves exactly as before; the
 * dashboard says secure configuration is unavailable and refuses to store a
 * credential, because there is nothing to seal it with.
 */
const emailEnvSchema = z.object({
  EMAIL_SETTINGS_ENCRYPTION_ACTIVE_KID: emptyAsUndefined.pipe(
    z.string().regex(webhookKid).optional(),
  ),
  /** `kid:base64key` pairs, comma-separated. 32 bytes per key. */
  EMAIL_SETTINGS_ENCRYPTION_KEYS: emptyAsUndefined.pipe(z.string().min(1).optional()),
  /**
   * Withdrawals (ADR-0150): the AES-256-GCM key ring that seals payout
   * destinations (IBANs, account and mobile numbers). Its own namespace, never
   * the email key: payout details have a different security and rotation
   * lifecycle. Unset, PalCert boots and every read that needs no decryption
   * works, but creating or changing a payout destination is refused.
   */
  PAYOUT_DESTINATION_ENCRYPTION_ACTIVE_KID: emptyAsUndefined.pipe(
    z.string().regex(webhookKid).optional(),
  ),
  /** `kid:base64key` pairs, comma-separated. 32 bytes per key. */
  PAYOUT_DESTINATION_ENCRYPTION_KEYS: emptyAsUndefined.pipe(z.string().min(1).optional()),
  /**
   * Overridden in tests to point at a local fake of the Resend API. Refused in
   * production, and never editable from the dashboard: an administrator who
   * could name the provider's address could make PalCert hand its credential
   * to any server they liked.
   */
  RESEND_API_BASE_URL: emptyAsUndefined.pipe(z.string().url().optional()),
  /** Bounded so a slow provider cannot hold a request or a worker lease. */
  RESEND_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  /** How long the dashboard's settings are cached in each process. */
  EMAIL_SETTINGS_CACHE_SECONDS: z.coerce.number().int().min(0).max(300).default(15),
});

export const apiEnvSchema = baseEnvSchema
  .merge(databaseEnvSchema)
  .merge(redisEnvSchema)
  .merge(storageEnvSchema)
  .merge(uploadEnvSchema)
  .merge(scannerEnvSchema)
  .merge(authEnvSchema)
  .merge(notificationEmailEnvSchema)
  .merge(webhookEnvSchema)
  .merge(emailEnvSchema)
  .extend({
    API_PORT: port.default(4000),
    API_HOST: z.string().min(1).default('0.0.0.0'),
    /** Comma-separated list of allowed browser origins (§38). */
    API_CORS_ORIGINS: z.string().default('http://localhost:3000'),

    /**
     * Which upstream addresses may speak for a client (Phase 20 Checkpoint 7).
     *
     * `X-Forwarded-For` is a request header, which means it is written by
     * whoever sent the request. PalCert makes two security decisions from the
     * client address it yields — the per-IP login throttle and the per-IP
     * public-verification guard — and records it on every audit event, so the
     * question of who is allowed to assert it is not a formality.
     *
     * This used to be `app.set('trust proxy', 1)`: trust one hop, from
     * anybody. Behind the release proxy that is correct, because nginx appends
     * the real socket address last and Express reads that entry. It is also
     * broader than the topology needs — *any* caller that can open a
     * connection to the API port directly is trusted for one hop, and
     * Checkpoint 20.6's load generator used exactly that to present 131 072
     * distinct client identities to a rate limiter. That was a legitimate use
     * of an illegitimate affordance.
     *
     * Empty means trust nothing: `req.ip` is the socket address and a
     * forwarded header is ignored entirely. That is the right default for
     * local development, where there is no proxy, and it is the safe answer
     * anywhere the value has not been thought about.
     *
     * Production must state it, because production is behind a proxy by
     * definition — `APP_PUBLIC_WEB_URL` is required to be https and PalCert
     * does not terminate TLS. Leaving it unset there would silently collapse
     * every visitor onto the proxy's address and throttle the world as one
     * client.
     *
     * Accepts what Express accepts: addresses, CIDR blocks, and the named
     * ranges `loopback`, `linklocal` and `uniquelocal`. Name the load
     * balancer's own addresses where you can; `uniquelocal` is the reasonable
     * answer for a private deployment network and is what the release
     * topology uses.
     */
    API_TRUSTED_PROXIES: emptyAsUndefined.pipe(
      z
        .string()
        .regex(
          /^[A-Za-z0-9.:/,\s-]+$/,
          'must be a comma-separated list of addresses, CIDR blocks or the names loopback, linklocal, uniquelocal',
        )
        .optional(),
    ),
    API_RATE_LIMIT_TTL_SECONDS: z.coerce.number().int().min(1).default(60),
    API_RATE_LIMIT_LIMIT: z.coerce.number().int().min(1).default(120),
    /** Enables the Swagger/OpenAPI explorer. Must be false in production. */
    API_DOCS_ENABLED: booleanFromEnv.default('true'),

    /**
     * Bearer token a scraper must present at `/metrics` (Phase 20 §13).
     *
     * Optional, because the primary control is topology: `/metrics` has no
     * route in the reverse proxy, so it is not reachable from outside at all.
     * This is the second lock, for a deployment whose internal network is
     * shared — a metrics endpoint is a detailed description of what the system
     * is doing, and a scraper is not the only thing that can reach an internal
     * address.
     *
     * When unset the endpoint is open to anything that can already reach the
     * application port directly, which is the same trust level as `/health`.
     */
    METRICS_TOKEN: emptyAsUndefined.pipe(secret.optional()),
    /** Turns the endpoint off entirely for a deployment that scrapes nothing. */
    METRICS_ENABLED: booleanFromEnv.default('true'),

    DOCUMENT_ENGINE_URL: z.string().url().default('http://localhost:8000'),

    // --- Phase 10: payments and the customer credit balance -----------------
    //
    // Off by default. A deployment that has not configured a payment provider
    // still runs: balances are visible, existing credit is spendable, and only
    // topping up is unavailable (§111).
    PAYMENTS_ENABLED: booleanFromEnv.default('false'),
    PAYMENT_PROVIDER: z.enum(['stripe', 'fake']).default('stripe'),

    /**
     * Billing currencies (§7).
     *
     * A comma-separated list intersected with the code's own registry, so a
     * deployment can narrow what it transacts in but never invent a currency
     * PalCert does not know the exponent for.
     */
    PALCERT_ENABLED_CURRENCIES: z
      .string()
      .default('USD')
      .refine((value) => /^[A-Z]{3}(,[A-Z]{3})*$/.test(value.trim()), {
        message: 'must be a comma-separated list of uppercase ISO 4217 codes, e.g. USD,EUR',
      }),
    PALCERT_DEFAULT_CURRENCY: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/)
      .default('USD'),

    STRIPE_SECRET_KEY: secret.optional(),
    STRIPE_WEBHOOK_SECRET: secret.optional(),
    /**
     * The Stripe API version this adapter is written against (§140).
     *
     * Pinned explicitly rather than inherited from the account default, so an
     * account-level upgrade in the dashboard cannot silently change what the
     * adapter's requests mean.
     */
    STRIPE_API_VERSION: z.string().min(1).default('2026-08-26.dahlia'),
    /** Overridden in adapter tests to point at a controlled mock server (§137). */
    STRIPE_BASE_URL: z.string().url().optional(),

    PAYMENT_SUCCESS_URL: z
      .string()
      .url()
      .default('http://localhost:3000/en/balance/payment-return'),
    PAYMENT_CANCEL_URL: z
      .string()
      .url()
      .default('http://localhost:3000/en/balance/payment-cancelled'),

    /** Server-controlled top-up bounds. A client never states its own (§43). */
    TOPUP_MIN_MINOR: z.coerce.number().int().min(1).default(500),
    TOPUP_MAX_MINOR: z.coerce.number().int().min(1).default(200_000),
    /** How long a provider checkout session stays open. */
    TOPUP_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3_600),

    /** How long a hold reserves credit before the sweeper expires it (§22). */
    CREDIT_HOLD_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
    /**
     * How long a paid check's reservation stands (Phase 11 §25).
     *
     * Deliberately not the generic hold TTL. A document check waits in a
     * queue, is analyzed, is evaluated and has a report stored; fifteen
     * minutes is right for a refund settling with a provider and far too
     * short for that. One hour is comfortably longer than normal processing
     * and still a hard upper bound, so a reservation cannot be forgotten
     * indefinitely (§26).
     */
    CHECK_RESERVATION_TTL_SECONDS: z.coerce.number().int().min(300).max(86_400).default(3_600),
    // ADR-0149: how long an AI service's reservation stands. An AI review or
    // a rule extraction can wait in a queue and run for longer than a check,
    // so it has its own bound; the worker re-checks the reservation before
    // every provider call and never calls the provider on credit that has
    // lapsed. Bounded like every hold, so none is forgotten.
    AI_RESERVATION_TTL_SECONDS: z.coerce.number().int().min(600).max(86_400).default(7_200),
    // Certificate attestation. How long the clean copy of a certificate that
    // was never attested (a rejected or cancelled request, or a file that was
    // replaced) is kept before it is purged. An attested artifact is never
    // purged: it is the evidence the attestation stands on.
    ATTESTATION_UNATTESTED_ARTIFACT_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3_650)
      .default(90),
    // The most open (undecided) requests one person may have at once.
    ATTESTATION_MAX_OPEN_REQUESTS_PER_USER: z.coerce.number().int().min(1).max(500).default(20),
    /** How long a price quote stands (§32). */
    PRICE_QUOTE_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(1_800),

    /**
     * How stale a pending top-up must be before reconciliation asks the
     * provider about it (§60). Long enough that a normal webhook wins the
     * race; short enough that a missed one is caught while the customer is
     * still wondering.
     */
    PAYMENT_RECONCILE_AFTER_SECONDS: z.coerce.number().int().min(30).max(86_400).default(300),
    PAYMENT_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
  })
  .superRefine((env, ctx) => {
    // --- Phase 17: the webhook keyring -------------------------------------
    //
    // Either both keyring settings are present or neither is. Half a keyring
    // is the dangerous state: a process with keys but no active kid cannot
    // seal, and one with an active kid naming a key it does not hold cannot
    // decrypt — and both would only be discovered on a real delivery, and
    // reported as somebody's endpoint failing.
    const hasActiveKid = env.WEBHOOK_ENCRYPTION_ACTIVE_KID !== undefined;
    const hasKeys = env.WEBHOOK_ENCRYPTION_KEYS !== undefined;
    if (hasActiveKid !== hasKeys) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasKeys ? 'WEBHOOK_ENCRYPTION_ACTIVE_KID' : 'WEBHOOK_ENCRYPTION_KEYS'],
        message: 'WEBHOOK_ENCRYPTION_ACTIVE_KID and WEBHOOK_ENCRYPTION_KEYS must be set together',
      });
    } else if (hasActiveKid && hasKeys) {
      const parsed = parseWebhookKeyring(env.WEBHOOK_ENCRYPTION_KEYS as string);
      for (const message of parsed.errors) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEBHOOK_ENCRYPTION_KEYS'],
          message,
        });
      }
      if (
        parsed.errors.length === 0 &&
        !parsed.entries.some((entry) => entry.kid === env.WEBHOOK_ENCRYPTION_ACTIVE_KID)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEBHOOK_ENCRYPTION_ACTIVE_KID'],
          message: 'names a key id that WEBHOOK_ENCRYPTION_KEYS does not contain',
        });
      }
    }

    // --- Admin-managed email: the credential root key --------------------
    //
    // Same rule as the webhook keyring: both or neither, and the active kid
    // must name a key in the ring. Absent entirely is legitimate.
    {
      const emailKid = env.EMAIL_SETTINGS_ENCRYPTION_ACTIVE_KID !== undefined;
      const emailKeys = env.EMAIL_SETTINGS_ENCRYPTION_KEYS !== undefined;
      if (emailKid !== emailKeys) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [
            emailKeys ? 'EMAIL_SETTINGS_ENCRYPTION_ACTIVE_KID' : 'EMAIL_SETTINGS_ENCRYPTION_KEYS',
          ],
          message:
            'EMAIL_SETTINGS_ENCRYPTION_ACTIVE_KID and EMAIL_SETTINGS_ENCRYPTION_KEYS must be set together',
        });
      } else if (emailKid && emailKeys) {
        const parsed = parseWebhookKeyring(env.EMAIL_SETTINGS_ENCRYPTION_KEYS as string);
        for (const message of parsed.errors) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['EMAIL_SETTINGS_ENCRYPTION_KEYS'],
            message,
          });
        }
        if (
          parsed.errors.length === 0 &&
          !parsed.entries.some((entry) => entry.kid === env.EMAIL_SETTINGS_ENCRYPTION_ACTIVE_KID)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['EMAIL_SETTINGS_ENCRYPTION_ACTIVE_KID'],
            message: 'names a key id that EMAIL_SETTINGS_ENCRYPTION_KEYS does not contain',
          });
        }
      }
    }

    {
      const payoutKid = env.PAYOUT_DESTINATION_ENCRYPTION_ACTIVE_KID !== undefined;
      const payoutKeys = env.PAYOUT_DESTINATION_ENCRYPTION_KEYS !== undefined;
      if (payoutKid !== payoutKeys) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [
            payoutKeys
              ? 'PAYOUT_DESTINATION_ENCRYPTION_ACTIVE_KID'
              : 'PAYOUT_DESTINATION_ENCRYPTION_KEYS',
          ],
          message:
            'PAYOUT_DESTINATION_ENCRYPTION_ACTIVE_KID and PAYOUT_DESTINATION_ENCRYPTION_KEYS must be set together',
        });
      } else if (payoutKid && payoutKeys) {
        const parsed = parseWebhookKeyring(env.PAYOUT_DESTINATION_ENCRYPTION_KEYS as string);
        for (const message of parsed.errors) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['PAYOUT_DESTINATION_ENCRYPTION_KEYS'],
            message,
          });
        }
        if (
          parsed.errors.length === 0 &&
          !parsed.entries.some(
            (entry) => entry.kid === env.PAYOUT_DESTINATION_ENCRYPTION_ACTIVE_KID,
          )
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['PAYOUT_DESTINATION_ENCRYPTION_ACTIVE_KID'],
            message: 'names a key id that PAYOUT_DESTINATION_ENCRYPTION_KEYS does not contain',
          });
        }
      }
    }

    for (const port of env.WEBHOOK_ALLOWED_PORTS.split(',')) {
      const trimmed = port.trim();
      if (trimmed.length === 0) continue;
      const value = Number(trimmed);
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEBHOOK_ALLOWED_PORTS'],
          message: 'must be a comma-separated list of TCP port numbers',
        });
        break;
      }
    }

    // Checked in every environment: a deployment that says AI is on but has no
    // credential would fail on the user's first review rather than at boot.
    if (
      env.AI_ENABLED &&
      env.AI_PRIMARY_PROVIDER === 'anthropic' &&
      env.ANTHROPIC_API_KEY === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ANTHROPIC_API_KEY'],
        message: 'is required when AI_ENABLED is true and the provider is anthropic',
      });
    }

    if (env.AI_MAX_OUTPUT_TOKENS > env.ANTHROPIC_MAX_OUTPUT_TOKENS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AI_MAX_OUTPUT_TOKENS'],
        message: 'cannot exceed ANTHROPIC_MAX_OUTPUT_TOKENS',
      });
    }

    // A deployment that says payments are on but has no credential would fail
    // on the customer's first top-up rather than at boot.
    if (env.PAYMENTS_ENABLED && env.PAYMENT_PROVIDER === 'stripe') {
      if (env.STRIPE_SECRET_KEY === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STRIPE_SECRET_KEY'],
          message: 'is required when PAYMENTS_ENABLED is true and the provider is stripe',
        });
      }
      // Without this, every webhook fails signature verification — which fails
      // safe, but silently, and no balance would ever be credited.
      if (env.STRIPE_WEBHOOK_SECRET === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['STRIPE_WEBHOOK_SECRET'],
          message: 'is required when PAYMENTS_ENABLED is true and the provider is stripe',
        });
      }
    }

    if (env.TOPUP_MIN_MINOR > env.TOPUP_MAX_MINOR) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TOPUP_MIN_MINOR'],
        message: 'cannot exceed TOPUP_MAX_MINOR',
      });
    }

    // The default billing currency has to be one this deployment actually
    // transacts in, or every quote would be unpayable.
    const enabledCurrencies = env.PALCERT_ENABLED_CURRENCIES.split(',').map((code) => code.trim());
    if (!enabledCurrencies.includes(env.PALCERT_DEFAULT_CURRENCY)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PALCERT_DEFAULT_CURRENCY'],
        message: 'must be one of PALCERT_ENABLED_CURRENCIES',
      });
    }

    // A deployment that says it sends workflow mail but has no relay would
    // fail on the first notification rather than at boot. Checked in every
    // environment, because a broken staging relay is worth the same message.
    if (env.NOTIFICATION_EMAIL_PROVIDER === 'smtp') {
      if (env.NOTIFICATION_SMTP_HOST === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['NOTIFICATION_SMTP_HOST'],
          message: 'is required when NOTIFICATION_EMAIL_PROVIDER is smtp',
        });
      }
      // Without a sender there is no From header to build, and a relay would
      // either reject every message or substitute one PalCert did not choose.
      if (env.NOTIFICATION_EMAIL_FROM === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['NOTIFICATION_EMAIL_FROM'],
          message: 'is required when NOTIFICATION_EMAIL_PROVIDER is smtp',
        });
      }
    }

    if (env.NODE_ENV !== 'production') return;

    // The double confirms payments nobody made. Letting it serve a real
    // customer would credit real balances against no money at all (§35).
    if (env.PAYMENT_PROVIDER === 'fake') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PAYMENT_PROVIDER'],
        message: 'the fake payment provider is for tests only and must never serve production',
      });
    }

    // A base-URL override exists so adapter tests can point at a mock server.
    // In production it would send real payment requests somewhere else.
    if (env.STRIPE_BASE_URL !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STRIPE_BASE_URL'],
        message: 'must not be overridden in production',
      });
    }
    // The Resend address is fixed in production. An override exists only so
    // tests can stand up a local fake; in production it would send the
    // provider credential somewhere other than the provider.
    if (env.RESEND_API_BASE_URL !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RESEND_API_BASE_URL'],
        message: 'must not be overridden in production',
      });
    }

    // The test double answers instantly and deterministically, which is
    // exactly why it must never serve a real user: it would present invented
    // assessments as a review of their document (§3).
    if (env.AI_PRIMARY_PROVIDER === 'fake') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AI_PRIMARY_PROVIDER'],
        message: 'the fake AI provider is for tests only and must never serve production',
      });
    }

    if (env.API_DOCS_ENABLED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['API_DOCS_ENABLED'],
        message: 'API docs must be disabled in production',
      });
    }
    if (env.LOG_PRETTY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LOG_PRETTY'],
        message: 'Pretty logging must be disabled in production (structured JSON only)',
      });
    }
    if (env.API_CORS_ORIGINS.split(',').some((origin) => origin.trim() === '*')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['API_CORS_ORIGINS'],
        message: 'Wildcard CORS origin is not allowed in production',
      });
    }
    if (env.API_TRUSTED_PROXIES === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['API_TRUSTED_PROXIES'],
        message:
          'must name the proxy addresses allowed to set X-Forwarded-For in production, ' +
          'because the per-IP throttles and every audit record depend on it',
      });
    }

    // Tests deliberately lower the Argon2 cost so suites stay fast. Production
    // must never inherit those values, so the floor is enforced here rather
    // than trusted to deployment discipline (OWASP Argon2id baseline).
    if (env.AUTH_ARGON2_MEMORY_KIB < 19456) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_ARGON2_MEMORY_KIB'],
        message: 'must be at least 19456 KiB in production',
      });
    }
    if (env.AUTH_ARGON2_TIME_COST < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_ARGON2_TIME_COST'],
        message: 'must be at least 2 in production',
      });
    }
    if (env.AUTH_PASSWORD_MIN_LENGTH < 12) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_PASSWORD_MIN_LENGTH'],
        message: 'must be at least 12 characters in production',
      });
    }
    if (env.AUTH_COOKIE_SAMESITE === 'none') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_COOKIE_SAMESITE'],
        message: 'SameSite=None is not allowed in production',
      });
    }
    if (!env.DATABASE_ENFORCE_LEAST_PRIVILEGE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_ENFORCE_LEAST_PRIVILEGE'],
        message: 'the least-privilege database check cannot be disabled in production',
      });
    }
    if (env.DATABASE_URL === env.DATABASE_ADMIN_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message:
          'the request-path connection must not be the schema-owning connection — ' +
          'row-level security would be bypassed',
      });
    }
    if (env.MALWARE_SCANNER === 'fake') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MALWARE_SCANNER'],
        message: 'the fake scanner is for tests; production must scan with clamav',
      });
    }
    // The double accepts every message and sends none. In production that
    // would be PalCert silently swallowing notifications while recording them
    // as delivered — worse than not sending, because the record would lie.
    if (env.NOTIFICATION_EMAIL_PROVIDER === 'fake') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NOTIFICATION_EMAIL_PROVIDER'],
        message: 'the fake email provider is for tests only and must never serve production',
      });
    }
    if (env.STORAGE_SERVER_SIDE_ENCRYPTION === 'none') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_SERVER_SIDE_ENCRYPTION'],
        message: 'documents must be encrypted at rest in production (AES256 or aws:kms)',
      });
    }
    const buckets = [env.STORAGE_BUCKET, env.STORAGE_QUARANTINE_BUCKET, env.STORAGE_DERIVED_BUCKET];
    if (new Set(buckets).size !== buckets.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_QUARANTINE_BUCKET'],
        message: 'clean, quarantine and derived storage must be three separate buckets',
      });
    }
    if (!env.STORAGE_ENDPOINT.startsWith('https://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_ENDPOINT'],
        message: 'object storage must be reached over TLS in production',
      });
    }
    if (!env.APP_PUBLIC_WEB_URL.startsWith('https://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APP_PUBLIC_WEB_URL'],
        message: 'must be an https URL in production',
      });
    }
    // Where a browser sends an upload (Phase 20 Checkpoint 9).
    //
    // Every presigned URL is signed for this origin, and the browser that
    // uses it is running the web app, whose Content Security Policy allows
    // `connect-src 'self'` and nothing else (Checkpoint 20.7). So a presigned
    // URL on any other origin is one the browser refuses to send: the upload
    // fails in the browser, after the API has already said yes. Checkpoint
    // 20.9 found exactly that in the release topology, where this variable
    // defaulted to an unpublished `https://localhost:9000` and no document
    // could be uploaded through the UI at all.
    //
    // Required and pinned to the web origin, so a deployment that cannot
    // upload refuses to boot instead of failing on its first user. The proxy
    // in front of the web app routes the bucket paths to object storage.
    const storageOrigin = originOf(env.STORAGE_PUBLIC_ENDPOINT);
    const webOrigin = originOf(env.APP_PUBLIC_WEB_URL);
    if (env.STORAGE_PUBLIC_ENDPOINT === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_PUBLIC_ENDPOINT'],
        message:
          'required in production: the origin browsers upload to, which must be APP_PUBLIC_WEB_URL',
      });
    } else if (
      storageOrigin === undefined ||
      storageOrigin !== webOrigin ||
      new URL(env.STORAGE_PUBLIC_ENDPOINT).pathname !== '/'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_PUBLIC_ENDPOINT'],
        message:
          "must be the origin of APP_PUBLIC_WEB_URL with no path: the web app's " +
          'Content Security Policy only lets a browser connect to its own origin',
      });
    }
    // A session must never outlive its own hard ceiling.
    if (env.AUTH_SESSION_IDLE_MINUTES > env.AUTH_SESSION_ABSOLUTE_MINUTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_SESSION_IDLE_MINUTES'],
        message: 'idle timeout cannot exceed the absolute session lifetime',
      });
    }
  });

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const webEnvSchema = z.object({
  NODE_ENV: NodeEnv.default('development'),
  NEXT_PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  NEXT_PUBLIC_APP_NAME: z.string().min(1).default('PalCert'),
  NEXT_PUBLIC_DEFAULT_LOCALE: z.enum(['en', 'ar']).default('en'),
});

export type WebEnv = z.infer<typeof webEnvSchema>;
