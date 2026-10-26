import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  AppError,
  MANUAL_TOPUP_LIMITS,
  ManualTopUpActorSide,
  ManualTopUpEventType,
  ManualTopUpFileStatus,
  ManualTopUpStatus,
  MAX_MINOR_UNITS,
  PalCertErrorCode,
  ProcessingJobType,
  RECEIPT_FORMATS,
  RECEIPT_MAX_BYTES,
  isWithinManualTopUpLimits,
  normalizeTransferReference,
  parseMinorUnits,
  type DownloadAuthorizationView,
  type ManualTopUpReceiptUploadResponse,
  type ManualTopUpRequestView,
  type ManualTopUpUploadAuthorizationView,
} from '@palcert/contracts';
import type { ManualTopUpRequest, Prisma } from '@palcert/database';
import { OutboxDispatcher } from '../../../infrastructure/queue/outbox-dispatcher';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import { quarantineManualTopUpReceiptKey } from '../../../infrastructure/storage/storage-keys';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { AuthThrottleService, ThrottleScope } from '../../auth/services/auth-throttle.service';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { DomainEventService } from '../../notifications/services/domain-event.service';
import { ManualTopUpFiles } from '../manual-topup-files';
import {
  REQUEST_INCLUDE,
  clampLimit,
  cleanText,
  isUniqueViolation,
  methodNotFound,
  ownerRequestView,
  readSnapshot,
  referenceUnavailable,
  requestNotFound,
  snapshotOf,
  transitionInvalid,
  type RequestContext,
} from '../manual-topup-support';
import { ManualPaymentMethodService } from './manual-payment-method.service';

export interface DraftInput {
  readonly amountMinorUnits?: string | null | undefined;
  readonly reference?: string | null | undefined;
  readonly customerNote?: string | null | undefined;
}

/**
 * A person's own manual top-ups (create, fill in, attach, submit, cancel).
 *
 * Everything runs in the owner's own RLS scope. Nothing here can credit a
 * balance: the furthest a person can take a request is PENDING_REVIEW, and
 * the database refuses any other transition from an unelevated caller.
 */
@Injectable()
export class ManualTopUpRequestService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly methods: ManualPaymentMethodService,
    private readonly files: ManualTopUpFiles,
    private readonly domainEvents: DomainEventService,
    private readonly jobs: ProcessingJobService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly events: SecurityEventService,
    private readonly throttle: AuthThrottleService,
    private readonly clock: ClockPort,
  ) {}

  /** Start a draft against one method, freezing the destination the person is shown. */
  async createDraft(
    userId: string,
    input: DraftInput & {
      readonly paymentMethodId: string;
      readonly idempotencyKey?: string | undefined;
    },
    context: RequestContext,
  ): Promise<ManualTopUpRequestView> {
    await this.throttle.consume(ThrottleScope.MANUAL_TOPUP_SUBMIT, userId);
    const idempotencyKey = cleanText(input.idempotencyKey ?? null);

    const run = () =>
      this.tenant.withUser(userId, async (tx) => {
        if (idempotencyKey !== null) {
          const existing = await tx.manualTopUpRequest.findUnique({
            where: { ownerUserId_idempotencyKey: { ownerUserId: userId, idempotencyKey } },
            include: REQUEST_INCLUDE,
          });
          if (existing !== null) {
            if (existing.paymentMethodId !== input.paymentMethodId) {
              throw new AppError(PalCertErrorCode.IDEMPOTENCY_KEY_REUSED, {
                message: 'This Idempotency-Key was already used for a different top-up.',
              });
            }
            return { row: existing, created: false };
          }
        }

        const open = await tx.manualTopUpRequest.count({
          where: {
            ownerUserId: userId,
            status: { in: [ManualTopUpStatus.DRAFT, ManualTopUpStatus.PENDING_REVIEW] },
          },
        });
        if (open >= MANUAL_TOPUP_LIMITS.maxOpenRequests) {
          throw new AppError(PalCertErrorCode.MANUAL_TOPUP_TOO_MANY_OPEN, {
            message:
              'You already have several top-ups in progress. Wait for them to be reviewed, ' +
              'or cancel one you no longer need.',
            details: { maxOpenRequests: MANUAL_TOPUP_LIMITS.maxOpenRequests },
          });
        }

        const method = await this.methods.usable(tx, input.paymentMethodId);
        if (method === null) throw methodNotFound();

        const now = this.clock.now();
        const snapshot = snapshotOf(method, now);
        const fields = this.draftFields(input, method.minAmountMinor, method.maxAmountMinor);
        const id = randomUUID();
        await tx.manualTopUpRequest.create({
          data: {
            id,
            ownerUserId: userId,
            paymentMethodId: method.id,
            currency: method.currency,
            status: ManualTopUpStatus.DRAFT,
            paymentMethodSnapshot: snapshot as unknown as Prisma.InputJsonValue,
            idempotencyKey,
            createdAt: now,
            updatedAt: now,
            ...fields,
          },
        });
        await this.history(tx, id, userId, ManualTopUpEventType.CREATED);
        const row = await tx.manualTopUpRequest.findUniqueOrThrow({
          where: { id },
          include: REQUEST_INCLUDE,
        });
        return { row, created: true };
      });

    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run();
    } catch (error) {
      if (idempotencyKey !== null && isUniqueViolation(error, 'idempotency')) result = await run();
      else throw error;
    }

    if (result.created) {
      await this.events.audit({
        action: 'MANUAL_TOPUP_DRAFT_CREATED',
        actorUserId: userId,
        targetType: 'ManualTopUpRequest',
        targetId: result.row.id,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        afterState: { paymentMethodId: result.row.paymentMethodId, currency: result.row.currency },
      });
    }
    return ownerRequestView(result.row);
  }

  /** Fill in or correct a draft. Nothing is editable once it has been submitted. */
  async updateDraft(
    userId: string,
    requestId: string,
    input: DraftInput & { readonly removeReceipt?: boolean | undefined },
  ): Promise<ManualTopUpRequestView> {
    const row = await this.tenant.withUser(userId, async (tx) => {
      const current = await this.lockOwn(tx, userId, requestId);
      if (current.status !== ManualTopUpStatus.DRAFT) {
        throw transitionInvalid(current.status as ManualTopUpStatus, 'edited');
      }
      const snapshot = readSnapshot(current.paymentMethodSnapshot);
      const fields = this.draftFields(
        input,
        BigInt(snapshot.minAmountMinor),
        BigInt(snapshot.maxAmountMinor),
      );
      const now = this.clock.now();
      await tx.manualTopUpRequest.update({
        where: { id: requestId },
        data: {
          ...fields,
          ...(input.removeReceipt === true ? { receiptId: null } : {}),
          updatedAt: now,
        },
      });
      await this.history(tx, requestId, userId, ManualTopUpEventType.UPDATED);
      return tx.manualTopUpRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: REQUEST_INCLUDE,
      });
    });
    return ownerRequestView(row);
  }

  // -------------------------------------------------------------------------
  // Receipts
  // -------------------------------------------------------------------------

  async createReceiptUpload(
    userId: string,
    requestId: string,
    input: {
      readonly originalFilename: string;
      readonly declaredMimeType?: string | undefined;
      readonly sizeBytes: number;
      readonly sha256?: string | undefined;
      readonly idempotencyKey?: string | undefined;
    },
    context: RequestContext,
  ): Promise<ManualTopUpReceiptUploadResponse> {
    await this.throttle.consume(ThrottleScope.MANUAL_TOPUP_UPLOAD, userId);
    const upload = this.files.validate(
      input,
      RECEIPT_FORMATS,
      RECEIPT_MAX_BYTES,
      'A receipt must be a PDF, PNG, JPEG or WebP file.',
    );
    const idempotencyKey = cleanText(input.idempotencyKey ?? null);

    const receipt = await this.tenant.withUser(userId, async (tx) => {
      if (idempotencyKey !== null) {
        const existing = await tx.manualTopUpReceipt.findUnique({
          where: { ownerUserId_idempotencyKey: { ownerUserId: userId, idempotencyKey } },
        });
        if (existing !== null) {
          if (existing.requestId !== requestId) {
            throw new AppError(PalCertErrorCode.IDEMPOTENCY_KEY_REUSED, {
              message: 'This Idempotency-Key was already used for a different upload.',
            });
          }
          return existing;
        }
      }
      const current = await this.lockOwn(tx, userId, requestId);
      if (current.status !== ManualTopUpStatus.DRAFT) {
        throw transitionInvalid(current.status as ManualTopUpStatus, 'given a new receipt');
      }
      const receiptId = randomUUID();
      return tx.manualTopUpReceipt.create({
        data: {
          id: receiptId,
          requestId,
          ownerUserId: userId,
          status: ManualTopUpFileStatus.AWAITING_UPLOAD,
          originalFilename: upload.originalFilename,
          declaredMimeType: upload.declaredMimeType,
          expectedFormat: upload.expectedFormat,
          declaredSizeBytes: upload.sizeBytes,
          maxFileBytes: RECEIPT_MAX_BYTES,
          clientSha256: upload.clientSha256,
          quarantineObjectKey: quarantineManualTopUpReceiptKey({
            ownerUserId: userId,
            requestId,
            receiptId,
          }),
          idempotencyKey,
          uploadExpiresAt: upload.uploadExpiresAt,
        },
      });
    });

    await this.events.audit({
      action: 'MANUAL_TOPUP_RECEIPT_UPLOAD_STARTED',
      actorUserId: userId,
      targetType: 'ManualTopUpReceipt',
      targetId: receipt.id,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      afterState: { manualTopUpRequestId: requestId, expectedFormat: receipt.expectedFormat },
    });

    if (receipt.status !== ManualTopUpFileStatus.AWAITING_UPLOAD) {
      // An idempotent replay of an upload that has already been finalized.
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'This receipt has already been uploaded.',
      });
    }
    return {
      receipt: {
        id: receipt.id,
        status: receipt.status as ManualTopUpFileStatus,
        originalFilename: receipt.originalFilename,
        format: null,
        sizeBytes: null,
        rejectionCode: null,
        createdAt: receipt.createdAt.toISOString(),
      },
      upload: await this.files.authorizeUpload(receipt),
    };
  }

  async reauthorizeReceipt(
    userId: string,
    requestId: string,
    receiptId: string,
  ): Promise<ManualTopUpUploadAuthorizationView> {
    const receipt = await this.tenant.withUser(userId, (tx) =>
      this.ownReceipt(tx, userId, requestId, receiptId),
    );
    if (receipt.status !== ManualTopUpFileStatus.AWAITING_UPLOAD) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'This receipt has already been uploaded.',
      });
    }
    return this.files.authorizeUpload(receipt);
  }

  /** Pin the uploaded receipt, attach it to the draft, and queue its scan. */
  async finalizeReceipt(
    userId: string,
    requestId: string,
    receiptId: string,
    context: RequestContext,
  ): Promise<ManualTopUpRequestView> {
    const receipt = await this.tenant.withUser(userId, (tx) =>
      this.ownReceipt(tx, userId, requestId, receiptId),
    );
    if (receipt.status !== ManualTopUpFileStatus.AWAITING_UPLOAD)
      return this.get(userId, requestId);

    let staged: { versionId: string | null; etag: string | null };
    try {
      staged = await this.files.staged(receipt);
    } catch (error) {
      if (error instanceof AppError && error.code === PalCertErrorCode.UPLOAD_SESSION_EXPIRED) {
        await this.tenant.withUser(userId, (tx) =>
          tx.manualTopUpReceipt.updateMany({
            where: { id: receiptId, status: ManualTopUpFileStatus.AWAITING_UPLOAD },
            data: { status: ManualTopUpFileStatus.UPLOAD_EXPIRED, updatedAt: this.clock.now() },
          }),
        );
      }
      throw error;
    }

    const now = this.clock.now();
    const job = await this.tenant.withUser(userId, async (tx) => {
      const current = await this.lockOwn(tx, userId, requestId);
      if (current.status !== ManualTopUpStatus.DRAFT) {
        throw transitionInvalid(current.status as ManualTopUpStatus, 'given a new receipt');
      }
      const claimed = await tx.manualTopUpReceipt.updateMany({
        where: { id: receiptId, status: ManualTopUpFileStatus.AWAITING_UPLOAD },
        data: {
          status: ManualTopUpFileStatus.UPLOADED,
          uploadedAt: now,
          quarantineObjectVersionId: staged.versionId,
          quarantineObjectEtag: staged.etag,
          updatedAt: now,
        },
      });
      if (claimed.count !== 1) return null;
      await tx.manualTopUpRequest.update({
        where: { id: requestId },
        data: { receiptId, updatedAt: now },
      });
      await this.history(tx, requestId, userId, ManualTopUpEventType.RECEIPT_ATTACHED);
      return this.jobs.enqueueInTransaction(tx, {
        type: ProcessingJobType.MANUAL_TOPUP_RECEIPT_INGEST,
        resourceType: 'MANUAL_TOPUP_RECEIPT',
        resourceId: receiptId,
        ownerUserId: userId,
      });
    });

    if (job !== null) {
      await this.dispatcher.dispatchNow(job.id);
      await this.events.audit({
        action: 'MANUAL_TOPUP_RECEIPT_UPLOADED',
        actorUserId: userId,
        targetType: 'ManualTopUpReceipt',
        targetId: receiptId,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        afterState: { manualTopUpRequestId: requestId },
      });
    }
    return this.get(userId, requestId);
  }

  /** The owner's own receipt, by a short-lived signed URL. */
  async receiptDownload(userId: string, requestId: string): Promise<DownloadAuthorizationView> {
    const receipt = await this.tenant.withUser(userId, async (tx) => {
      const request = await tx.manualTopUpRequest.findUnique({
        where: { id: requestId },
        include: { receipt: true },
      });
      if (request === null || request.ownerUserId !== userId) throw requestNotFound();
      if (request.receipt === null) {
        throw new AppError(PalCertErrorCode.MANUAL_TOPUP_FILE_NOT_FOUND, {
          message: 'This top-up has no receipt.',
        });
      }
      return request.receipt;
    });
    return this.files.download(receipt, 'attachment');
  }

  // -------------------------------------------------------------------------
  // Submitting and cancelling
  // -------------------------------------------------------------------------

  /**
   * Hand a complete draft to PalCert finance.
   *
   * The method is re-checked here: if an administrator disabled it since the
   * draft was made, the submission is refused and the draft is kept, so the
   * person loses nothing and can choose another method. A reference already
   * pending or credited for the same method is refused with one generic
   * error, enforced by a unique index rather than by a read that another
   * request could race.
   */
  async submit(
    userId: string,
    requestId: string,
    context: RequestContext,
  ): Promise<ManualTopUpRequestView> {
    await this.throttle.consume(ThrottleScope.MANUAL_TOPUP_SUBMIT, userId);

    let submitted: boolean;
    try {
      submitted = await this.tenant.withUser(userId, async (tx) => {
        const current = await this.lockOwn(tx, userId, requestId);
        // A retried submit of a request that already went through is a no-op.
        if (current.status === ManualTopUpStatus.PENDING_REVIEW) return false;
        if (current.status !== ManualTopUpStatus.DRAFT) {
          throw transitionInvalid(current.status as ManualTopUpStatus, 'submitted');
        }
        if (current.amountMinor === null || current.referenceNormalized === null) {
          throw new AppError(PalCertErrorCode.MANUAL_TOPUP_INVALID, {
            message: 'Enter the amount you sent and the transfer reference before submitting.',
            details: {
              missing: [
                ...(current.amountMinor === null ? ['amountMinorUnits'] : []),
                ...(current.referenceNormalized === null ? ['reference'] : []),
              ],
            },
          });
        }

        const method = await this.methods.usable(tx, current.paymentMethodId);
        if (method === null) {
          throw new AppError(PalCertErrorCode.MANUAL_PAYMENT_METHOD_UNAVAILABLE, {
            message:
              'This payment method is no longer available. Your draft has been kept; ' +
              'start a new top-up with another method.',
          });
        }
        if (method.currency !== current.currency) {
          throw new AppError(PalCertErrorCode.MANUAL_PAYMENT_METHOD_UNAVAILABLE, {
            message: 'This payment method has changed. Start a new top-up.',
          });
        }
        if (
          !isWithinManualTopUpLimits(current.amountMinor, {
            minAmountMinor: method.minAmountMinor,
            maxAmountMinor: method.maxAmountMinor,
          })
        ) {
          throw this.outOfRange(current.currency, method.minAmountMinor, method.maxAmountMinor);
        }

        if (current.receiptId !== null) {
          const receipt = await tx.manualTopUpReceipt.findUnique({
            where: { id: current.receiptId },
          });
          if (receipt?.status !== ManualTopUpFileStatus.READY) {
            throw new AppError(PalCertErrorCode.MANUAL_TOPUP_FILE_NOT_READY, {
              message:
                receipt?.status === ManualTopUpFileStatus.REJECTED ||
                receipt?.status === ManualTopUpFileStatus.FAILED
                  ? 'Your receipt could not be accepted. Remove it or upload another one.'
                  : 'Your receipt is still being checked. Try again in a moment.',
              details: { receiptStatus: receipt?.status ?? null },
            });
          }
        }

        const now = this.clock.now();
        await tx.manualTopUpRequest.update({
          where: { id: requestId },
          data: { status: ManualTopUpStatus.PENDING_REVIEW, submittedAt: now, updatedAt: now },
        });
        const historyId = await this.history(tx, requestId, userId, ManualTopUpEventType.SUBMITTED);
        // In the same commit: PalCert finance is told exactly when, and only
        // if, the submission exists.
        await this.domainEvents.emitManualTopUp(tx, historyId);
        return true;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw referenceUnavailable();
      throw error;
    }

    if (submitted) {
      await this.events.audit({
        action: 'MANUAL_TOPUP_SUBMITTED',
        actorUserId: userId,
        targetType: 'ManualTopUpRequest',
        targetId: requestId,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
      });
    }
    return this.get(userId, requestId);
  }

  /** Withdraw a draft, or a submission nobody has started to review. */
  async cancel(
    userId: string,
    requestId: string,
    context: RequestContext,
  ): Promise<ManualTopUpRequestView> {
    const cancelled = await this.tenant.withUser(userId, async (tx) => {
      const current = await this.lockOwn(tx, userId, requestId);
      if (current.status === ManualTopUpStatus.CANCELLED) return false;
      const cancellable =
        current.status === ManualTopUpStatus.DRAFT ||
        (current.status === ManualTopUpStatus.PENDING_REVIEW && current.reviewStartedAt === null);
      if (!cancellable) {
        throw new AppError(PalCertErrorCode.MANUAL_TOPUP_TRANSITION_INVALID, {
          message:
            current.status === ManualTopUpStatus.PENDING_REVIEW
              ? 'PalCert finance has already started reviewing this top-up, so it can no longer be cancelled.'
              : 'This top-up has already been decided.',
          details: { status: current.status },
        });
      }
      const now = this.clock.now();
      await tx.manualTopUpRequest.update({
        where: { id: requestId },
        data: { status: ManualTopUpStatus.CANCELLED, cancelledAt: now, updatedAt: now },
      });
      await this.history(tx, requestId, userId, ManualTopUpEventType.CANCELLED);
      return true;
    });

    if (cancelled) {
      await this.events.audit({
        action: 'MANUAL_TOPUP_CANCELLED',
        actorUserId: userId,
        targetType: 'ManualTopUpRequest',
        targetId: requestId,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
      });
    }
    return this.get(userId, requestId);
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(
    userId: string,
    options: {
      readonly status?: ManualTopUpStatus;
      readonly limit?: number;
      readonly cursor?: string;
    },
  ): Promise<{ items: readonly ManualTopUpRequestView[]; nextCursor: string | null }> {
    const limit = clampLimit(options.limit, 20);
    const rows = await this.tenant.withUser(userId, (tx) =>
      tx.manualTopUpRequest.findMany({
        where: {
          ownerUserId: userId,
          ...(options.status === undefined ? {} : { status: options.status }),
        },
        include: REQUEST_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(options.cursor === undefined ? {} : { cursor: { id: options.cursor }, skip: 1 }),
      }),
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map(ownerRequestView),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async get(userId: string, requestId: string): Promise<ManualTopUpRequestView> {
    const row = await this.tenant.withUser(userId, (tx) =>
      tx.manualTopUpRequest.findUnique({ where: { id: requestId }, include: REQUEST_INCLUDE }),
    );
    if (row === null || row.ownerUserId !== userId) throw requestNotFound();
    return ownerRequestView(row);
  }

  // -------------------------------------------------------------------------

  private draftFields(
    input: DraftInput,
    minAmountMinor: bigint,
    maxAmountMinor: bigint,
  ): Partial<
    Pick<
      ManualTopUpRequest,
      'amountMinor' | 'referenceOriginal' | 'referenceNormalized' | 'customerNote'
    >
  > {
    const fields: Partial<
      Pick<
        ManualTopUpRequest,
        'amountMinor' | 'referenceOriginal' | 'referenceNormalized' | 'customerNote'
      >
    > = {};

    if (input.amountMinorUnits !== undefined) {
      if (input.amountMinorUnits === null) {
        fields.amountMinor = null;
      } else {
        let amount: bigint;
        try {
          amount = parseMinorUnits(input.amountMinorUnits);
        } catch {
          throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
            message: 'The amount must be a whole number of minor units, such as 15000 for 150.00.',
            details: { field: 'amountMinorUnits' },
          });
        }
        if (amount <= 0n || amount > MAX_MINOR_UNITS) {
          throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
            message: 'The amount must be greater than zero.',
            details: { field: 'amountMinorUnits' },
          });
        }
        if (!isWithinManualTopUpLimits(amount, { minAmountMinor, maxAmountMinor })) {
          throw this.outOfRange(null, minAmountMinor, maxAmountMinor);
        }
        fields.amountMinor = amount;
      }
    }

    if (input.reference !== undefined) {
      const original = cleanText(input.reference);
      if (original === null) {
        fields.referenceOriginal = null;
        fields.referenceNormalized = null;
      } else {
        const normalized = normalizeTransferReference(original);
        if (normalized === null) {
          throw new AppError(PalCertErrorCode.MANUAL_TOPUP_REFERENCE_INVALID, {
            message:
              'Enter the transfer reference exactly as your bank or wallet shows it: 4 to 64 ' +
              'letters and digits.',
            details: { field: 'reference' },
          });
        }
        fields.referenceOriginal = original;
        fields.referenceNormalized = normalized;
      }
    }

    if (input.customerNote !== undefined) {
      const note = cleanText(input.customerNote);
      if (note !== null && note.length > MANUAL_TOPUP_LIMITS.customerNote) {
        throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
          message: `A note may be at most ${MANUAL_TOPUP_LIMITS.customerNote} characters.`,
          details: { field: 'customerNote' },
        });
      }
      fields.customerNote = note;
    }
    return fields;
  }

  private outOfRange(currency: string | null, min: bigint, max: bigint): AppError {
    return new AppError(PalCertErrorCode.MANUAL_TOPUP_AMOUNT_OUT_OF_RANGE, {
      message: 'That amount is outside what this payment method accepts.',
      details: {
        ...(currency === null ? {} : { currency }),
        minAmountMinorUnits: min.toString(),
        maxAmountMinorUnits: max.toString(),
      },
    });
  }

  /** Lock the caller's own request for the rest of the transaction. */
  private async lockOwn(
    tx: TenantClient,
    userId: string,
    requestId: string,
  ): Promise<ManualTopUpRequest> {
    await tx.$queryRaw`SELECT "id" FROM "manual_topup_requests" WHERE "id" = ${requestId}::uuid FOR UPDATE`;
    const row = await tx.manualTopUpRequest.findUnique({ where: { id: requestId } });
    if (row === null || row.ownerUserId !== userId) throw requestNotFound();
    return row;
  }

  private async ownReceipt(tx: TenantClient, userId: string, requestId: string, receiptId: string) {
    const receipt = await tx.manualTopUpReceipt.findUnique({ where: { id: receiptId } });
    if (receipt === null || receipt.ownerUserId !== userId || receipt.requestId !== requestId) {
      throw new AppError(PalCertErrorCode.MANUAL_TOPUP_FILE_NOT_FOUND, {
        message: 'No such receipt on this top-up.',
      });
    }
    return receipt;
  }

  private async history(
    tx: TenantClient,
    requestId: string,
    ownerUserId: string,
    eventType: ManualTopUpEventType,
  ): Promise<string> {
    const row = await tx.manualTopUpRequestEvent.create({
      data: {
        requestId,
        ownerUserId,
        eventType,
        actorSide: ManualTopUpActorSide.OWNER,
        actorUserId: ownerUserId,
      },
      select: { id: true },
    });
    return row.id;
  }
}
