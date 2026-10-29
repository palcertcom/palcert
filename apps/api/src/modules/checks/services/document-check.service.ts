import { Injectable } from '@nestjs/common';
import {
  AppError,
  CHECK_ORCHESTRATOR_VERSION,
  CheckStatus,
  DocumentAnalysisStatus,
  DocumentFormat,
  DocumentStatus,
  DocumentVersionStatus,
  PalCertErrorCode,
  ProcessingJobType,
  ServiceProductCode,
  ServiceResourceType,
  isCheckTerminal,
} from '@palcert/contracts';
import type { CheckRun, DocumentCheck } from '@palcert/database';
import { randomUUID } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import { OutboxDispatcher } from '../../../infrastructure/queue/outbox-dispatcher';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { DocumentAnalysisService } from '../../analysis/services/document-analysis.service';
import { ServicePurchaseService } from '../../finance/services/service-purchase.service';
import { CatalogueService } from './catalogue.service';
import { FormatCompatibilityService } from './format-compatibility.service';
import { PaidCheckSettlementService } from './paid-check-settlement.service';
import type { RequestContext } from '../../documents/services/document.service';

/**
 * Retention lock types, from the vocabulary Phase 5 minted for exactly this.
 *
 * `CHECK` pins the source version for as long as a check exists; `REPORT`
 * pins the analysis a written report cites. Both are values the Phase 5
 * constraint already knows, so a check does not need its own retention
 * language to say a thing Phase 5 already had a word for (§26, §71).
 */
export const CHECK_RETENTION_LOCK = 'CHECK';
export const ANALYSIS_RETENTION_LOCK = 'REPORT';

export interface CreateCheckInput {
  readonly documentVersionId: string;
  readonly standardId: string;
  /**
   * The server-authored quote that fixes the price (Phase 11 §13, §17).
   *
   * Required. The client names a quote it was given; it never states an
   * amount, and there is no code path that reads one from the request.
   */
  readonly priceQuoteId: string;
  readonly idempotencyKey?: string;
}

/**
 * Creating and driving document checks (§1–§6, §26–§29).
 *
 * Creation is where every binding is captured. After it, the check means one
 * thing for ever: this document version's bytes, this standard version's
 * rules. A user who wants a different version creates a different check (§5).
 *
 * Nothing here evaluates anything. Creation validates, captures, pins the
 * source against deletion, makes sure an analysis exists, and hands the work
 * to the Phase 5 outbox. The worker does the rest, because heavy work never
 * runs inside an HTTP request.
 */
@Injectable()
export class DocumentCheckService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly catalogue: CatalogueService,
    private readonly compatibility: FormatCompatibilityService,
    private readonly analyses: DocumentAnalysisService,
    private readonly purchases: ServicePurchaseService,
    private readonly settlement: PaidCheckSettlementService,
    private readonly jobs: ProcessingJobService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DocumentCheckService.name);
  }

  /**
   * Buy and start one check, in a single transaction (§19, §23).
   *
   * Everything commercial and everything structural commits together: the
   * quote is spent, the credit is reserved across as many accounts as it
   * takes, the purchase exists, the check exists, the source bytes are pinned
   * against deletion, and the durable intent to do the work is written to the
   * outbox. There is no ordering of these as separate commits that survives a
   * crash — a reservation with no check, or a check with no processing intent,
   * are both states a customer would have to ring support about (§22).
   *
   * The ids are preallocated so the purchase can name the check it pays for
   * and the check can name the purchase that paid, with no post-commit
   * rebinding step to go wrong (§20).
   */
  async create(
    userId: string,
    input: CreateCheckInput,
    request: RequestContext,
  ): Promise<DocumentCheck> {
    // A browser retry must not buy a second check; two deliberate checks of
    // the same document against the same standard are perfectly legitimate and
    // are not deduplicated (§61, §18).
    const replayed = await this.replayIdempotent(userId, input);
    if (replayed !== null) return replayed;

    // Eligibility is decided by the same function the catalogue lists by, so
    // a standard made private in between is refused rather than captured.
    const standard = await this.catalogue.checkableStandard(input.standardId);

    // Before the reservation, never after the report (Phase 13 §66). A standard
    // with nothing this format can answer is refused here, so the user is not
    // charged for a report that could contain no verdict. Partial coverage is
    // not refused: it is shown in the preview and sold.
    //
    // Deliberately *outside* the transaction below. It reads the published
    // snapshot through the catalogue's own SECURITY DEFINER connection, and a
    // second connection's round trip inside an open reservation transaction
    // lengthens the window during which concurrent checks contend for the same
    // balance — which is exactly the race Phase 11 settled. Nothing here writes,
    // so there is nothing to roll back; the format is re-read and re-validated
    // inside the transaction, which is what actually guards the check.
    await this.compatibility.assertCheckable(
      await this.formatForCheck(userId, input.documentVersionId),
      standard.standardVersionId,
    );

    const checkId = randomUUID();
    const purchaseId = randomUUID();

    const created = await this.tenant
      .withUser(userId, async (tx) => {
        if (input.idempotencyKey !== undefined) {
          // Serialize retries before reading the quote or reserving funds. The
          // fast-path read above may precede another request's commit; reserve
          // can then reuse its purchase, whose id is not our preallocated id.
          // Re-read under this transaction lock and return the whole winning
          // check, validating the original payload on the same connection.
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`document-check:${userId}:${input.idempotencyKey}`}, 0))::text`;
          const prior = await this.replayInTransaction(tx, userId, input);
          if (prior !== null) return prior;
        }

        const version = await this.loadCheckableVersion(tx, input.documentVersionId);
        const quote = await this.loadSpendableQuote(tx, userId, input.priceQuoteId);

        // Reserving is where a shortfall is discovered, and it throws — which
        // rolls back the whole transaction, so an insufficient balance leaves no
        // check, no purchase, no hold and no job behind (§108).
        await this.purchases.reserve(tx, {
          ownerUserId: userId,
          purchaseId,
          productCode: ServiceProductCode.DOCUMENT_CHECK,
          resourceType: ServiceResourceType.DOCUMENT_CHECK,
          resourceId: checkId,
          quote: {
            id: quote.id,
            priceVersionId: quote.priceVersionId,
            currency: quote.currency,
            amountMinor: quote.amountMinor,
          },
          ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
        });

        const check = await tx.documentCheck.create({
          data: {
            id: checkId,
            ownerUserId: userId,
            documentId: version.documentId,
            documentVersionId: version.id,
            organizationId: standard.organizationId,
            documentTypeId: standard.documentTypeId,
            standardId: standard.standardId,
            standardVersionId: standard.standardVersionId,
            // Captured now and immutable: the check is these bytes and these
            // rules, whatever either of them becomes later (§5, §102, §98, §99).
            documentSha256: version.sha256!,
            standardContentHash: standard.contentHash,
            // The public catalogue labels the user saw when they chose it. The
            // check must render for them without their session reading the
            // organization's own tables — which it cannot, and must not (§57).
            organizationName: standard.organizationName,
            documentTypeName: standard.documentTypeName,
            standardCode: standard.code,
            standardName: standard.nameEn,
            standardVersionLabel: standard.versionLabel,
            status: CheckStatus.CREATED,
            servicePurchaseId: purchaseId,
            idempotencyKey: input.idempotencyKey ?? null,
          },
        });

        // The source bytes must not disappear while a report references them
        // (§26, §100). Append-only, so a second check adds a second lock.
        await tx.documentRetentionLock.create({
          data: {
            documentVersionId: version.id,
            ownerUserId: userId,
            lockType: CHECK_RETENTION_LOCK,
            reference: checkId,
          },
        });

        // The durable kickoff. Written here rather than dispatched after the
        // commit, so an API process that dies one instruction later still leaves
        // behind an intent a worker will pick up (§22, §23, §112, §113).
        await this.jobs.enqueueInTransaction(tx, {
          type: ProcessingJobType.CHECK_PREPARE,
          resourceType: 'DOCUMENT_CHECK',
          resourceId: checkId,
          ownerUserId: userId,
        });

        return check;
      })
      .catch(async (error: unknown) => {
        // Two identical requests arriving at once (§205).
        //
        // Retain the unique-conflict fallback for requests from an older
        // process that does not yet take the idempotency lock. The database
        // keeps that safe: `service_purchases_owner_idempotency` and
        // `document_checks_owner_idempotency_key` mean the loser's transaction
        // cannot commit, so there is no second purchase, no second reservation
        // and no second check — which was already true before this catch, and is
        // the property that actually matters.
        //
        // What was wrong was the answer. The loser got a raw unique-violation
        // and a 500 for a request the server had in fact honoured. Re-reading
        // the winner's check and returning it is the same answer the sequential
        // replay gives, which is what an idempotency key promises.
        if (!isIdempotencyConflict(error)) throw error;
        const winner = await this.replayIdempotent(userId, input);
        if (winner === null) throw error;
        return winner;
      });

    if (created.id !== checkId) {
      // The replay path. Nothing was created here, so nothing is audited here
      // either — the winning request already wrote both of these entries.
      return this.byId(userId, created.id);
    }

    await this.events.audit({
      action: 'CHECK_CREATED',
      actorUserId: userId,
      targetType: 'DocumentCheck',
      targetId: created.id,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      afterState: {
        standardVersionId: standard.standardVersionId,
        documentVersionId: input.documentVersionId,
      },
    });
    await this.events.audit({
      action: 'CHECK_PURCHASE_RESERVED',
      actorUserId: userId,
      targetType: 'DocumentCheck',
      targetId: created.id,
      requestId: request.requestId,
      // Codes and identifiers only: the amount is in the purchase row, and
      // duplicating every money movement into the audit trail is exactly what
      // §138 says not to do.
      afterState: { purchaseId, priceQuoteId: input.priceQuoteId },
    });

    // Best-effort: the job row is already committed, so if this fails the
    // outbox sweep publishes it moments later and nothing is lost (§113).
    const job = await this.jobs.findByResource(ProcessingJobType.CHECK_PREPARE, created.id);
    if (job !== null) await this.dispatcher.dispatchNow(job.id);

    return this.byId(userId, created.id);
  }

  /**
   * The check this idempotency key already made, if it made one (§18, §61).
   *
   * A browser retry must not buy a second check; two deliberate checks of the
   * same document against the same standard are perfectly legitimate and are
   * not deduplicated.
   */
  private async replayIdempotent(
    userId: string,
    input: CreateCheckInput,
  ): Promise<DocumentCheck | null> {
    if (input.idempotencyKey === undefined) return null;
    return this.tenant.withUser(userId, (tx) => this.replayInTransaction(tx, userId, input));
  }

  private async replayInTransaction(
    tx: TenantClient,
    userId: string,
    input: CreateCheckInput,
  ): Promise<DocumentCheck | null> {
    if (input.idempotencyKey === undefined) return null;
    const existing = await tx.documentCheck.findFirst({
      where: { ownerUserId: userId, idempotencyKey: input.idempotencyKey },
    });
    if (existing === null) return null;
    await this.assertSameRequest(tx, existing, input);
    return existing;
  }

  /**
   * Load the quote that will pay for this check, or refuse (§14, §15, §16).
   *
   * Five conditions, all of them the server's own: the quote is the caller's,
   * it is for this product, it has not expired, its currency is one PalCert
   * transacts in, and it has not already funded something. None of them is
   * negotiable from the request, and none of them reprices anything — an
   * unexpired quote is honoured at the number it was issued at even after the
   * price has moved (§15).
   */
  private async loadSpendableQuote(
    tx: TenantClient,
    userId: string,
    priceQuoteId: string,
  ): Promise<{
    id: string;
    priceVersionId: string;
    currency: string;
    amountMinor: bigint;
  }> {
    const quote = await tx.priceQuote.findFirst({
      where: { id: priceQuoteId, ownerUserId: userId },
      include: { purchase: { select: { id: true } } },
    });
    if (quote === null) {
      // Row-level security already hides another customer's quote, so this is
      // the same answer a stranger gets.
      throw new AppError(PalCertErrorCode.QUOTE_NOT_FOUND, {
        message: 'That price quote could not be found.',
      });
    }
    if (quote.productCode !== ServiceProductCode.DOCUMENT_CHECK) {
      throw new AppError(PalCertErrorCode.QUOTE_PRODUCT_MISMATCH, {
        message: 'That price quote is for a different service.',
      });
    }
    if (quote.expiresAt.getTime() <= this.clock.now().getTime()) {
      throw new AppError(PalCertErrorCode.QUOTE_EXPIRED, {
        message: 'That price quote has expired. Please ask for a new one.',
      });
    }
    if (quote.purchase !== null) {
      throw new AppError(PalCertErrorCode.QUOTE_ALREADY_USED, {
        message: 'That price quote has already been used. Please ask for a new one.',
      });
    }
    return {
      id: quote.id,
      priceVersionId: quote.priceVersionId,
      currency: quote.currency,
      amountMinor: quote.amountMinor,
    };
  }

  /**
   * Get one check moving: the body of the `CHECK_PREPARE` job (§23, §24).
   *
   * Idempotent in every step, because an at-least-once worker will run it
   * twice. `ensureDocumentAnalysis` reuses an existing analysis rather than making
   * a second one (§27), `startEvaluation` refuses to create a second live run,
   * and a check that has already reached a terminal state is left alone —
   * which is what stops a duplicate delivery restarting a cancelled check.
   */
  async prepare(userId: string, checkId: string): Promise<void> {
    const check = await this.tenant.withUser(userId, (tx) =>
      tx.documentCheck.findUnique({ where: { id: checkId } }),
    );
    if (check === null) return;
    if (isCheckTerminal(check.status as CheckStatus)) return;

    // The customer's money is already reserved; this records that PalCert has
    // started spending effort against it. Nothing is charged (§29).
    await this.settlement.markProcessing(userId, checkId);
    await this.attachAnalysisAndDispatch(userId, check);
  }

  /**
   * Make sure an analysis exists, then either queue evaluation or park.
   *
   * Reuse is the point: a document already analyzed for one standard is not
   * re-analyzed for the next (§27). A check whose analysis is still running
   * waits on a durable dependency rather than polling (§28).
   */
  private async attachAnalysisAndDispatch(userId: string, check: DocumentCheck): Promise<void> {
    const ensured = await this.analyses.ensureDocumentAnalysis(userId, check.documentVersionId);
    const analysis = ensured.analysis;

    await this.tenant.withUser(userId, (tx) =>
      tx.documentCheck.update({
        where: { id: check.id },
        data: { documentAnalysisId: analysis.id },
      }),
    );

    if (analysis.status === DocumentAnalysisStatus.SUCCEEDED) {
      await this.startEvaluation(userId, check.id);
      return;
    }
    if (analysis.status === DocumentAnalysisStatus.FAILED) {
      await this.fail(userId, check.id, {
        code: 'DOCUMENT_ANALYSIS_FAILED',
        detail: analysis.failureCode ?? 'analysis failed',
      });
      return;
    }

    // Compare-and-set, not a blind write (§84).
    //
    // FAILED -> WAITING_ANALYSIS is a legal transition, because that is what a
    // deliberate retry does. But this code path is not a retry: it is an
    // in-flight preparation pass, and it may be arriving late — after the
    // sweeper settled an expired reservation and failed the check. A blind
    // update would then resurrect a check whose money has already been
    // released, leaving it looking live with nothing paying for it. Naming
    // the statuses this path may legitimately move *from* makes that
    // impossible without taking the legal retry away from the retry path.
    const advanced = await this.tenant.withUser(userId, (tx) =>
      tx.documentCheck.updateMany({
        where: {
          id: check.id,
          status: { in: [CheckStatus.CREATED, CheckStatus.WAITING_ANALYSIS] },
        },
        data: { status: CheckStatus.WAITING_ANALYSIS, startedAt: this.clock.now() },
      }),
    );
    if (advanced.count === 0) {
      this.logger.info(
        { checkId: check.id },
        'Check was settled while its analysis was being prepared; leaving it alone',
      );
      return;
    }
    await this.events.audit({
      action: 'CHECK_WAITING_ANALYSIS',
      actorUserId: null,
      targetType: 'DocumentCheck',
      targetId: check.id,
    });
  }

  /**
   * Create a run and queue its evaluation.
   *
   * Called on creation when the analysis is already usable, and by the
   * analysis worker when one finishes — the durable wake-up that replaces
   * polling (§28).
   */
  async startEvaluation(userId: string, checkId: string): Promise<CheckRun | null> {
    const queued = await this.tenant.withUser(userId, async (tx) => {
      // Under the check's row lock, for the same reason the settlement path
      // takes it: an unlocked read can see a live check, block on the lock
      // while the sweeper fails it, and then write EVALUATING on top of the
      // settled row — FAILED -> EVALUATING being legal for retries. Reading
      // the status under the lock serializes this against settlement, so a
      // check that has just been settled is seen as settled.
      await tx.$queryRaw`SELECT "id" FROM "document_checks" WHERE "id" = ${checkId}::uuid FOR UPDATE`;
      const check = await tx.documentCheck.findUnique({ where: { id: checkId } });
      if (check === null) return null;
      if (isCheckTerminal(check.status as CheckStatus)) return null;

      // A run already in flight means another delivery got here first.
      const live = await tx.checkRun.findFirst({
        where: { checkId, status: { in: ['PENDING', 'RUNNING'] } },
      });
      if (live !== null) return null;

      const previous = await tx.checkRun.aggregate({
        where: { checkId },
        _max: { attemptNumber: true },
      });
      const run = await tx.checkRun.create({
        data: {
          ownerUserId: userId,
          checkId,
          attemptNumber: (previous._max.attemptNumber ?? 0) + 1,
          documentAnalysisId: check.documentAnalysisId,
          orchestratorVersion: CHECK_ORCHESTRATOR_VERSION,
        },
      });

      await tx.documentCheck.update({
        where: { id: checkId },
        data: {
          status: CheckStatus.EVALUATING,
          currentRunId: run.id,
          startedAt: check.startedAt ?? this.clock.now(),
          failureCode: null,
          failureDetail: null,
        },
      });

      // Same transaction as the state it processes: if Redis is down the row
      // is still there and the sweep publishes it later (§106).
      await this.jobs.enqueueInTransaction(tx, {
        type: ProcessingJobType.CHECK_EVALUATION,
        resourceType: 'CHECK_RUN',
        resourceId: run.id,
        ownerUserId: userId,
      });

      return run;
    });

    if (queued === null) return null;

    const job = await this.jobs.findByResource(ProcessingJobType.CHECK_EVALUATION, queued.id);
    if (job !== null) await this.dispatcher.dispatchNow(job.id);

    await this.events.audit({
      action: 'CHECK_EVALUATION_STARTED',
      actorUserId: null,
      targetType: 'DocumentCheck',
      targetId: checkId,
      afterState: { runId: queued.id, attempt: queued.attemptNumber },
    });
    return queued;
  }

  /**
   * Every check parked on one analysis, woken when it finishes (§28).
   *
   * Called by the analysis worker inside the same flow that completes the
   * analysis, so no check is left waiting for an event that already happened.
   */
  async onAnalysisSettled(
    userId: string,
    analysisId: string,
    outcome: 'SUCCEEDED' | 'FAILED',
    failureCode: string | null,
  ): Promise<void> {
    const waiting = await this.tenant.withUser(userId, (tx) =>
      tx.documentCheck.findMany({
        where: {
          documentAnalysisId: analysisId,
          status: { in: [CheckStatus.CREATED, CheckStatus.WAITING_ANALYSIS] },
        },
        select: { id: true },
        take: 200,
      }),
    );

    for (const check of waiting) {
      if (outcome === 'SUCCEEDED') {
        await this.startEvaluation(userId, check.id);
      } else {
        await this.fail(userId, check.id, {
          code: 'DOCUMENT_ANALYSIS_FAILED',
          detail: failureCode ?? 'analysis failed',
        });
      }
    }
  }

  /**
   * Fail a check, and give its reservation back with it (§37).
   *
   * Delegated to the one service that owns settlement, so that "the check
   * failed" and "the customer was not charged" can never become two different
   * answers written by two different workers (§79).
   */
  async fail(
    userId: string,
    checkId: string,
    failure: { code: string; detail: string },
  ): Promise<void> {
    await this.settlement.fail(userId, checkId, failure);
  }

  /**
   * Re-run a failed check (§63, Phase 11 §47–§49).
   *
   * A new run, never a rewrite: the failed run keeps its record of what went
   * wrong, and a completed check cannot be retried at all.
   *
   * A **paid** check cannot be retried here at all. Its reservation was
   * released when it failed, so restarting it would either do the work for
   * nothing or quietly re-take money against a balance the customer has since
   * spent. Running it again is a new quote, a new purchase and a new check,
   * which keeps the billing history of the failed attempt exactly as it
   * happened (§48). Historical free checks keep the Phase 7 behaviour, and
   * that path can no longer produce a new free check because the database
   * refuses one (§49).
   */
  async retry(userId: string, checkId: string, request: RequestContext): Promise<DocumentCheck> {
    const check = await this.byId(userId, checkId);
    if (check.status === CheckStatus.COMPLETED) {
      throw new AppError(PalCertErrorCode.CHECK_ALREADY_COMPLETED, {
        message: 'This check has already produced a report.',
      });
    }
    if (check.servicePurchaseId !== null) {
      throw new AppError(PalCertErrorCode.CHECK_RETRY_REQUIRES_NEW_PURCHASE, {
        message:
          'No charge was made for this check. Running it again starts a new check at the current price.',
      });
    }
    if (check.status !== CheckStatus.FAILED) {
      throw new AppError(PalCertErrorCode.CHECK_NOT_RETRYABLE, {
        message: 'Only a failed check can be retried.',
        details: { status: check.status },
      });
    }

    await this.events.audit({
      action: 'CHECK_RETRIED',
      actorUserId: userId,
      targetType: 'DocumentCheck',
      targetId: checkId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
    });

    await this.attachAnalysisAndDispatch(userId, check);
    return this.byId(userId, checkId);
  }

  async byId(userId: string, checkId: string): Promise<DocumentCheck> {
    const check = await this.tenant.withUser(userId, (tx) =>
      tx.documentCheck.findUnique({ where: { id: checkId } }),
    );
    if (check === null) {
      // Row-level security already returns nothing for another user's check,
      // so this is the same 404 a stranger gets (ADR-0017).
      throw new AppError(PalCertErrorCode.CHECK_NOT_FOUND, { message: 'No such check.' });
    }
    return check;
  }

  /**
   * The key covers the whole commercial request, not just the check (§18).
   *
   * A retry that names a different quote is a different purchase, and
   * returning the first check for it would silently charge the customer the
   * old price for a request they did not make.
   */
  private async assertSameRequest(
    tx: TenantClient,
    existing: DocumentCheck,
    input: CreateCheckInput,
  ): Promise<void> {
    const purchase =
      existing.servicePurchaseId === null
        ? null
        : await tx.servicePurchase.findUnique({
            where: { id: existing.servicePurchaseId },
            select: { priceQuoteId: true },
          });

    if (
      existing.documentVersionId !== input.documentVersionId ||
      existing.standardId !== input.standardId ||
      (purchase !== null && purchase.priceQuoteId !== input.priceQuoteId)
    ) {
      throw new AppError(PalCertErrorCode.IDEMPOTENCY_KEY_REUSED, {
        message: 'That idempotency key was already used for a different check.',
      });
    }
  }

  /**
   * The detected format of a version the caller may check.
   *
   * A short read of its own, so the compatibility preview can be decided
   * before any transaction opens. It applies the same eligibility rules as
   * `loadCheckableVersion`, which runs again inside the transaction — this one
   * decides what to compare against, that one decides whether the check may
   * exist at all.
   */
  private async formatForCheck(userId: string, documentVersionId: string): Promise<DocumentFormat> {
    const version = await this.tenant.withUser(userId, (tx) =>
      this.loadCheckableVersion(tx, documentVersionId),
    );
    return version.detectedFormat as DocumentFormat;
  }

  /** The version must be the caller's own READY DOCX or PDF with a digest (§25). */
  private async loadCheckableVersion(tx: TenantClient, documentVersionId: string) {
    const version = await tx.documentVersion.findFirst({
      // An undelivered correction cannot be checked by its owner: they have
      // not been given it yet, and PalCert's own recheck runs through the
      // worker rather than through this path (Phase 12 §84, §96).
      where: { id: documentVersionId, visibleToOwner: true },
      include: { document: true },
    });
    if (version === null) {
      throw new AppError(PalCertErrorCode.DOCUMENT_VERSION_NOT_FOUND, {
        message: 'No such document version.',
      });
    }
    if (version.document.status === DocumentStatus.DELETED) {
      throw new AppError(PalCertErrorCode.DOCUMENT_DELETED, {
        message: 'That document has been deleted.',
      });
    }
    if (version.status !== DocumentVersionStatus.READY) {
      throw new AppError(PalCertErrorCode.CHECK_DOCUMENT_NOT_READY, {
        message: 'This version is still being processed.',
      });
    }
    if (
      version.detectedFormat !== DocumentFormat.DOCX &&
      version.detectedFormat !== DocumentFormat.PDF
    ) {
      // Each format is routed to its own analyzer (Phase 13 §10). Routing one
      // into the other's logic would produce a confident answer about evidence
      // PalCert never read (§25).
      throw new AppError(PalCertErrorCode.CHECK_DOCUMENT_FORMAT_UNSUPPORTED, {
        message: 'PalCert can check Word documents and PDFs.',
        details: { format: version.detectedFormat },
      });
    }
    if (version.sha256 === null || version.cleanObjectKey === null) {
      throw new AppError(PalCertErrorCode.CHECK_DOCUMENT_NOT_READY, {
        message: 'This version cannot be checked.',
        internalContext: { versionId: documentVersionId, reason: 'missing clean identity' },
      });
    }
    return version;
  }
}

/**
 * A unique violation, whichever of the two idempotency constraints raised it.
 *
 * Matched on the code rather than the message: `meta.target` is null under the
 * least-privileged application role, so the constraint's name is not something
 * this can rely on seeing.
 */
function isIdempotencyConflict(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}
