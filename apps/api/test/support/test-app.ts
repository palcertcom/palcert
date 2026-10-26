import type { INestApplication } from '@nestjs/common';
import { registerStandardImportBodyParser } from '../../src/modules/standards/transfer-body-parser';
import { Test } from '@nestjs/testing';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { API_VERSION, CSRF_HEADER_NAME } from '@palcert/contracts';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { PrismaClient } from '@palcert/database';
import { AppModule } from '../../src/app.module';
import { ApiConfigService } from '../../src/config/api-config.service';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { RedisService } from '../../src/infrastructure/redis/redis.service';
import { ClockPort, FakeClock } from '../../src/modules/auth/ports/clock.port';
import { ManagedMailDelivery } from '../../src/modules/auth/mail/managed-mail-delivery';
import {
  InMemoryMailOutbox,
  MailDeliveryPort,
  type MailMessage,
} from '../../src/modules/auth/ports/mail.port';

/** Records like the outbox, then forwards to the real adapter. */
export class TeeMailOutbox extends InMemoryMailOutbox {
  constructor(readonly managed: ManagedMailDelivery) {
    super();
  }

  override async send(message: MailMessage): Promise<void> {
    await super.send(message);
    await this.managed.send(message);
  }
}
import { OutboxDispatcher } from '../../src/infrastructure/queue/outbox-dispatcher';
import { ProcessingJobService } from '../../src/infrastructure/queue/processing-job.service';
import { ProcessingQueue } from '../../src/infrastructure/queue/processing-queue';
import { FakeMalwareScanner } from '../../src/infrastructure/scanner/fake-scanner';
import { MalwareScannerPort } from '../../src/infrastructure/scanner/malware-scanner.port';
import { ObjectStoragePort } from '../../src/infrastructure/storage/object-storage.port';
import { S3ObjectStorage } from '../../src/infrastructure/storage/s3-object-storage';
import { UploadSessionSweeper } from '../../src/modules/documents/services/upload-session-sweeper';
import { WorkerModule } from '../../src/worker/worker.module';
import { WorkerService } from '../../src/worker/worker.service';
import { NotificationSweeper } from '../../src/worker/notification-sweeper';
import { DocumentEnginePort } from '../../src/infrastructure/document-engine/document-engine.port';
import {
  AIProviderPort,
  NotificationEmailProviderPort,
  PaymentProviderPort,
} from '@palcert/contracts';
import { FakePaymentProvider } from '../../src/infrastructure/payments/fake-payment-provider';
import { FakeAIProvider } from '../../src/infrastructure/ai/fake-ai-provider';
import { FakeEmailProvider } from '../../src/infrastructure/notifications/fake-email-provider';
import { FakeDocumentEngine } from './fake-document-engine';
import { FaultInjectingObjectStorage } from './fault-injecting-storage';
import { applyTestEnvironment, type TestEnvironmentOverrides } from './test-environment';

export interface TestContext {
  readonly app: INestApplication;
  /** The request-path client: least-privileged, subject to row-level security. */
  readonly prisma: PrismaService;
  /**
   * The schema-owning client, for fixtures and assertions that must see across
   * tenants. Using it in a test that is *about* isolation would defeat the
   * point, so tests assert through `prisma` or through HTTP.
   */
  readonly adminDb: PrismaClient;
  readonly redis: RedisService;
  readonly clock: FakeClock;
  readonly outbox: InMemoryMailOutbox;
  /** The real S3-compatible adapter behind a per-operation outage switch. */
  readonly storage: FaultInjectingObjectStorage;
  /** The fake scanner behind the real port; flip `mode` for an outage. */
  readonly scanner: FakeMalwareScanner;
  /** The analyzer double shared by the API and the worker. */
  readonly documentEngine: FakeDocumentEngine;
  /** The AI provider double shared by the API and the worker. */
  readonly aiProvider: FakeAIProvider;
  readonly paymentProvider: FakePaymentProvider;
  /** The mail transport double shared by the API and the worker (Phase 16). */
  readonly emailProvider: FakeEmailProvider;
  /** A live worker process, in-process, consuming the same queue. */
  readonly workerApp: INestApplication;
  readonly worker: WorkerService;
  readonly dispatcher: OutboxDispatcher;
  readonly jobs: ProcessingJobService;
  readonly queue: ProcessingQueue;
  readonly sweeper: UploadSessionSweeper;
  /** Phase 16: revives deliveries the job ladder gave up on. */
  readonly notificationSweeper: NotificationSweeper;
  readonly restoreEnv: () => void;
}

/**
 * Boot the real application with three deterministic substitutions:
 *
 *  - `ClockPort` → FakeClock, so expiry is tested by advancing time explicitly
 *    rather than by sleeping.
 *  - `MailDeliveryPort` → InMemoryMailOutbox, so verification and reset tokens
 *    are asserted without an external provider.
 *
 * Everything else — guards, filters, pipes, middleware order — is identical to
 * production, because security behaviour that is only true in tests is worthless.
 */
export async function createTestContext(
  envOverrides: TestEnvironmentOverrides = {},
  options: {
    /**
     * Keep the application's own `MailDeliveryPort` (the admin-managed email
     * adapter) instead of the in-memory outbox. Only the email-delivery suite
     * wants this; it points the provider at a local fake, never at Resend.
     */
    readonly realMailDelivery?: boolean;
  } = {},
): Promise<TestContext> {
  const restoreEnv = applyTestEnvironment(envOverrides);

  // One clock, one scanner, one storage for both processes, so a test that
  // advances time or injects an outage affects the API and the worker alike.
  const clock = new FakeClock(new Date('2026-06-01T12:00:00.000Z'));
  const scanner = new FakeMalwareScanner();
  const storage = new FaultInjectingObjectStorage(buildStorageFromEnvironment());
  const documentEngine = new FakeDocumentEngine();
  const aiProvider = new FakeAIProvider();
  const paymentProvider = new FakePaymentProvider();
  const emailProvider = new FakeEmailProvider();

  /**
   * A suite that boots with payments *off* gets the real provider wiring.
   *
   * Every other suite is handed the double, because the financial tests are
   * about ledgers and holds rather than about Stripe. But substituting a
   * working provider into a deployment that is supposed to have none would
   * hide exactly what a payments-disabled test is for: that the factory does
   * not construct an adapter, does not need a credential, and answers with a
   * deliberate contract. So when `PAYMENTS_ENABLED=false`, the override is
   * skipped and the application resolves its own provider (Phase 20
   * Checkpoint 7).
   */
  const overridePaymentProvider = process.env['PAYMENTS_ENABLED'] !== 'false';

  const withPaymentDouble = <
    T extends { overrideProvider: (token: unknown) => { useValue: (value: unknown) => T } },
  >(
    builder: T,
  ): T =>
    overridePaymentProvider
      ? builder.overrideProvider(PaymentProviderPort).useValue(paymentProvider)
      : builder;

  // With `realMailDelivery`, every message is still recorded in the outbox (so
  // the sign-up helpers can read tokens) *and* handed to the application's own
  // admin-managed adapter, which the email suite points at a local fake.
  const withMailDouble = <
    T extends {
      overrideProvider: (token: unknown) => {
        useClass: (value: unknown) => T;
        useFactory: (options: { factory: (...args: never[]) => unknown; inject: unknown[] }) => T;
      };
    },
  >(
    builder: T,
  ): T =>
    options.realMailDelivery === true
      ? builder.overrideProvider(MailDeliveryPort).useFactory({
          factory: (managed: ManagedMailDelivery) => new TeeMailOutbox(managed),
          inject: [ManagedMailDelivery],
        })
      : builder.overrideProvider(MailDeliveryPort).useClass(InMemoryMailOutbox);

  const moduleRef = await withPaymentDouble(
    withMailDouble(
      Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ClockPort)
        .useValue(clock),
    )
      .overrideProvider(MalwareScannerPort)
      .useValue(scanner)
      .overrideProvider(ObjectStoragePort)
      .useValue(storage)
      .overrideProvider(DocumentEnginePort)
      .useValue(documentEngine)
      .overrideProvider(AIProviderPort)
      .useValue(aiProvider),
  )
    .overrideProvider(NotificationEmailProviderPort)
    .useValue(emailProvider)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bufferLogs: true,
    // Must match `createApp` exactly: a payment provider signs the bytes it
    // sent, so the raw body has to survive parsing here too. Without it the
    // webhook suites would pass against a harness that does not resemble
    // production (Phase 10 §48).
    rawBody: true,
  });
  app.useLogger(app.get(Logger));

  const config = app.get(ApiConfigService);

  // Mirror bootstrap.ts exactly.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: false,
    }),
  );
  app.disable('x-powered-by');
  // The same value production computes, not a hard-coded `1`. A harness that
  // trusts more than the deployment does turns the forwarded-header tests into
  // tests of the harness (Phase 20 Checkpoint 7).
  app.set('trust proxy', config.trustedProxies);
  app.use(cookieParser());
  // Portable standard packages are the only bodies allowed past the default
  // 100 kB limit, and only on their two routes.
  registerStandardImportBodyParser(app);
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    allowedHeaders: ['content-type', 'accept', CSRF_HEADER_NAME, 'x-request-id'],
    maxAge: 600,
  });
  app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready', 'metrics'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_VERSION.replace('v', '') });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  await app.init();

  const adminDb = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_ADMIN_URL! } },
    log: ['warn', 'error'],
  });
  await adminDb.$connect();

  // The worker, exactly as deployed: its own Nest application on the same
  // queue, with only the test doubles the API also has.
  const workerRef = await withPaymentDouble(
    Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(ClockPort)
      .useValue(clock)
      .overrideProvider(MalwareScannerPort)
      .useValue(scanner)
      .overrideProvider(ObjectStoragePort)
      .useValue(storage)
      .overrideProvider(DocumentEnginePort)
      .useValue(documentEngine)
      .overrideProvider(AIProviderPort)
      .useValue(aiProvider),
  )
    .overrideProvider(NotificationEmailProviderPort)
    .useValue(emailProvider)
    .compile();
  const workerApp = workerRef.createNestApplication({ bufferLogs: true });
  workerApp.useLogger(workerApp.get(Logger));
  await workerApp.init();

  return {
    app,
    adminDb,
    prisma: app.get(PrismaService),
    redis: app.get(RedisService),
    clock,
    outbox: app.get(MailDeliveryPort) as InMemoryMailOutbox,
    storage,
    scanner,
    documentEngine,
    aiProvider,
    paymentProvider,
    emailProvider,
    workerApp,
    worker: workerApp.get(WorkerService),
    dispatcher: app.get(OutboxDispatcher),
    jobs: app.get(ProcessingJobService),
    queue: app.get(ProcessingQueue),
    sweeper: app.get(UploadSessionSweeper),
    notificationSweeper: workerApp.get(NotificationSweeper),
    restoreEnv,
  };
}

/** The real adapter against whatever S3-compatible service the environment names. */
function buildStorageFromEnvironment(): S3ObjectStorage {
  const env = process.env;
  return new S3ObjectStorage({
    endpoint: env.STORAGE_ENDPOINT!,
    publicEndpoint: env.STORAGE_PUBLIC_ENDPOINT ?? env.STORAGE_ENDPOINT!,
    region: env.STORAGE_REGION ?? 'us-east-1',
    accessKeyId: env.STORAGE_ACCESS_KEY_ID!,
    secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY!,
    forcePathStyle: true,
    buckets: {
      derived: process.env['STORAGE_DERIVED_BUCKET'] ?? 'palcert-test-derived',
      quarantine: env.STORAGE_QUARANTINE_BUCKET!,
      clean: env.STORAGE_BUCKET!,
    },
    serverSideEncryption: 'none',
    kmsKeyId: undefined,
    requestTimeoutMs: 10_000,
  });
}

/**
 * Reset all mutable state between tests.
 *
 * The role and permission catalogue is deliberately preserved: it is seeded by
 * migration and is reference data, not test state.
 */
export async function resetState(context: TestContext): Promise<void> {
  // Drain the queue *before* truncating. The context runs a real worker, so a
  // job still in flight holds row locks on the very tables the TRUNCATE wants
  // an exclusive lock on, and the two deadlock. Emptying the queue first means
  // there is nothing left to be in flight.
  await context.queue.obliterate();

  // Obliterating empties the queue but cannot un-start a job already running,
  // and since Phase 11 a single check creation enqueues one more of them. A
  // job mid-transaction holds row locks the TRUNCATE needs exclusively, so
  // give the worker a moment to finish rather than racing it into a deadlock.
  await waitForQuietWorker(context);

  // Truncation needs the owning identity: the application role deliberately
  // cannot do DDL, and row-level security would confine a DELETE anyway.
  await truncateAll(
    context,
    `
    TRUNCATE TABLE
      "service_purchase_allocations", "service_purchases",
      "payment_provider_events", "payment_disputes", "payment_refunds",
      "balance_topups", "price_quotes", "price_versions",
      "credit_holds", "credit_ledger_entries", "customer_credit_accounts",
      "standard_rule_provenance", "rule_proposal_decisions", "rule_proposal_evidence",
      "rule_proposals", "template_observations", "source_evidence",
      "extraction_invocations", "rule_extraction_run_sources", "rule_extraction_runs",
      "standard_source_assets", "organization_ai_consents",
      "ai_report_supplements", "ai_rule_assessments", "ai_invocations",
      "ai_reviews", "ai_consents",
      "check_violations", "check_rule_results", "check_reports", "check_runs",
      "document_checks",
      "document_analyses", "document_retention_locks", "upload_sessions",
      "document_versions", "documents",
      "processing_jobs",
      "standard_version_snapshots", "standard_rules", "standard_versions",
      "standards", "document_types",
      "security_events", "audit_events", "sessions",
      "email_verification_tokens", "password_reset_tokens",
      "mfa_authenticators", "mfa_recovery_codes",
      "organization_invitations", "organization_verification_requests",
      "organization_memberships", "organizations",
      "user_roles", "users"
    RESTART IDENTITY CASCADE
  `,
  );

  // TRUNCATE ... CASCADE through "users" also empties the withdrawal policy
  // singleton (it records who last changed it); put the defaults back.
  await context.adminDb.$executeRawUnsafe(
    `INSERT INTO "withdrawal_policy" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING`,
  );

  const throttleKeys = await context.redis.client.keys('palcert:throttle:*');
  if (throttleKeys.length > 0) {
    await context.redis.client.del(...throttleKeys);
  }

  context.storage.failing.clear();
  context.storage.corrupting.clear();
  context.storage.corruptingStreams.clear();
  context.scanner.mode = 'normal';
  context.scanner.scannedSizes.length = 0;
  context.documentEngine.reset();
  context.aiProvider.reset();
  context.paymentProvider.reset();
  context.emailProvider.reset();

  context.outbox.clear();
  context.clock.set(new Date('2026-06-01T12:00:00.000Z'));
}

export async function destroyTestContext(context: TestContext): Promise<void> {
  await context.adminDb.$disconnect();
  await context.workerApp.close();
  await context.app.close();
  context.restoreEnv();
}

/**
 * Wait for the worker to stop holding row locks.
 *
 * Bounded and best-effort: if a job really is stuck, the TRUNCATE retry below
 * is the backstop. Waiting here just makes that rare.
 */
async function waitForQuietWorker(context: TestContext, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = await context.adminDb.processingJob.count({
      where: { status: { in: ['DISPATCHED', 'RUNNING'] } },
    });
    if (running === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * TRUNCATE, retrying a deadlock.
 *
 * A deadlock here is never a product defect: it is the test harness competing
 * with its own worker for locks on the way *out* of a test. Retrying is the
 * honest response — failing the next test because the previous one was still
 * tidying up would hide real failures behind noise.
 */
async function truncateAll(context: TestContext, sql: string, attempts = 4): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await context.adminDb.$executeRawUnsafe(sql);
      return;
    } catch (error) {
      const deadlocked = String(error).includes('deadlock detected');
      if (!deadlocked || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}
