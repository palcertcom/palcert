import { Injectable } from '@nestjs/common';
import {
  AppError,
  AttestationActorSide,
  AttestationArtifactStatus,
  AttestationPaymentStatus,
  AttestationRequestEventType,
  AttestationRequestStatus,
  AttestationVerificationStatus,
  DEFAULT_COMMISSION_BPS,
  NotificationType,
  OWNER_CANCELLABLE_STATUSES,
  PalCertErrorCode,
  attestationVerificationStatus,
  isCalendarDate,
  money,
  splitAttestationFee,
  type AttestationQuoteView,
  type AttestationReceiptView,
  type AttestationRequestListItemView,
  type AttestationRequestOwnerView,
  type AttestationRequestSummaryView,
  type AttestationSubmittedMetadata,
} from '@palcert/contracts';
import type { Prisma } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../../../config/api-config.service';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { AuthThrottleService, ThrottleScope } from '../../auth/services/auth-throttle.service';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { DomainEventService } from '../../notifications/services/domain-event.service';
import {
  attestationTokenKey,
  cleanText,
  isUniqueViolation,
  listItemView,
  openAttestationToken,
  ownerRequestView,
  parseIsoDate,
  requestNotFound,
  transitionInvalid,
  verificationUrlFor,
  type RequestRow,
} from '../attestation-support';
import { AttestationCatalogueService, type TypeOffer } from './attestation-catalogue.service';
import { AttestationPaymentService } from './attestation-payment.service';

export interface MetadataInput {
  readonly certificateTitle?: string;
  readonly certificateType?: string | null;
  readonly issuingOrganization?: string | null;
  readonly issueDate?: string | null;
  readonly referenceNumber?: string | null;
  readonly recipientName?: string | null;
  readonly description?: string | null;
  readonly notesForReviewer?: string | null;
}

export interface CreateRequestInput extends MetadataInput {
  readonly attestationTypeId: string;
  readonly certificateTitle: string;
  readonly previousAttestationId?: string | null;
  readonly idempotencyKey?: string | undefined;
}

export interface RequestContext {
  readonly requestId: string | null;
  readonly ipAddress: string | null;
}

const REQUEST_INCLUDE = {
  artifacts: { orderBy: { createdAt: 'asc' } },
  events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  attestation: true,
} as const satisfies Prisma.AttestationRequestInclude;

const OPEN_STATUSES = [
  AttestationRequestStatus.DRAFT,
  AttestationRequestStatus.SUBMITTED,
  AttestationRequestStatus.IN_REVIEW,
  AttestationRequestStatus.NEEDS_INFORMATION,
];

const EXPIRING_SOON_DAYS = 30;

/**
 * The owner's side of an attestation request (§2, §19, §28).
 *
 * Everything runs under the owner's own scope, so another person's request
 * is not merely filtered out but invisible to the connection. No route here
 * takes an organization id from the caller: the institution is whoever owns
 * the attestation type, which is a fact about the type.
 */
@Injectable()
export class AttestationRequestService {
  private readonly tokenKey: Buffer;

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly catalogue: AttestationCatalogueService,
    private readonly payments: AttestationPaymentService,
    private readonly domainEvents: DomainEventService,
    private readonly events: SecurityEventService,
    private readonly throttle: AuthThrottleService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AttestationRequestService.name);
    this.tokenKey = attestationTokenKey(config.certificateVerificationKey);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async list(
    userId: string,
    query: { readonly status?: AttestationRequestStatus | undefined },
  ): Promise<AttestationRequestListItemView[]> {
    const rows = await this.tenant.withUser(userId, (tx) =>
      tx.attestationRequest.findMany({
        where: {
          ownerUserId: userId,
          ...(query.status === undefined ? {} : { status: query.status }),
        },
        include: { attestation: true },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 200,
      }),
    );
    const now = this.clock.now();
    return rows.map((row) => listItemView(row, now));
  }

  async summary(userId: string): Promise<AttestationRequestSummaryView> {
    const rows = await this.tenant.withUser(userId, (tx) =>
      tx.attestationRequest.findMany({
        where: { ownerUserId: userId },
        select: {
          status: true,
          attestation: { select: { revokedAt: true, validUntil: true } },
        },
      }),
    );
    const now = this.clock.now();
    const soon = now.getTime() + EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000;
    const summary = {
      valid: 0,
      expiringSoon: 0,
      pendingReview: 0,
      needsInformation: 0,
      expired: 0,
      rejected: 0,
    };
    for (const row of rows) {
      if (
        row.status === AttestationRequestStatus.SUBMITTED ||
        row.status === AttestationRequestStatus.IN_REVIEW
      ) {
        summary.pendingReview += 1;
      }
      if (row.status === AttestationRequestStatus.NEEDS_INFORMATION) summary.needsInformation += 1;
      if (row.status === AttestationRequestStatus.REJECTED) summary.rejected += 1;
      if (row.attestation !== null) {
        const status = attestationVerificationStatus({
          revokedAt: row.attestation.revokedAt,
          validUntil: row.attestation.validUntil,
          now,
        });
        if (status === AttestationVerificationStatus.VALID) {
          summary.valid += 1;
          if (row.attestation.validUntil !== null && row.attestation.validUntil.getTime() <= soon) {
            summary.expiringSoon += 1;
          }
        }
        if (status === AttestationVerificationStatus.EXPIRED) summary.expired += 1;
      }
    }
    return summary;
  }

  async get(userId: string, requestId: string): Promise<AttestationRequestOwnerView> {
    return this.tenant.withUser(userId, async (tx) => {
      const row = await this.load(tx, userId, requestId);
      return this.view(tx, row);
    });
  }

  /** What submitting would cost, against what the owner can spend. */
  async quote(userId: string, requestId: string): Promise<AttestationQuoteView> {
    return this.tenant.withUser(userId, async (tx) => {
      const row = await this.load(tx, userId, requestId);
      let currency: string;
      let fee: bigint;
      if (row.grossFeeMinor !== null && row.currency !== null) {
        currency = row.currency;
        fee = row.grossFeeMinor;
      } else {
        const offer = await this.catalogue.offer(tx, row.attestationTypeId);
        currency = offer.currency;
        fee = offer.feeMinor;
      }
      const available = await this.payments.availableCash(tx, userId, currency);
      const availableMinor = BigInt(available.minorUnits);
      const shortfall = fee > availableMinor ? fee - availableMinor : 0n;
      return {
        attestationTypeId: row.attestationTypeId,
        fee: money(currency, fee),
        availableBalance: available,
        sufficient: shortfall === 0n,
        shortfall: money(currency, shortfall),
      };
    });
  }

  /** The financial receipt: what was paid, to whom, and the ledger entry that charged it. */
  async receipt(userId: string, requestId: string): Promise<AttestationReceiptView> {
    return this.tenant.withUser(userId, async (tx) => {
      const row = await this.load(tx, userId, requestId);
      if (row.grossFeeMinor === null || row.currency === null) {
        throw transitionInvalid(
          row.status as AttestationRequestStatus,
          'receipted before submission',
        );
      }
      return {
        requestId: row.id,
        attestationReference: row.attestation?.reference ?? null,
        institution: row.organizationName,
        attestationType: { en: row.typeNameEn, ar: row.typeNameAr },
        grossFee: money(row.currency, row.grossFeeMinor),
        paymentStatus: row.paymentStatus as AttestationPaymentStatus,
        paidAt: row.paymentSettledAt?.toISOString() ?? null,
        paymentTransactionReference: row.captureEntryId,
      };
    });
  }

  /** The verification URL, for the owner's own approved attestation. */
  async verificationUrl(userId: string, requestId: string): Promise<string> {
    const row = await this.tenant.withUser(userId, (tx) => this.load(tx, userId, requestId));
    const url = this.urlFor(row);
    if (url === null) {
      throw new AppError(PalCertErrorCode.ATTESTATION_NOT_FOUND, {
        message: 'This request has no attestation yet.',
      });
    }
    return url;
  }

  // -------------------------------------------------------------------------
  // Create and edit
  // -------------------------------------------------------------------------

  async create(
    userId: string,
    input: CreateRequestInput,
    context: RequestContext,
  ): Promise<AttestationRequestOwnerView> {
    await this.throttle.consume(ThrottleScope.ATTESTATION_SUBMIT, userId);
    const metadata = normalizeMetadata(input);
    const idempotencyKey = cleanText(input.idempotencyKey ?? null);
    const now = this.clock.now();

    const run = () =>
      this.tenant.withUser(userId, async (tx) => {
        if (idempotencyKey !== null) {
          const existing = await tx.attestationRequest.findUnique({
            where: { ownerUserId_idempotencyKey: { ownerUserId: userId, idempotencyKey } },
            include: REQUEST_INCLUDE,
          });
          if (existing !== null) {
            if (existing.attestationTypeId !== input.attestationTypeId) {
              throw new AppError(PalCertErrorCode.IDEMPOTENCY_KEY_REUSED, {
                message: 'This Idempotency-Key was already used for a different request.',
              });
            }
            return this.view(tx, existing);
          }
        }

        const offer = await this.catalogue.offer(tx, input.attestationTypeId);
        this.catalogue.assertOpen(offer);

        const open = await tx.attestationRequest.count({
          where: { ownerUserId: userId, status: { in: OPEN_STATUSES } },
        });
        if (open >= this.config.attestations.maxOpenRequestsPerUser) {
          throw new AppError(PalCertErrorCode.ATTESTATION_TOO_MANY_PENDING, {
            message: 'You have too many open attestation requests. Wait for some to be decided.',
            details: { limit: this.config.attestations.maxOpenRequestsPerUser },
          });
        }

        let previousAttestationId: string | null = null;
        if (input.previousAttestationId !== undefined && input.previousAttestationId !== null) {
          // Renewal: the previous attestation must be the caller's own, with
          // the same institution. RLS makes anyone else's invisible.
          const previous = await tx.attestation.findUnique({
            where: { id: input.previousAttestationId },
          });
          if (previous === null || previous.ownerUserId !== userId) {
            throw new AppError(PalCertErrorCode.ATTESTATION_NOT_FOUND, {
              message: 'No such attestation to renew.',
            });
          }
          if (previous.organizationId !== offer.organizationId) {
            throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
              message: 'A renewal is submitted to the institution that made the attestation.',
            });
          }
          previousAttestationId = previous.id;
        }

        const created = await tx.attestationRequest.create({
          data: {
            ownerUserId: userId,
            organizationId: offer.organizationId,
            attestationTypeId: offer.id,
            organizationName: offer.organizationName,
            typeNameEn: offer.nameEn,
            typeNameAr: offer.nameAr,
            ...metadata,
            certificateTitle: metadata.certificateTitle ?? '',
            previousAttestationId,
            idempotencyKey,
            createdAt: now,
            updatedAt: now,
          },
        });
        await tx.attestationRequestEvent.create({
          data: {
            requestId: created.id,
            ownerUserId: userId,
            organizationId: offer.organizationId,
            eventType: AttestationRequestEventType.CREATED,
            actorSide: AttestationActorSide.OWNER,
            actorUserId: userId,
            toStatus: AttestationRequestStatus.DRAFT,
            createdAt: now,
          },
        });
        await this.events.auditWithin(tx, {
          action: 'ATTESTATION_REQUEST_CREATED',
          actorUserId: userId,
          targetType: 'AttestationRequest',
          targetId: created.id,
          requestId: context.requestId,
          ipAddress: context.ipAddress,
          afterState: {
            organizationId: offer.organizationId,
            attestationTypeId: offer.id,
            renewal: previousAttestationId !== null,
          },
        });
        const row = await this.load(tx, userId, created.id);
        return this.view(tx, row);
      });

    try {
      return await run();
    } catch (error) {
      // Two identical first requests raced on the idempotency key: the loser
      // reads the winner's request.
      if (idempotencyKey !== null && isUniqueViolation(error, 'idempotency')) return run();
      throw error;
    }
  }

  /** Edit what the request describes, while it is the owner's to edit. */
  async update(
    userId: string,
    requestId: string,
    input: MetadataInput,
    context: RequestContext,
  ): Promise<AttestationRequestOwnerView> {
    const metadata = normalizeMetadata(input, { partial: true });
    return this.tenant.withUser(userId, async (tx) => {
      const row = await this.lockOwn(tx, userId, requestId);
      if (
        row.status !== AttestationRequestStatus.DRAFT &&
        row.status !== AttestationRequestStatus.NEEDS_INFORMATION
      ) {
        throw transitionInvalid(row.status as AttestationRequestStatus, 'edited');
      }
      await tx.attestationRequest.update({
        where: { id: row.id },
        data: { ...metadata, updatedAt: this.clock.now() },
      });
      await this.events.auditWithin(tx, {
        action: 'ATTESTATION_REQUEST_UPDATED',
        actorUserId: userId,
        targetType: 'AttestationRequest',
        targetId: row.id,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        afterState: { fields: Object.keys(metadata) },
      });
      return this.view(tx, await this.load(tx, userId, requestId));
    });
  }

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------

  /**
   * Hand the request to the institution and reserve its fee, atomically.
   *
   * The request row is locked first and the credit account second — the same
   * order for every submit — so two submissions of different requests against
   * one balance queue on the account rather than deadlock, and the second
   * sees the first one's hold before deciding whether the money is there.
   *
   * The price and commission are copied onto the request here and nowhere
   * else; the database refuses any later change to them.
   */
  async submit(
    userId: string,
    requestId: string,
    context: RequestContext,
  ): Promise<AttestationRequestOwnerView> {
    await this.throttle.consume(ThrottleScope.ATTESTATION_SUBMIT, userId);

    const result = await this.tenant.withUser(userId, async (tx) => {
      const row = await this.lockOwn(tx, userId, requestId);
      if (row.status === AttestationRequestStatus.SUBMITTED) {
        // A retried submit: already done, nothing reserved twice.
        return { view: await this.view(tx, row), eventId: null as string | null };
      }
      if (row.status !== AttestationRequestStatus.DRAFT) {
        throw transitionInvalid(row.status as AttestationRequestStatus, 'submitted');
      }

      const artifact =
        row.artifacts.find((candidate) => candidate.id === row.currentArtifactId) ?? null;
      if (artifact === null || artifact.status !== AttestationArtifactStatus.READY) {
        throw new AppError(PalCertErrorCode.ATTESTATION_ARTIFACT_NOT_READY, {
          message: 'Upload your certificate and wait for its security checks before submitting.',
          details: { artifactStatus: artifact?.status ?? null },
        });
      }

      const offer = await this.catalogue.offer(tx, row.attestationTypeId);
      this.catalogue.assertOpen(offer);
      if (
        artifact.detectedFormat === null ||
        !offer.allowedFormats.includes(artifact.detectedFormat)
      ) {
        throw new AppError(PalCertErrorCode.ATTESTATION_ARTIFACT_TYPE_NOT_ALLOWED, {
          message: 'This institution does not accept that kind of file for this attestation type.',
        });
      }
      assertRequiredFields(row, offer);

      const now = this.clock.now();
      const commission = await this.commissionAt(tx, row.organizationId, now);
      const split = splitAttestationFee(offer.feeMinor, commission.bps);
      const reservation = await this.payments.reserve(tx, row, {
        currency: offer.currency,
        grossMinor: split.grossMinor,
      });

      await tx.attestationRequest.update({
        where: { id: row.id },
        data: {
          status: AttestationRequestStatus.SUBMITTED,
          submittedAt: now,
          updatedAt: now,
          currency: offer.currency,
          grossFeeMinor: split.grossMinor,
          platformCommissionBps: split.platformCommissionBps,
          platformFeeMinor: split.platformFeeMinor,
          institutionNetMinor: split.institutionNetMinor,
          commissionId: commission.id,
          pricedAt: now,
          defaultValidityDays: offer.defaultValidityDays,
          allowNoExpiry: offer.allowNoExpiry,
          reviewerMayOverrideValidity: offer.reviewerMayOverrideValidity,
          reminderDays: [...offer.reminderDays],
          paymentStatus:
            reservation === null
              ? AttestationPaymentStatus.NOT_REQUIRED
              : AttestationPaymentStatus.RESERVED,
          holdId: reservation?.holdId ?? null,
        },
      });
      const submitted = await tx.attestationRequestEvent.create({
        data: {
          requestId: row.id,
          ownerUserId: userId,
          organizationId: row.organizationId,
          eventType: AttestationRequestEventType.SUBMITTED,
          actorSide: AttestationActorSide.OWNER,
          actorUserId: userId,
          fromStatus: AttestationRequestStatus.DRAFT,
          toStatus: AttestationRequestStatus.SUBMITTED,
          createdAt: now,
        },
      });
      await this.events.auditWithin(tx, {
        action: 'ATTESTATION_SUBMITTED',
        actorUserId: userId,
        targetType: 'AttestationRequest',
        targetId: row.id,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        afterState: {
          organizationId: row.organizationId,
          currency: offer.currency,
          grossMinorUnits: split.grossMinor.toString(),
          platformCommissionBps: split.platformCommissionBps,
          artifactSha256Prefix: artifact.sha256?.slice(0, 12) ?? null,
        },
      });
      if (reservation !== null) {
        await tx.attestationRequestEvent.create({
          data: {
            requestId: row.id,
            ownerUserId: userId,
            organizationId: row.organizationId,
            eventType: AttestationRequestEventType.PAYMENT_RESERVED,
            actorSide: AttestationActorSide.OWNER,
            actorUserId: userId,
            createdAt: now,
          },
        });
        await this.events.auditWithin(tx, {
          action: 'ATTESTATION_PAYMENT_RESERVED',
          actorUserId: userId,
          targetType: 'AttestationRequest',
          targetId: row.id,
          requestId: context.requestId,
          afterState: {
            currency: offer.currency,
            reservedMinorUnits: split.grossMinor.toString(),
            holdId: reservation.holdId,
          },
        });
      }

      // The owner's confirmation and the institution's alert, both from the
      // one history row, both in this commit.
      await this.domainEvents.emitAttestation(
        tx,
        submitted.id,
        NotificationType.ATTESTATION_SUBMITTED,
      );
      await this.domainEvents.emitAttestation(
        tx,
        submitted.id,
        NotificationType.ATTESTATION_READY_FOR_REVIEW,
      );

      return {
        view: await this.view(tx, await this.load(tx, userId, row.id)),
        eventId: submitted.id,
      };
    });

    return result.view;
  }

  // -------------------------------------------------------------------------
  // Cancel and respond
  // -------------------------------------------------------------------------

  /**
   * Withdraw a request before review starts.
   *
   * A reserved fee is released in the same transaction as the cancellation,
   * so there is no moment at which the request is cancelled and the money is
   * still held — and a repeated cancel releases nothing twice.
   */
  async cancel(
    userId: string,
    requestId: string,
    context: RequestContext,
  ): Promise<AttestationRequestOwnerView> {
    return this.tenant.withUser(userId, async (tx) => {
      const row = await this.lockOwn(tx, userId, requestId);
      const status = row.status as AttestationRequestStatus;
      if (status === AttestationRequestStatus.CANCELLED) return this.view(tx, row);
      if (!OWNER_CANCELLABLE_STATUSES.includes(status)) {
        throw transitionInvalid(status, 'cancelled once review has started');
      }

      const now = this.clock.now();
      const releasing =
        row.paymentStatus === AttestationPaymentStatus.RESERVED && row.holdId !== null;
      if (releasing) await this.payments.releaseForOwner(tx, row.holdId!);

      await tx.attestationRequest.update({
        where: { id: row.id },
        data: {
          status: AttestationRequestStatus.CANCELLED,
          cancelledAt: now,
          updatedAt: now,
          ...(releasing
            ? { paymentStatus: AttestationPaymentStatus.RELEASED, paymentReleasedAt: now }
            : {}),
        },
      });
      await tx.attestationRequestEvent.create({
        data: {
          requestId: row.id,
          ownerUserId: userId,
          organizationId: row.organizationId,
          eventType: AttestationRequestEventType.CANCELLED,
          actorSide: AttestationActorSide.OWNER,
          actorUserId: userId,
          fromStatus: status,
          toStatus: AttestationRequestStatus.CANCELLED,
          createdAt: now,
        },
      });
      await this.events.auditWithin(tx, {
        action: 'ATTESTATION_REQUEST_CANCELLED',
        actorUserId: userId,
        targetType: 'AttestationRequest',
        targetId: row.id,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        beforeState: { status },
      });
      if (releasing) {
        await tx.attestationRequestEvent.create({
          data: {
            requestId: row.id,
            ownerUserId: userId,
            organizationId: row.organizationId,
            eventType: AttestationRequestEventType.PAYMENT_RELEASED,
            actorSide: AttestationActorSide.OWNER,
            actorUserId: userId,
            createdAt: now,
          },
        });
        await this.events.auditWithin(tx, {
          action: 'ATTESTATION_PAYMENT_RELEASED',
          actorUserId: userId,
          targetType: 'AttestationRequest',
          targetId: row.id,
          requestId: context.requestId,
          afterState: {
            currency: row.currency,
            releasedMinorUnits: row.grossFeeMinor?.toString() ?? '0',
            reason: 'CANCELLED',
          },
        });
      }
      return this.view(tx, await this.load(tx, userId, row.id));
    });
  }

  /**
   * Answer the institution's question. Returns the case to its queue as
   * SUBMITTED, so a reviewer consciously picks it up again.
   */
  async respond(
    userId: string,
    requestId: string,
    input: { readonly message: string; readonly metadata?: MetadataInput },
    context: RequestContext,
  ): Promise<AttestationRequestOwnerView> {
    const message = cleanText(input.message);
    if (message === null) {
      throw new AppError(PalCertErrorCode.ATTESTATION_METADATA_INVALID, {
        message: 'Write a response to the institution.',
      });
    }
    const metadata =
      input.metadata === undefined ? {} : normalizeMetadata(input.metadata, { partial: true });

    return this.tenant.withUser(userId, async (tx) => {
      const row = await this.lockOwn(tx, userId, requestId);
      if (row.status !== AttestationRequestStatus.NEEDS_INFORMATION) {
        throw transitionInvalid(row.status as AttestationRequestStatus, 'answered');
      }
      const artifact =
        row.artifacts.find((candidate) => candidate.id === row.currentArtifactId) ?? null;
      if (artifact === null || artifact.status !== AttestationArtifactStatus.READY) {
        throw new AppError(PalCertErrorCode.ATTESTATION_ARTIFACT_NOT_READY, {
          message:
            'Wait for your replacement file to finish its security checks before responding.',
        });
      }
      const now = this.clock.now();
      // Details first, while the request is still NEEDS_INFORMATION and they
      // are the owner's to change; then the status.
      if (Object.keys(metadata).length > 0) {
        await tx.attestationRequest.update({
          where: { id: row.id },
          data: { ...metadata, updatedAt: now },
        });
      }
      await tx.attestationRequest.update({
        where: { id: row.id },
        data: {
          status: AttestationRequestStatus.SUBMITTED,
          openInformationRequest: null,
          updatedAt: now,
        },
      });
      const provided = await tx.attestationRequestEvent.create({
        data: {
          requestId: row.id,
          ownerUserId: userId,
          organizationId: row.organizationId,
          eventType: AttestationRequestEventType.INFORMATION_PROVIDED,
          actorSide: AttestationActorSide.OWNER,
          actorUserId: userId,
          fromStatus: AttestationRequestStatus.NEEDS_INFORMATION,
          toStatus: AttestationRequestStatus.SUBMITTED,
          message,
          createdAt: now,
        },
      });
      await this.events.auditWithin(tx, {
        action: 'ATTESTATION_INFORMATION_PROVIDED',
        actorUserId: userId,
        targetType: 'AttestationRequest',
        targetId: row.id,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        afterState: { fieldsChanged: Object.keys(metadata), artifactId: artifact.id },
      });
      await this.domainEvents.emitAttestation(
        tx,
        provided.id,
        NotificationType.ATTESTATION_INFORMATION_PROVIDED,
      );
      return this.view(tx, await this.load(tx, userId, row.id));
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async load(
    tx: TenantClient,
    userId: string,
    requestId: string,
  ): Promise<RequestRow & { artifacts: NonNullable<RequestRow['artifacts']> }> {
    const row = await tx.attestationRequest.findUnique({
      where: { id: requestId },
      include: REQUEST_INCLUDE,
    });
    if (row === null || row.ownerUserId !== userId) throw requestNotFound();
    return row;
  }

  /** Lock the request row for the rest of the transaction, then read it. */
  private async lockOwn(tx: TenantClient, userId: string, requestId: string) {
    await tx.$queryRaw`SELECT "id" FROM "attestation_requests" WHERE "id" = ${requestId}::uuid FOR UPDATE`;
    return this.load(tx, userId, requestId);
  }

  private async commissionAt(
    tx: TenantClient,
    organizationId: string,
    at: Date,
  ): Promise<{ id: string | null; bps: number }> {
    const rows = await tx.$queryRaw<Array<{ commission_id: string; commission_bps: number }>>`
      SELECT * FROM app_attestation_commission_at(${organizationId}::uuid, ${at}::timestamptz)`;
    const row = rows[0];
    return row === undefined
      ? { id: null, bps: DEFAULT_COMMISSION_BPS }
      : { id: row.commission_id, bps: row.commission_bps };
  }

  private urlFor(row: RequestRow): string | null {
    if (row.attestation === null || row.attestation === undefined) return null;
    const token = openAttestationToken(row.attestation.publicTokenSealed, this.tokenKey);
    return token === null ? null : verificationUrlFor(this.config.publicWebUrl, token);
  }

  private async view(tx: TenantClient, row: RequestRow): Promise<AttestationRequestOwnerView> {
    let liveFee: { currency: string; feeMinor: bigint } | null = null;
    if (row.pricedAt === null) {
      try {
        const offer = await this.catalogue.offer(tx, row.attestationTypeId);
        liveFee = { currency: offer.currency, feeMinor: offer.feeMinor };
      } catch {
        liveFee = null;
      }
    }
    return ownerRequestView(row, {
      now: this.clock.now(),
      verificationUrl: this.urlFor(row),
      liveFee,
    });
  }
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

function metadataInvalid(message: string, field: string): AppError {
  return new AppError(PalCertErrorCode.ATTESTATION_METADATA_INVALID, {
    message,
    details: { field },
  });
}

type NormalizedMetadata = Partial<{
  certificateTitle: string;
  certificateType: string | null;
  issuingOrganization: string | null;
  issueDate: Date | null;
  referenceNumber: string | null;
  recipientName: string | null;
  description: string | null;
  notesForReviewer: string | null;
}>;

function normalizeMetadata(
  input: MetadataInput,
  options: { partial?: boolean } = {},
): NormalizedMetadata {
  const out: NormalizedMetadata = {};
  if (input.certificateTitle !== undefined || !options.partial) {
    const title = cleanText(input.certificateTitle ?? null);
    if (title === null)
      throw metadataInvalid('The certificate title is required.', 'certificateTitle');
    out.certificateTitle = title;
  }
  const text = (key: Exclude<keyof MetadataInput, 'certificateTitle' | 'issueDate'>) => {
    if (input[key] !== undefined) out[key] = cleanText(input[key]);
  };
  text('certificateType');
  text('issuingOrganization');
  text('referenceNumber');
  text('recipientName');
  text('description');
  text('notesForReviewer');
  if (input.issueDate !== undefined) {
    if (input.issueDate === null || input.issueDate === '') {
      out.issueDate = null;
    } else if (!isCalendarDate(input.issueDate)) {
      throw metadataInvalid('The issue date must be a real date in YYYY-MM-DD form.', 'issueDate');
    } else {
      out.issueDate = parseIsoDate(input.issueDate);
    }
  }
  return out;
}

function assertRequiredFields(row: RequestRow, offer: TypeOffer): void {
  const values: Record<keyof AttestationSubmittedMetadata, unknown> = {
    certificateTitle: row.certificateTitle,
    certificateType: row.certificateType,
    issuingOrganization: row.issuingOrganization,
    issueDate: row.issueDate,
    referenceNumber: row.referenceNumber,
    recipientName: row.recipientName,
    description: row.description,
  };
  const missing = offer.requiredFields.filter((field) => {
    const value = values[field];
    return value === null || value === undefined || value === '';
  });
  if (missing.length > 0) {
    throw new AppError(PalCertErrorCode.ATTESTATION_METADATA_INVALID, {
      message: 'Some details this institution requires are missing.',
      details: { missing },
    });
  }
}
