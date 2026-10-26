import { Injectable } from '@nestjs/common';
import type { ApiEnv } from '@palcert/config';
import { FACT_SCHEMA_VERSION } from '@palcert/contracts';

/**
 * Typed, read-only access to validated configuration.
 *
 * Business code must depend on this service rather than reading
 * `process.env` directly (§46: centralized configuration).
 */
@Injectable()
export class ApiConfigService {
  constructor(private readonly env: ApiEnv) {}

  get nodeEnv(): ApiEnv['NODE_ENV'] {
    return this.env.NODE_ENV;
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  get appName(): string {
    return this.env.APP_NAME;
  }

  /**
   * Which build this is, for the health responses.
   *
   * Both halves are baked into the image at build time. A process started from
   * source reports neither, which is correct — it is not a release.
   */
  get release(): { commit?: string; builtAt?: string } {
    return {
      ...(this.env.APP_COMMIT !== undefined ? { commit: this.env.APP_COMMIT } : {}),
      ...(this.env.APP_BUILT_AT !== undefined ? { builtAt: this.env.APP_BUILT_AT } : {}),
    };
  }

  get appVersion(): string {
    return this.env.APP_VERSION;
  }

  get logLevel(): ApiEnv['LOG_LEVEL'] {
    return this.env.LOG_LEVEL;
  }

  get logPretty(): boolean {
    return this.env.LOG_PRETTY;
  }

  get port(): number {
    return this.env.API_PORT;
  }

  get host(): string {
    return this.env.API_HOST;
  }

  get corsOrigins(): string[] {
    return this.env.API_CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
  }

  /**
   * The Express `trust proxy` setting, as a value that middleware can use
   * directly (Phase 20 Checkpoint 7).
   *
   * `false` — the default when nothing is configured — means no forwarded
   * header is believed at all and `req.ip` is the address that actually opened
   * the socket. Anything else is the explicit list of upstreams permitted to
   * speak for a client.
   */
  get trustedProxies(): string[] | false {
    const configured = this.env.API_TRUSTED_PROXIES;
    if (configured === undefined) return false;
    const entries = configured
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return entries.length > 0 ? entries : false;
  }

  get rateLimit(): { ttlSeconds: number; limit: number } {
    return {
      ttlSeconds: this.env.API_RATE_LIMIT_TTL_SECONDS,
      limit: this.env.API_RATE_LIMIT_LIMIT,
    };
  }

  get docsEnabled(): boolean {
    return this.env.API_DOCS_ENABLED;
  }

  /**
   * Telemetry exposure (Phase 20 Checkpoint 3).
   *
   * `token` is `undefined` when the deployment relies on network topology
   * alone — which the release stack does, because the reverse proxy has no
   * route to `/metrics`.
   */
  get metrics(): { readonly enabled: boolean; readonly token: string | undefined } {
    return { enabled: this.env.METRICS_ENABLED, token: this.env.METRICS_TOKEN };
  }

  get databaseUrl(): string {
    return this.env.DATABASE_URL;
  }

  /** Whether to refuse booting when the request-path DB role can bypass RLS. */
  get enforceDatabaseLeastPrivilege(): boolean {
    return this.env.DATABASE_ENFORCE_LEAST_PRIVILEGE;
  }

  get redisUrl(): string {
    return this.env.REDIS_URL;
  }

  get documentEngineUrl(): string {
    return this.env.DOCUMENT_ENGINE_URL;
  }

  /** Object storage (Phase 5). Secrets stay inside this object; never log it. */
  get storage(): {
    endpoint: string;
    publicEndpoint: string;
    region: string;
    cleanBucket: string;
    quarantineBucket: string;
    derivedBucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
    serverSideEncryption: 'none' | 'AES256' | 'aws:kms';
    kmsKeyId: string | undefined;
    requestTimeoutMs: number;
    uploadUrlTtlSeconds: number;
    downloadUrlTtlSeconds: number;
  } {
    return {
      endpoint: this.env.STORAGE_ENDPOINT,
      publicEndpoint: this.env.STORAGE_PUBLIC_ENDPOINT ?? this.env.STORAGE_ENDPOINT,
      region: this.env.STORAGE_REGION,
      cleanBucket: this.env.STORAGE_BUCKET,
      quarantineBucket: this.env.STORAGE_QUARANTINE_BUCKET,
      derivedBucket: this.env.STORAGE_DERIVED_BUCKET,
      accessKeyId: this.env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: this.env.STORAGE_SECRET_ACCESS_KEY,
      forcePathStyle: this.env.STORAGE_FORCE_PATH_STYLE,
      serverSideEncryption: this.env.STORAGE_SERVER_SIDE_ENCRYPTION,
      kmsKeyId: this.env.STORAGE_KMS_KEY_ID,
      requestTimeoutMs: this.env.STORAGE_REQUEST_TIMEOUT_MS,
      uploadUrlTtlSeconds: this.env.STORAGE_UPLOAD_URL_TTL_SECONDS,
      downloadUrlTtlSeconds: this.env.STORAGE_DOWNLOAD_URL_TTL_SECONDS,
    };
  }

  /** Analysis identity and limits (Phase 6). */
  get analysis(): {
    factSchemaVersion: number;
    maxSourceBytes: number;
    maxArtifactBytes: number;
  } {
    return {
      // The schema the analyzer this release ships with produces. Stored on
      // every analysis so a stale artifact is never mistaken for a current one.
      factSchemaVersion: FACT_SCHEMA_VERSION,
      // The artifact envelope version is deliberately *not* here: Phase 18
      // left DOCX and PDF on different envelopes, so it belongs to the
      // analyzer rather than to the release.
      maxSourceBytes: this.env.ANALYSIS_MAX_SOURCE_BYTES,
      maxArtifactBytes: this.env.ANALYSIS_MAX_ARTIFACT_BYTES,
    };
  }

  /** The Python analyzer (Phase 6). Internal service, never a browser origin. */
  get documentEngine(): {
    baseUrl: string;
    analysisTimeoutMs: number;
    evaluationTimeoutMs: number;
    readinessTimeoutMs: number;
    maxSourceBytes: number;
    maxArtifactBytes: number;
  } {
    return {
      baseUrl: this.env.DOC_ENGINE_URL.replace(/\/+$/, ''),
      analysisTimeoutMs: this.env.DOC_ENGINE_ANALYSIS_TIMEOUT_MS,
      evaluationTimeoutMs: this.env.DOC_ENGINE_EVALUATION_TIMEOUT_MS,
      readinessTimeoutMs: this.env.DOC_ENGINE_READINESS_TIMEOUT_MS,
      maxSourceBytes: this.env.ANALYSIS_MAX_SOURCE_BYTES,
      maxArtifactBytes: this.env.ANALYSIS_MAX_ARTIFACT_BYTES,
    };
  }

  /** Check orchestration limits (Phase 7). */
  get checks(): {
    maxStoredViolationsPerRule: number;
    maxReturnedViolationsPerRule: number;
    maxPageSize: number;
  } {
    return {
      maxStoredViolationsPerRule: this.env.CHECK_MAX_STORED_VIOLATIONS_PER_RULE,
      maxReturnedViolationsPerRule: this.env.CHECK_MAX_RETURNED_VIOLATIONS_PER_RULE,
      maxPageSize: this.env.CHECK_MAX_PAGE_SIZE,
    };
  }

  /**
   * AI review (Phase 8).
   *
   * The API key is deliberately absent from this getter and from every view of
   * configuration: it is read once, by the provider adapter, and never travels
   * anywhere else (§8).
   */
  get ai(): {
    enabled: boolean;
    provider: 'anthropic' | 'fake';
    model: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxRulesPerRequest: number;
    maxContextChars: number;
    maxNodeChars: number;
    maxContextNodes: number;
    maxAttempts: number;
    retryBaseMs: number;
    retryMaxMs: number;
    retentionPolicy: string;
    policyUrl: string | undefined;
  } {
    return {
      enabled: this.env.AI_ENABLED,
      provider: this.env.AI_PRIMARY_PROVIDER,
      model: this.env.ANTHROPIC_MODEL,
      maxInputTokens: this.env.AI_MAX_INPUT_TOKENS,
      maxOutputTokens: this.env.AI_MAX_OUTPUT_TOKENS,
      maxRulesPerRequest: this.env.AI_MAX_RULES_PER_REQUEST,
      maxContextChars: this.env.AI_MAX_CONTEXT_CHARS,
      maxNodeChars: this.env.AI_MAX_NODE_CHARS,
      maxContextNodes: this.env.AI_MAX_CONTEXT_NODES,
      maxAttempts: this.env.AI_MAX_ATTEMPTS,
      retryBaseMs: this.env.AI_RETRY_BASE_MS,
      retryMaxMs: this.env.AI_RETRY_MAX_MS,
      retentionPolicy: this.env.AI_PROVIDER_RETENTION_POLICY,
      policyUrl: this.env.AI_PROVIDER_POLICY_URL,
    };
  }

  /**
   * Rule extraction budgets (Phase 9, §134).
   *
   * Separate from `ai` because they bound a different thing: what PalCert will
   * read *out of* an institution's guideline, rather than what it will say
   * about a student's thesis.
   */
  get extraction(): {
    maxSources: number;
    maxPdfBytes: number;
    maxSourcePages: number;
    maxDocxTextChars: number;
    maxDocxBlocks: number;
    maxEvidenceBlocks: number;
    maxEvidenceChars: number;
    maxTemplateObservations: number;
    maxProposals: number;
    maxContextChars: number;
  } {
    return {
      maxSources: this.env.AI_EXTRACTION_MAX_SOURCES,
      maxPdfBytes: this.env.AI_EXTRACTION_MAX_PDF_BYTES,
      maxSourcePages: this.env.AI_EXTRACTION_MAX_SOURCE_PAGES,
      maxDocxTextChars: this.env.AI_EXTRACTION_MAX_DOCX_TEXT_CHARS,
      maxDocxBlocks: this.env.AI_EXTRACTION_MAX_DOCX_BLOCKS,
      maxEvidenceBlocks: this.env.AI_EXTRACTION_MAX_EVIDENCE_BLOCKS,
      maxEvidenceChars: this.env.AI_EXTRACTION_MAX_EVIDENCE_CHARS,
      maxTemplateObservations: this.env.AI_EXTRACTION_MAX_TEMPLATE_OBSERVATIONS,
      maxProposals: this.env.AI_EXTRACTION_MAX_PROPOSALS,
      maxContextChars: this.env.AI_EXTRACTION_MAX_CONTEXT_CHARS,
    };
  }

  /**
   * Payments, the credit balance and pricing (Phase 10).
   *
   * Deliberately carries no provider credential: the secret lives in
   * `stripe` below, held only by the adapter that must have it.
   */
  get payments(): {
    enabled: boolean;
    provider: 'stripe' | 'fake';
    enabledCurrencies: readonly string[];
    defaultCurrency: string;
    successUrl: string;
    cancelUrl: string;
    topUpMinMinor: bigint;
    topUpMaxMinor: bigint;
    topUpSessionTtlSeconds: number;
    holdTtlSeconds: number;
    /** Phase 11: how long a paid check's reservation stands (§25). */
    checkReservationTtlSeconds: number;
    /** ADR-0149: how long an AI service's reservation stands. */
    aiReservationTtlSeconds: number;
    quoteTtlSeconds: number;
    reconcileAfterSeconds: number;
    providerTimeoutMs: number;
  } {
    return {
      enabled: this.env.PAYMENTS_ENABLED,
      provider: this.env.PAYMENT_PROVIDER,
      // Intersected with the code's registry at the service layer, so a
      // deployment can narrow this list but never widen it to a currency
      // PalCert has no exponent for (§5).
      enabledCurrencies: this.env.PALCERT_ENABLED_CURRENCIES.split(',').map((code) => code.trim()),
      defaultCurrency: this.env.PALCERT_DEFAULT_CURRENCY,
      successUrl: this.env.PAYMENT_SUCCESS_URL,
      cancelUrl: this.env.PAYMENT_CANCEL_URL,
      // Bounds are bigints from here on: nothing downstream should have to
      // remember that a money amount arrived as a JavaScript number.
      topUpMinMinor: BigInt(this.env.TOPUP_MIN_MINOR),
      topUpMaxMinor: BigInt(this.env.TOPUP_MAX_MINOR),
      topUpSessionTtlSeconds: this.env.TOPUP_SESSION_TTL_SECONDS,
      holdTtlSeconds: this.env.CREDIT_HOLD_TTL_SECONDS,
      checkReservationTtlSeconds: this.env.CHECK_RESERVATION_TTL_SECONDS,
      aiReservationTtlSeconds: this.env.AI_RESERVATION_TTL_SECONDS,
      quoteTtlSeconds: this.env.PRICE_QUOTE_TTL_SECONDS,
      reconcileAfterSeconds: this.env.PAYMENT_RECONCILE_AFTER_SECONDS,
      providerTimeoutMs: this.env.PAYMENT_PROVIDER_TIMEOUT_MS,
    };
  }

  /**
   * The Stripe adapter's own settings, including its credentials.
   *
   * Separated from `payments` for the same reason `anthropic` is separated
   * from `ai`: the only code holding a secret should be the code that cannot
   * work without it. Nothing here is ever logged or serialized (§37).
   */
  get stripe(): {
    secretKey: string | undefined;
    webhookSecret: string | undefined;
    apiVersion: string;
    baseUrl: string | undefined;
    timeoutMs: number;
  } {
    return {
      secretKey: this.env.STRIPE_SECRET_KEY,
      webhookSecret: this.env.STRIPE_WEBHOOK_SECRET,
      apiVersion: this.env.STRIPE_API_VERSION,
      baseUrl: this.env.STRIPE_BASE_URL,
      timeoutMs: this.env.PAYMENT_PROVIDER_TIMEOUT_MS,
    };
  }

  /**
   * The Anthropic adapter's own settings, including the credential.
   *
   * Separated from `ai` so that the only code holding the key is the code that
   * must (§8). Nothing here is ever logged or serialized.
   */
  get anthropic(): {
    apiKey: string | undefined;
    model: string;
    maxOutputTokens: number;
    timeoutMs: number;
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined;
    baseUrl: string | undefined;
  } {
    return {
      apiKey: this.env.ANTHROPIC_API_KEY,
      model: this.env.ANTHROPIC_MODEL,
      maxOutputTokens: this.env.ANTHROPIC_MAX_OUTPUT_TOKENS,
      timeoutMs: this.env.ANTHROPIC_TIMEOUT_MS,
      effort: this.env.ANTHROPIC_EFFORT,
      baseUrl: this.env.ANTHROPIC_BASE_URL,
    };
  }

  /** Upload and ingestion limits (Phase 5). One place for every number. */
  get upload(): {
    maxBytesByFormat: { DOCX: number; PDF: number };
    sessionTtlSeconds: number;
    sweepIntervalMs: number;
    archive: {
      maxEntries: number;
      maxEntryBytes: number;
      maxTotalBytes: number;
      maxCompressionRatio: number;
      maxInspectedPartBytes: number;
    };
    validationTimeoutMs: number;
    scanTimeoutMs: number;
  } {
    return {
      maxBytesByFormat: {
        DOCX: this.env.UPLOAD_MAX_DOCX_BYTES,
        PDF: this.env.UPLOAD_MAX_PDF_BYTES,
      },
      sessionTtlSeconds: this.env.UPLOAD_SESSION_TTL_SECONDS,
      sweepIntervalMs: this.env.UPLOAD_SWEEP_INTERVAL_MS,
      archive: {
        maxEntries: this.env.INGEST_MAX_ARCHIVE_ENTRIES,
        maxEntryBytes: this.env.INGEST_MAX_ARCHIVE_ENTRY_BYTES,
        maxTotalBytes: this.env.INGEST_MAX_ARCHIVE_TOTAL_BYTES,
        maxCompressionRatio: this.env.INGEST_MAX_COMPRESSION_RATIO,
        maxInspectedPartBytes: this.env.INGEST_MAX_INSPECTED_PART_BYTES,
      },
      validationTimeoutMs: this.env.INGEST_VALIDATION_TIMEOUT_MS,
      scanTimeoutMs: this.env.INGEST_SCAN_TIMEOUT_MS,
    };
  }

  get queue(): {
    maxAttempts: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    leaseSeconds: number;
    workerConcurrency: number;
    workerPort: number;
    workerHost: string;
  } {
    return {
      maxAttempts: this.env.QUEUE_MAX_ATTEMPTS,
      backoffBaseMs: this.env.QUEUE_BACKOFF_BASE_MS,
      backoffMaxMs: this.env.QUEUE_BACKOFF_MAX_MS,
      leaseSeconds: this.env.QUEUE_LEASE_SECONDS,
      workerConcurrency: this.env.WORKER_CONCURRENCY,
      workerPort: this.env.WORKER_PORT,
      workerHost: this.env.WORKER_HOST,
    };
  }

  get scanner(): {
    kind: 'clamav' | 'fake';
    clamavHost: string;
    clamavPort: number;
    timeoutMs: number;
    chunkBytes: number;
  } {
    return {
      kind: this.env.MALWARE_SCANNER,
      clamavHost: this.env.CLAMAV_HOST,
      clamavPort: this.env.CLAMAV_PORT,
      timeoutMs: this.env.CLAMAV_TIMEOUT_MS,
      chunkBytes: this.env.CLAMAV_CHUNK_BYTES,
    };
  }

  /** Certificate attestation limits and retention. */
  get attestations(): {
    unattestedArtifactRetentionDays: number;
    maxOpenRequestsPerUser: number;
  } {
    return {
      unattestedArtifactRetentionDays: this.env.ATTESTATION_UNATTESTED_ARTIFACT_RETENTION_DAYS,
      maxOpenRequestsPerUser: this.env.ATTESTATION_MAX_OPEN_REQUESTS_PER_USER,
    };
  }

  get publicWebUrl(): string {
    return this.env.APP_PUBLIC_WEB_URL;
  }

  /**
   * Workflow notification email (Phase 16 §52, §115).
   *
   * Deliberately separate from the Phase 1 auth mail settings. Notification
   * mail must never be able to carry a credential, and keeping the transports
   * independent means a deployment can switch workflow mail off without
   * disabling the mail that lets people recover their accounts.
   */
  get notificationEmail(): {
    provider: 'disabled' | 'fake' | 'smtp';
    from: string | undefined;
    fromName: string;
    smtp: {
      host: string | undefined;
      port: number;
      secure: boolean;
      user: string | undefined;
      password: string | undefined;
      timeoutMs: number;
    };
  } {
    return {
      provider: this.env.NOTIFICATION_EMAIL_PROVIDER,
      from: this.env.NOTIFICATION_EMAIL_FROM,
      fromName: this.env.NOTIFICATION_EMAIL_FROM_NAME,
      smtp: {
        host: this.env.NOTIFICATION_SMTP_HOST,
        port: this.env.NOTIFICATION_SMTP_PORT,
        secure: this.env.NOTIFICATION_SMTP_SECURE,
        user: this.env.NOTIFICATION_SMTP_USER,
        password: this.env.NOTIFICATION_SMTP_PASSWORD,
        timeoutMs: this.env.NOTIFICATION_SMTP_TIMEOUT_MS,
      },
    };
  }

  /**
   * The domain PalCert puts on the right-hand side of a Message-ID.
   *
   * Taken from the configured sender, because a Message-ID's domain is the one
   * part of it that should name something the deployment actually controls —
   * never event data, never a user's address. The public web URL is the
   * fallback for a deployment that sends no mail but still renders message
   * ids in tests; `palcert.invalid` is the last resort, and `.invalid` is
   * reserved by RFC 2606 precisely so it can never resolve to somebody else.
   */
  get notificationEmailSenderDomain(): string {
    const from = this.env.NOTIFICATION_EMAIL_FROM;
    const fromDomain = from?.split('@')[1]?.trim();
    if (fromDomain !== undefined && fromDomain.length > 0) return fromDomain;

    try {
      const host = new URL(this.env.APP_PUBLIC_WEB_URL).hostname;
      if (host.length > 0) return host;
    } catch {
      // A malformed public URL is somebody else's error to report; a message
      // id is not the place to fail a delivery over it.
    }
    return 'palcert.invalid';
  }

  get notificationFanoutPageSize(): number {
    return this.env.NOTIFICATION_FANOUT_PAGE_SIZE;
  }

  // --- Admin-managed transactional email (ADR-0146) -------------------------

  /**
   * The root keyring that seals the provider credential an administrator
   * saves. Absent is legitimate: the dashboard then refuses to store a
   * credential and every send path behaves as it did before the feature.
   */
  /**
   * The payout-destination keyring (ADR-0150), or null when not configured —
   * in which case destinations can be read in masked form but never created
   * or changed.
   */
  get payoutDestinationEncryption(): { activeKid: string; keys: string } | null {
    const activeKid = this.env.PAYOUT_DESTINATION_ENCRYPTION_ACTIVE_KID;
    const keys = this.env.PAYOUT_DESTINATION_ENCRYPTION_KEYS;
    if (activeKid === undefined || keys === undefined) return null;
    return { activeKid, keys };
  }

  get emailSettingsEncryption(): { activeKid: string; keys: string } | null {
    const activeKid = this.env.EMAIL_SETTINGS_ENCRYPTION_ACTIVE_KID;
    const keys = this.env.EMAIL_SETTINGS_ENCRYPTION_KEYS;
    if (activeKid === undefined || keys === undefined) return null;
    return { activeKid, keys };
  }

  /**
   * Where the Resend API lives. Fixed in production (the schema refuses an
   * override there); tests point it at a local fake. Never read from the
   * database, so no administrator can redirect the credential.
   */
  get resend(): { baseUrl: string; timeoutMs: number } {
    return {
      baseUrl: this.env.RESEND_API_BASE_URL ?? 'https://api.resend.com',
      timeoutMs: this.env.RESEND_TIMEOUT_MS,
    };
  }

  get emailSettingsCacheMs(): number {
    return this.env.EMAIL_SETTINGS_CACHE_SECONDS * 1_000;
  }

  // --- Phase 17: outbound webhooks -----------------------------------------

  /**
   * Whether this deployment can encrypt webhook configuration at all.
   *
   * A deployment without a keyring may still run every other phase; what it
   * may not do is accept a webhook URL it cannot seal. Reported here so the
   * module refuses the feature at boot rather than storing a plaintext URL.
   */
  get webhooksEnabled(): boolean {
    return (
      this.env.WEBHOOK_ENCRYPTION_ACTIVE_KID !== undefined &&
      this.env.WEBHOOK_ENCRYPTION_KEYS !== undefined
    );
  }

  get webhookEncryptionActiveKid(): string | undefined {
    return this.env.WEBHOOK_ENCRYPTION_ACTIVE_KID;
  }

  get webhookEncryptionKeys(): string | undefined {
    return this.env.WEBHOOK_ENCRYPTION_KEYS;
  }

  /** Ports a tenant may target. 443 unless the platform says otherwise (§26). */
  get webhookAllowedPorts(): readonly number[] {
    const ports = this.env.WEBHOOK_ALLOWED_PORTS.split(',')
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isInteger(value) && value > 0 && value <= 65535);
    return ports.length > 0 ? ports : [443];
  }

  /**
   * PalCert's own hostnames, which no webhook may target (§26).
   *
   * Derived from the configured public URLs as well as the explicit list, so a
   * deployment that forgets the list still cannot be pointed at itself.
   */
  get webhookOwnHosts(): readonly string[] {
    const hosts = new Set<string>();
    for (const raw of this.env.WEBHOOK_OWN_HOSTS.split(',')) {
      const host = raw.trim().toLowerCase();
      if (host.length > 0) hosts.add(host);
    }
    for (const url of [this.env.APP_PUBLIC_WEB_URL]) {
      try {
        const host = new URL(url).hostname.toLowerCase();
        if (host.length > 0) hosts.add(host);
      } catch {
        // A malformed public URL is reported elsewhere; it must not stop the
        // rest of the own-host list from being enforced.
      }
    }
    return [...hosts];
  }

  get webhookHttpLimits(): {
    dnsTimeoutMs: number;
    connectTimeoutMs: number;
    tlsTimeoutMs: number;
    totalTimeoutMs: number;
    maxRequestBytes: number;
    maxResponseHeaderBytes: number;
  } {
    return {
      dnsTimeoutMs: this.env.WEBHOOK_DNS_TIMEOUT_MS,
      connectTimeoutMs: this.env.WEBHOOK_CONNECT_TIMEOUT_MS,
      tlsTimeoutMs: this.env.WEBHOOK_TLS_TIMEOUT_MS,
      totalTimeoutMs: this.env.WEBHOOK_TOTAL_TIMEOUT_MS,
      maxRequestBytes: this.env.WEBHOOK_MAX_REQUEST_BYTES,
      maxResponseHeaderBytes: this.env.WEBHOOK_MAX_RESPONSE_HEADER_BYTES,
    };
  }

  /** Session policy. Privileged roles get the stricter of the two. */
  get sessionPolicy(): {
    idleMinutes: number;
    absoluteMinutes: number;
    privilegedIdleMinutes: number;
    privilegedAbsoluteMinutes: number;
    pendingMfaMinutes: number;
    reauthWindowMinutes: number;
  } {
    return {
      idleMinutes: this.env.AUTH_SESSION_IDLE_MINUTES,
      absoluteMinutes: this.env.AUTH_SESSION_ABSOLUTE_MINUTES,
      privilegedIdleMinutes: this.env.AUTH_PRIVILEGED_SESSION_IDLE_MINUTES,
      privilegedAbsoluteMinutes: this.env.AUTH_PRIVILEGED_SESSION_ABSOLUTE_MINUTES,
      pendingMfaMinutes: this.env.AUTH_MFA_PENDING_MINUTES,
      reauthWindowMinutes: this.env.AUTH_REAUTH_WINDOW_MINUTES,
    };
  }

  get cookiePolicy(): {
    sameSite: 'strict' | 'lax' | 'none';
    secure: boolean;
    domain: string | undefined;
  } {
    return {
      sameSite: this.env.AUTH_COOKIE_SAMESITE,
      // Secure cookies require HTTPS, which local development does not use.
      secure: this.isProduction,
      domain: this.env.AUTH_COOKIE_DOMAIN,
    };
  }

  get tokenTtl(): { emailVerificationMinutes: number; passwordResetMinutes: number } {
    return {
      emailVerificationMinutes: this.env.AUTH_EMAIL_VERIFICATION_TTL_MINUTES,
      passwordResetMinutes: this.env.AUTH_PASSWORD_RESET_TTL_MINUTES,
    };
  }

  get passwordPolicy(): {
    minLength: number;
    maxLength: number;
    breachedCheckEnabled: boolean;
  } {
    return {
      minLength: this.env.AUTH_PASSWORD_MIN_LENGTH,
      maxLength: this.env.AUTH_PASSWORD_MAX_LENGTH,
      breachedCheckEnabled: this.env.AUTH_BREACHED_PASSWORD_CHECK_ENABLED,
    };
  }

  get argon2Options(): { memoryCost: number; timeCost: number; parallelism: number } {
    return {
      memoryCost: this.env.AUTH_ARGON2_MEMORY_KIB,
      timeCost: this.env.AUTH_ARGON2_TIME_COST,
      parallelism: this.env.AUTH_ARGON2_PARALLELISM,
    };
  }

  get throttlePolicy(): {
    loginPerAccount: number;
    loginPerIp: number;
    windowMinutes: number;
    mfaAttempts: number;
    passwordResetRequests: number;
  } {
    return {
      loginPerAccount: this.env.AUTH_LOGIN_MAX_ATTEMPTS_PER_ACCOUNT,
      loginPerIp: this.env.AUTH_LOGIN_MAX_ATTEMPTS_PER_IP,
      windowMinutes: this.env.AUTH_LOGIN_THROTTLE_WINDOW_MINUTES,
      mfaAttempts: this.env.AUTH_MFA_MAX_ATTEMPTS,
      passwordResetRequests: this.env.AUTH_PASSWORD_RESET_MAX_REQUESTS,
    };
  }

  /**
   * The key that seals a verification code between scheduling and issuance.
   *
   * Deliberately a separate key from the MFA one: they protect different
   * things with different lifetimes, and rotating one should not force the
   * other.
   */
  get certificateVerificationKey(): Buffer {
    return Buffer.from(this.env.CERTIFICATE_VERIFICATION_SECRET_KEY, 'base64');
  }

  /**
   * The key protecting an API-client secret during its show-once window.
   *
   * Separate from every other key in PalCert on purpose: it is the only one
   * that can turn stored bytes back into a working inbound credential.
   */
  get apiClientRevealKey(): Buffer {
    return Buffer.from(this.env.API_CLIENT_REVEAL_SECRET_KEY, 'base64');
  }

  get mfaPolicy(): { secretKey: Buffer; issuer: string; recoveryCodeCount: number } {
    return {
      secretKey: Buffer.from(this.env.AUTH_MFA_SECRET_KEY, 'base64'),
      issuer: this.env.AUTH_MFA_ISSUER,
      recoveryCodeCount: this.env.AUTH_MFA_RECOVERY_CODE_COUNT,
    };
  }
}
