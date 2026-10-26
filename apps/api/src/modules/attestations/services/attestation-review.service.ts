import { Injectable } from '@nestjs/common';
import {
  ATTESTATION_MANIFEST_VERSION,
  AppError,
  AttestationActorSide,
  AttestationArtifactStatus,
  AttestationPaymentStatus,
  AttestationRequestEventType,
  AttestationRequestStatus,
  AttestationVerificationStatus,
  MAX_ATTESTATION_VALIDITY_DAYS,
  NotificationType,
  PalCertErrorCode,
  ProcessingJobType,
  addValidityDays,
  attestationManifestHash,
  attestationTokenHash,
  attestationVerificationStatus,
  generateAttestationReference,
  generateAttestationToken,
  isCalendarDate,
  money,
  type AttestationQueueCountsView,
  type AttestationQueueEntryView,
  type AttestationRequestReviewView,
  type DownloadAuthorizationView,
  type OrganizationAttestationDashboardView,
  type Page,
} from '@palcert/contracts';
import type { Attestation, AttestationArtifact, Prisma } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../../../config/api-config.service';
import { sha256Stream } from '../../../ingestion/hashing';
import { OutboxDispatcher } from '../../../infrastructure/queue/outbox-dispatcher';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import { ObjectStoragePort } from '../../../infrastructure/storage/object-storage.port';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { DomainEventService } from '../../notifications/services/domain-event.service';
import type { TenantContext } from '../../organizations/tenant-context';
import {
  artifactView,
  attestationTokenKey,
  cleanText,
  currentArtifact,
  eventView,
  feeSnapshotView,
  isUniqueViolation,
  openAttestationToken,
  parseIsoDate,
  recordView,
  requestNotFound,
  sealAttestationToken,
  storageUnavailable,
  submittedMetadata,
  transitionInvalid,
  verificationUrlFor,
  type RequestRow,
} from '../attestation-support';
import { AttestationArtifactService } from './attestation-artifact.service';
import { scopeOf } from './attestation-type.service';

export interface QueueQuery {
  readonly status?: string | undefined;
  readonly attestationTypeId?: string | undefined;
  readonly search?: string | undefined;
  readonly reviewerUserId?: string | undefined;
  readonly paymentStatus?: AttestationPaymentStatus | undefined;
  readonly validity?: AttestationVerificationStatus | undefined;
  readonly submittedFrom?: string | undefined;
  readonly submittedTo?: string | undefined;
  readonly sort?: 'submittedAt' | 'updatedAt' | undefined;
  readonly order?: 'asc' | 'desc' | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** Queue tabs. PENDING is "waiting for someone to pick it up". */
export const QUEUE_TABS = [
  'PENDING',
  'IN_REVIEW',
  'AWAITING_INFORMATION',
  'APPROVED',
  'REJECTED',
  'REVOKED',
  'EXPIRED',
  'ALL',
] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];

export interface ApproveInput {
  readonly confirm: boolean;
  readonly certificateTitle: string;
  readonly certificateType?: string | null;
  readonly holderName?: string | null;
  readonly issuingOrganization?: string | null;
  readonly issueDate?: string | null;
  readonly referenceNumber?: string | null;
  readonly holderNamePublic?: boolean;
  readonly referenceNumberPublic?: boolean;
  readonly institutionNote?: string | null;
  readonly validFrom?: string | null;
  readonly validUntil?: string | null;
  readonly validityDays?: number | null;
  readonly noExpiry?: boolean;
}

const REVIEW_INCLUDE = {
  artifacts: { orderBy: { createdAt: 'asc' } },
  events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  attestation: true,
} as const satisfies Prisma.AttestationRequestInclude;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The institution's side of attestation (§6, §7, §16, §33).
 *
 * Every write locks the request row first and re-checks its status under the
 * lock, so two reviewers acting at once produce exactly one decision: the
 * second waits for the first's commit, reads the decided status, and is
 * refused. The terminal transition is also conditional in the database, and a
 * trigger refuses any edge the transition table does not list.
 *
 * Money never moves here. A decision enqueues the job that moves it, in the
 * same commit, because the reviewer's scope cannot and must not reach the
 * owner's ledger.
 */
@Injectable()
export class AttestationReviewService {
  private readonly tokenKey: Buffer;

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly storage: ObjectStoragePort,
    private readonly artifacts: AttestationArtifactService,
    private readonly jobs: ProcessingJobService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly domainEvents: DomainEventService,
    private readonly events: SecurityEventService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AttestationReviewService.name);
    this.tokenKey = attestationTokenKey(config.certificateVerificationKey);
  }

  // -------------------------------------------------------------------------
  // Queue and dashboard
  // -------------------------------------------------------------------------

  async queue(context: TenantContext, query: QueueQuery): Promise<Page<AttestationQueueEntryView>> {
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const offset = decodeOffset(query.cursor);
    const now = this.clock.now();
    const where = this.queueWhere(context, query, now);
    const orderField = query.sort === 'updatedAt' ? 'updatedAt' : 'submittedAt';
    const direction = query.order === 'asc' ? 'asc' : 'desc';

    return this.tenant.withTenant(scopeOf(context), async (tx) => {
      const rows = await tx.attestationRequest.findMany({
        where,
        include: { attestation: true, artifacts: { select: { id: true, sha256: true } } },
        orderBy: [{ [orderField]: direction }, { id: direction }],
        skip: offset,
        take: limit + 1,
      });
      const page = rows.slice(0, limit);
      const owners = await this.owners(
        tx,
        page.map((row) => row.id),
      );
      const reviewers = await this.memberNames(
        tx,
        page.map((row) => row.assignedReviewerUserId).filter((id): id is string => id !== null),
      );
      const duplicates = await this.duplicateFlags(tx, context.organizationId, page);

      return {
        items: page.map((row) => {
          const attestation = row.attestation;
          return {
            id: row.id,
            status: row.status as AttestationRequestStatus,
            ownerDisplayName: owners.get(row.id)?.displayName ?? '',
            certificateTitle: row.certificateTitle,
            attestationTypeId: row.attestationTypeId,
            attestationTypeName: { en: row.typeNameEn, ar: row.typeNameAr },
            fee: money(row.currency ?? 'USD', row.grossFeeMinor ?? 0n),
            paymentStatus: row.paymentStatus as AttestationPaymentStatus,
            assignedReviewerName:
              row.assignedReviewerUserId === null
                ? null
                : (reviewers.get(row.assignedReviewerUserId) ?? null),
            submittedAt: row.submittedAt?.toISOString() ?? null,
            updatedAt: row.updatedAt.toISOString(),
            verificationStatus:
              attestation === null
                ? null
                : attestationVerificationStatus({
                    revokedAt: attestation.revokedAt,
                    validUntil: attestation.validUntil,
                    now,
                  }),
            validUntil: attestation?.validUntil?.toISOString() ?? null,
            reference: attestation?.reference ?? null,
            duplicateArtifact: duplicates.has(row.id),
          };
        }),
        nextCursor: rows.length > limit ? encodeOffset(offset + limit) : null,
      };
    });
  }

  async counts(context: TenantContext): Promise<AttestationQueueCountsView> {
    const now = this.clock.now();
    return this.tenant.withTenant(scopeOf(context), async (tx) => {
      const grouped = await tx.attestationRequest.groupBy({
        by: ['status'],
        where: {
          organizationId: context.organizationId,
          status: { not: AttestationRequestStatus.DRAFT },
        },
        _count: { _all: true },
      });
      const count = (status: AttestationRequestStatus) =>
        grouped.find((row) => row.status === status)?._count._all ?? 0;
      const revoked = await tx.attestation.count({
        where: { organizationId: context.organizationId, revokedAt: { not: null } },
      });
      const expired = await tx.attestation.count({
        where: {
          organizationId: context.organizationId,
          revokedAt: null,
          validUntil: { lte: now },
        },
      });
      return {
        pending: count(AttestationRequestStatus.SUBMITTED),
        inReview: count(AttestationRequestStatus.IN_REVIEW),
        awaitingInformation: count(AttestationRequestStatus.NEEDS_INFORMATION),
        approved: count(AttestationRequestStatus.APPROVED),
        rejected: count(AttestationRequestStatus.REJECTED),
        revoked,
        expired,
      };
    });
  }

  async dashboard(
    context: TenantContext,
    includeRevenue: boolean,
  ): Promise<OrganizationAttestationDashboardView> {
    const now = this.clock.now();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const soon = new Date(now.getTime() + 30 * DAY_MS);
    return this.tenant.withTenant(scopeOf(context), async (tx) => {
      const organizationId = context.organizationId;
      const [pendingReview, needsAttention, approvedThisMonth, rejectedThisMonth, expiringSoon] =
        await Promise.all([
          tx.attestationRequest.count({
            where: { organizationId, status: AttestationRequestStatus.SUBMITTED },
          }),
          tx.attestationRequest.count({
            where: { organizationId, status: AttestationRequestStatus.IN_REVIEW },
          }),
          tx.attestationRequest.count({
            where: {
              organizationId,
              status: AttestationRequestStatus.APPROVED,
              decidedAt: { gte: monthStart },
            },
          }),
          tx.attestationRequest.count({
            where: {
              organizationId,
              status: AttestationRequestStatus.REJECTED,
              decidedAt: { gte: monthStart },
            },
          }),
          tx.attestation.count({
            where: { organizationId, revokedAt: null, validUntil: { gt: now, lte: soon } },
          }),
        ]);
      let revenueThisMonth: OrganizationAttestationDashboardView['revenueThisMonth'] = null;
      if (includeRevenue) {
        const sums = await tx.attestationSettlement.groupBy({
          by: ['currency'],
          where: { organizationId, settledAt: { gte: monthStart } },
          _sum: { grossMinor: true, institutionNetMinor: true },
        });
        revenueThisMonth = sums.map((row) => ({
          gross: money(row.currency, row._sum.grossMinor ?? 0n),
          institutionNet: money(row.currency, row._sum.institutionNetMinor ?? 0n),
        }));
      }
      return {
        pendingReview,
        needsAttention,
        approvedThisMonth,
        rejectedThisMonth,
        expiringSoon,
        revenueThisMonth,
      };
    });
  }

  // -------------------------------------------------------------------------
  // One request
  // -------------------------------------------------------------------------

  async get(context: TenantContext, requestId: string): Promise<AttestationRequestReviewView> {
    return this.tenant.withTenant(scopeOf(context), async (tx) => {
      const row = await this.load(tx, context, requestId);
      return this.reviewView(tx, context, row);
    });
  }

  /** A short-lived link to the submitted file, for this organization's reviewers. */
  async artifactLink(
    context: TenantContext,
    requestId: string,
    disposition: 'inline' | 'attachment',
  ): Promise<DownloadAuthorizationView> {
    const artifact = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      const row = await this.load(tx, context, requestId);
      const current = currentArtifact(row);
      if (current === null) {
        throw new AppError(PalCertErrorCode.ATTESTATION_ARTIFACT_NOT_FOUND, {
          message: 'This request has no file.',
        });
      }
      return current;
    });
    const link = await this.artifacts.download(artifact, disposition);
    await this.events.audit({
      action: 'ATTESTATION_ARTIFACT_VIEWED',
      actorUserId: context.userId,
      targetType: 'AttestationArtifact',
      targetId: artifact.id,
      requestId: context.requestId,
      afterState: { attestationRequestId: requestId, organizationId: context.organizationId },
    });
    return link;
  }

  async verificationUrl(context: TenantContext, attestationId: string): Promise<string> {
    const row = await this.tenant.withTenant(scopeOf(context), (tx) =>
      tx.attestation.findFirst({
        where: { id: attestationId, organizationId: context.organizationId },
      }),
    );
    if (row === null) throw attestationNotFound();
    const token = openAttestationToken(row.publicTokenSealed, this.tokenKey);
    if (token === null) throw attestationNotFound();
    return verificationUrlFor(this.config.publicWebUrl, token);
  }

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  async startReview(
    context: TenantContext,
    requestId: string,
  ): Promise<AttestationRequestReviewView> {
    return this.tenant.withTenant(scopeOf(context), async (tx) => {
      const row = await this.lock(tx, context, requestId);
      if (row.status === AttestationRequestStatus.IN_REVIEW)
        return this.reviewView(tx, context, row);
      if (row.status !== AttestationRequestStatus.SUBMITTED) {
        throw transitionInvalid(row.status as AttestationRequestStatus, 'taken into review');
      }
      const now = this.clock.now();
      await tx.attestationRequest.update({
        where: { id: row.id },
        data: {
          status: AttestationRequestStatus.IN_REVIEW,
          reviewStartedAt: row.reviewStartedAt ?? now,
          assignedReviewerUserId: row.assignedReviewerUserId ?? context.userId,
          updatedAt: now,
        },
      });
      await this.history(tx, context, row, AttestationRequestEventType.REVIEW_STARTED, {
        from: AttestationRequestStatus.SUBMITTED,
        to: AttestationRequestStatus.IN_REVIEW,
        at: now,
      });
      await this.events.auditWithin(tx, {
        action: 'ATTESTATION_REVIEW_STARTED',
        actorUserId: context.userId,
        targetType: 'AttestationRequest',
        targetId: row.id,
        requestId: context.requestId,
        afterState: { organizationId: context.organizationId },
      });
      return this.reviewView(tx, context, await this.load(tx, context, requestId));
    });
  }

  /** Assign to a named reviewer of this organization, or clear the assignment. */
  async assign(
    context: TenantContext,
    requestId: string,
    reviewerUserId: string | null,
  ): Promise<AttestationRequestReviewView> {
    return this.tenant.withTenant(scopeOf(context), async (tx) => {
      const row = await this.lock(tx, context, requestId);
      const status = row.status as AttestationRequestStatus;
      if (
        status !== AttestationRequestStatus.SUBMITTED &&
        status !== AttestationRequestStatus.IN_REVIEW &&
        status !== AttestationRequestStatus.NEEDS_INFORMATION
      ) {
        throw transitionInvalid(status, 'reassigned');
      }
      if (reviewerUserId !== null) {
        const names = await this.memberNames(tx, [reviewerUserId]);
        if (!names.has(reviewerUserId)) {
          throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
            message: 'That person is not a member of this organization.',
          });
        }
      }
      const now = this.clock.now();
      await tx.attestationRequest.update({
        where: { id: row.id },
        data: { assignedReviewerUserId: reviewerUserId, updatedAt: now },
      });
      await this.history(tx, context, row, AttestationRequestEventType.ASSIGNED, { at: now });
      await this.events.auditWithin(tx, {
        action: 'ATTESTATION_REVIEWER_ASSIGNED',
        actorUserId: context.userId,
        targetType: 'AttestationRequest',
        targetId: row.id,
        requestId: context.requestId,
        afterState: { assignedReviewerUserId: reviewerUserId },
      });
      return this.reviewView(tx, context, await this.load(tx, context, requestId));
    });
  }

  async requestInformation(
    context: TenantContext,
    requestId: string,
    message: string,
  ): Promise<AttestationRequestReviewView> {
    const text = cleanText(message);
    if (text === null) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'Write what you need from the requester.',
      });
    }
    return this.tenant.withTenant(scopeOf(context), async (tx) => {
      const row = await this.lock(tx, context, requestId);
      if (row.status !== AttestationRequestStatus.IN_REVIEW) {
        throw transitionInvalid(
          row.status as AttestationRequestStatus,
          'sent back for information',
        );
      }
      const now = this.clock.now();
      await tx.attestationRequest.update({
        where: { id: row.id },
        data: {
          status: AttestationRequestStatus.NEEDS_INFORMATION,
          openInformationRequest: text,
          updatedAt: now,
        },
      });
      const event = await this.history(
        tx,
        context,
        row,
        AttestationRequestEventType.INFORMATION_REQUESTED,
        {
          from: AttestationRequestStatus.IN_REVIEW,
          to: AttestationRequestStatus.NEEDS_INFORMATION,
          message: text,
          at: now,
        },
      );
      await this.events.auditWithin(tx, {
        action: 'ATTESTATION_INFORMATION_REQUESTED',
        actorUserId: context.userId,
        targetType: 'AttestationRequest',
        targetId: row.id,
        requestId: context.requestId,
        afterState: { organizationId: context.organizationId },
      });
      await this.domainEvents.emitAttestation(
        tx,
        event.id,
        NotificationType.ATTESTATION_INFORMATION_REQUESTED,
      );
      return this.reviewView(tx, context, await this.load(tx, context, requestId));
    });
  }

  async reject(
    context: TenantContext,
    requestId: string,
    reason: string,
  ): Promise<AttestationRequestReviewView> {
    const text = cleanText(reason);
    if (text === null) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'A rejection needs a reason the requester will read.',
      });
    }
    const outcome = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      const row = await this.lock(tx, context, requestId);
      const status = row.status as AttestationRequestStatus;
      if (
        status !== AttestationRequestStatus.IN_REVIEW &&
        status !== AttestationRequestStatus.NEEDS_INFORMATION
      ) {
        throw transitionInvalid(status, 'rejected');
      }
      const now = this.clock.now();
      const decided = await tx.attestationRequest.updateMany({
        where: { id: row.id, status },
        data: {
          status: AttestationRequestStatus.REJECTED,
          rejectionReason: text,
          decidedAt: now,
          openInformationRequest: null,
          updatedAt: now,
        },
      });
      if (decided.count !== 1) throw transitionInvalid(status, 'rejected');

      const event = await this.history(tx, context, row, AttestationRequestEventType.REJECTED, {
        from: status,
        to: AttestationRequestStatus.REJECTED,
        message: text,
        at: now,
      });
      const job = await this.enqueuePayment(tx, row.id, row.paymentStatus);
      await this.events.auditWithin(tx, {
        action: 'ATTESTATION_REJECTED',
        actorUserId: context.userId,
        targetType: 'AttestationRequest',
        targetId: row.id,
        requestId: context.requestId,
        afterState: { organizationId: context.organizationId, releaseQueued: job !== null },
      });
      await this.domainEvents.emitAttestation(tx, event.id, NotificationType.ATTESTATION_REJECTED);
      return {
        view: await this.reviewView(tx, context, await this.load(tx, context, requestId)),
        job,
      };
    });
    if (outcome.job !== null) await this.dispatcher.dispatchNow(outcome.job.id);
    return outcome.view;
  }

  /**
   * Approve, and write the immutable attestation, in one transaction.
   *
   * Before anything is written the stored artifact is read back from storage
   * and hashed again: the attestation must be over the bytes that exist, not
   * over a digest remembered from upload. A mismatch refuses the approval.
   */
  async approve(
    context: TenantContext,
    requestId: string,
    input: ApproveInput,
  ): Promise<AttestationRequestReviewView> {
    if (input.confirm !== true) {
      throw new AppError(PalCertErrorCode.ATTESTATION_CONFIRMATION_REQUIRED, {
        message: 'Confirm that you reviewed this certificate before approving.',
      });
    }

    // Outside any transaction: reading up to 20 MB must not hold a row lock.
    const artifact = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      const row = await this.load(tx, context, requestId);
      if (row.status !== AttestationRequestStatus.IN_REVIEW) {
        throw transitionInvalid(row.status as AttestationRequestStatus, 'approved');
      }
      const current = currentArtifact(row);
      if (current === null || current.status !== AttestationArtifactStatus.READY) {
        throw new AppError(PalCertErrorCode.ATTESTATION_ARTIFACT_NOT_READY, {
          message: 'This request has no verified file to attest.',
        });
      }
      return current;
    });
    await this.reverify(artifact);

    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const outcome = await this.tenant.withTenant(scopeOf(context), (tx) =>
          this.approveWithin(tx, context, requestId, artifact, input),
        );
        if (outcome.job !== null) await this.dispatcher.dispatchNow(outcome.job.id);
        return outcome.view;
      } catch (error) {
        // A reference or token collision is astronomically unlikely and is not
        // a decision the reviewer made; retry with fresh random values.
        const collision =
          isUniqueViolation(error, 'reference') || isUniqueViolation(error, 'token');
        if (collision && attempt < 3) continue;
        throw error;
      }
    }
  }

  async revoke(
    context: TenantContext,
    attestationId: string,
    reason: string,
  ): Promise<AttestationRequestReviewView> {
    const text = cleanText(reason);
    if (text === null) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'A revocation needs a reason.',
      });
    }
    return this.tenant.withTenant(scopeOf(context), async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "attestations" WHERE "id" = ${attestationId}::uuid FOR UPDATE`;
      const attestation = await tx.attestation.findFirst({
        where: { id: attestationId, organizationId: context.organizationId },
      });
      if (attestation === null) throw attestationNotFound();
      if (attestation.revokedAt !== null) {
        throw new AppError(PalCertErrorCode.ATTESTATION_ALREADY_REVOKED, {
          message: 'This attestation has already been revoked.',
        });
      }
      const now = this.clock.now();
      await tx.attestation.update({
        where: { id: attestation.id },
        data: { revokedAt: now, revokedByUserId: context.userId, revocationReason: text },
      });
      const row = await this.load(tx, context, attestation.requestId);
      const event = await this.history(tx, context, row, AttestationRequestEventType.REVOKED, {
        message: text,
        at: now,
      });
      await this.events.auditWithin(tx, {
        action: 'ATTESTATION_REVOKED',
        actorUserId: context.userId,
        targetType: 'Attestation',
        targetId: attestation.id,
        requestId: context.requestId,
        afterState: {
          organizationId: context.organizationId,
          reference: attestation.reference,
          // Policy, recorded where an auditor will look: no automatic refund.
          refund: 'NONE',
        },
      });
      await this.domainEvents.emitAttestation(tx, event.id, NotificationType.ATTESTATION_REVOKED);
      return this.reviewView(tx, context, await this.load(tx, context, attestation.requestId));
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async approveWithin(
    tx: TenantClient,
    context: TenantContext,
    requestId: string,
    artifact: AttestationArtifact,
    input: ApproveInput,
  ) {
    const row = await this.lock(tx, context, requestId);
    if (row.status !== AttestationRequestStatus.IN_REVIEW) {
      throw transitionInvalid(row.status as AttestationRequestStatus, 'approved');
    }
    if (row.currentArtifactId !== artifact.id) {
      throw new AppError(PalCertErrorCode.ATTESTATION_ARTIFACT_INTEGRITY_FAILED, {
        message:
          'The certificate file changed while you were reviewing it. Reload and review again.',
      });
    }

    // PalCert's own verification of the institution, as it stands now. An
    // unverified organization cannot put its name on a PalCert attestation.
    const organization = await tx.organization.findUnique({
      where: { id: context.organizationId },
      select: { displayName: true, status: true, verificationStatus: true },
    });
    if (
      organization === null ||
      organization.status !== 'ACTIVE' ||
      organization.verificationStatus !== 'VERIFIED'
    ) {
      throw new AppError(PalCertErrorCode.ATTESTATION_ORGANIZATION_UNAVAILABLE, {
        message: 'Only an active organization verified by PalCert can approve attestations.',
      });
    }

    const now = this.clock.now();
    const confirmed = confirmedMetadata(input);
    const validity = resolveValidity(input, row, now);
    const token = generateAttestationToken();
    const reference = generateAttestationReference(now.getUTCFullYear());
    const manifestHash = attestationManifestHash({
      manifestVersion: ATTESTATION_MANIFEST_VERSION,
      reference,
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      attestationTypeId: row.attestationTypeId,
      attestationTypeNameEn: row.typeNameEn,
      artifact: {
        sha256: artifact.sha256!,
        sizeBytes: artifact.sizeBytes!,
        mimeType: artifact.detectedMimeType!,
      },
      certificate: {
        title: confirmed.certificateTitle,
        type: confirmed.certificateType,
        holderName: confirmed.holderName,
        issuingOrganization: confirmed.issuingOrganization,
        issueDate:
          confirmed.issueDate === null ? null : confirmed.issueDate.toISOString().slice(0, 10),
        referenceNumber: confirmed.referenceNumber,
      },
      validFrom: validity.validFrom.toISOString(),
      validUntil: validity.validUntil?.toISOString() ?? null,
      approvedAt: now.toISOString(),
      approvedByUserId: context.userId,
      previousAttestationId: row.previousAttestationId,
    });

    const decided = await tx.attestationRequest.updateMany({
      where: { id: row.id, status: AttestationRequestStatus.IN_REVIEW },
      data: { status: AttestationRequestStatus.APPROVED, decidedAt: now, updatedAt: now },
    });
    if (decided.count !== 1)
      throw transitionInvalid(AttestationRequestStatus.IN_REVIEW, 'approved');

    const attestation = await tx.attestation.create({
      data: {
        requestId: row.id,
        ownerUserId: row.ownerUserId,
        organizationId: row.organizationId,
        attestationTypeId: row.attestationTypeId,
        reference,
        publicTokenHash: attestationTokenHash(token),
        publicTokenSealed: sealAttestationToken(token, this.tokenKey),
        artifactId: artifact.id,
        artifactSha256: artifact.sha256!,
        artifactSizeBytes: artifact.sizeBytes!,
        artifactMimeType: artifact.detectedMimeType!,
        artifactCleanObjectKey: artifact.cleanObjectKey!,
        artifactCleanObjectVersionId: artifact.cleanObjectVersionId,
        organizationName: row.organizationName,
        organizationVerifiedAtApproval: true,
        typeNameEn: row.typeNameEn,
        typeNameAr: row.typeNameAr,
        certificateTitle: confirmed.certificateTitle,
        certificateType: confirmed.certificateType,
        holderName: confirmed.holderName,
        issuingOrganization: confirmed.issuingOrganization,
        issueDate: confirmed.issueDate,
        referenceNumber: confirmed.referenceNumber,
        holderNamePublic: input.holderNamePublic ?? true,
        referenceNumberPublic: input.referenceNumberPublic ?? true,
        institutionNote: cleanText(input.institutionNote ?? null),
        validFrom: validity.validFrom,
        validUntil: validity.validUntil,
        reminderDays: row.reminderDays.length > 0 ? row.reminderDays : [30, 14, 7, 1],
        approvedByUserId: context.userId,
        approvedAt: now,
        manifestVersion: ATTESTATION_MANIFEST_VERSION,
        attestationHash: manifestHash,
        previousAttestationId: row.previousAttestationId,
        createdAt: now,
      },
    });

    const event = await this.history(tx, context, row, AttestationRequestEventType.APPROVED, {
      from: AttestationRequestStatus.IN_REVIEW,
      to: AttestationRequestStatus.APPROVED,
      at: now,
    });
    const job = await this.enqueuePayment(tx, row.id, row.paymentStatus);
    await this.events.auditWithin(tx, {
      action: 'ATTESTATION_APPROVED',
      actorUserId: context.userId,
      targetType: 'AttestationRequest',
      targetId: row.id,
      requestId: context.requestId,
      afterState: {
        organizationId: context.organizationId,
        attestationId: attestation.id,
        reference,
        artifactSha256Prefix: artifact.sha256!.slice(0, 12),
        validFrom: validity.validFrom.toISOString(),
        validUntil: validity.validUntil?.toISOString() ?? null,
        settlementQueued: job !== null,
      },
    });
    await this.domainEvents.emitAttestation(tx, event.id, NotificationType.ATTESTATION_APPROVED);
    return {
      view: await this.reviewView(tx, context, await this.load(tx, context, requestId)),
      job,
    };
  }

  /** Hash the stored bytes again and compare with what ingestion measured. */
  private async reverify(artifact: AttestationArtifact): Promise<void> {
    if (artifact.cleanObjectKey === null || artifact.sha256 === null) {
      throw integrityFailed();
    }
    const { stream } = await this.storage
      .getObjectStream({
        zone: 'clean',
        key: artifact.cleanObjectKey,
        versionId: artifact.cleanObjectVersionId,
      })
      .catch((error: unknown) => {
        throw storageUnavailable(error);
      });
    const digest = await sha256Stream(stream);
    if (digest.sha256 !== artifact.sha256 || digest.sizeBytes !== artifact.sizeBytes) {
      this.logger.error(
        { artifactId: artifact.id, expectedPrefix: artifact.sha256.slice(0, 12) },
        'Stored attestation artifact no longer matches its fingerprint',
      );
      throw integrityFailed();
    }
  }

  private async enqueuePayment(tx: TenantClient, requestId: string, paymentStatus: string) {
    if (paymentStatus !== AttestationPaymentStatus.RESERVED) return null;
    return this.jobs.enqueueInTransaction(tx, {
      type: ProcessingJobType.ATTESTATION_PAYMENT,
      resourceType: 'ATTESTATION_REQUEST',
      resourceId: requestId,
    });
  }

  private async history(
    tx: TenantClient,
    context: TenantContext,
    row: { id: string; ownerUserId: string; organizationId: string },
    eventType: AttestationRequestEventType,
    params: {
      readonly from?: AttestationRequestStatus;
      readonly to?: AttestationRequestStatus;
      readonly message?: string;
      readonly at: Date;
    },
  ) {
    return tx.attestationRequestEvent.create({
      data: {
        requestId: row.id,
        ownerUserId: row.ownerUserId,
        organizationId: row.organizationId,
        eventType,
        actorSide: AttestationActorSide.ORGANIZATION,
        actorUserId: context.userId,
        fromStatus: params.from ?? null,
        toStatus: params.to ?? null,
        message: params.message ?? null,
        createdAt: params.at,
      },
    });
  }

  private async load(
    tx: TenantClient,
    context: TenantContext,
    requestId: string,
  ): Promise<RequestRow & { artifacts: AttestationArtifact[] }> {
    const row = await tx.attestationRequest.findUnique({
      where: { id: requestId },
      include: REVIEW_INCLUDE,
    });
    // Another organization's request, and a draft, are both simply absent.
    if (
      row === null ||
      row.organizationId !== context.organizationId ||
      row.status === AttestationRequestStatus.DRAFT
    ) {
      throw requestNotFound();
    }
    return row;
  }

  private async lock(tx: TenantClient, context: TenantContext, requestId: string) {
    await tx.$queryRaw`SELECT "id" FROM "attestation_requests" WHERE "id" = ${requestId}::uuid FOR UPDATE`;
    return this.load(tx, context, requestId);
  }

  private async owners(
    tx: TenantClient,
    requestIds: readonly string[],
  ): Promise<Map<string, { displayName: string; email: string }>> {
    if (requestIds.length === 0) return new Map();
    const rows = await tx.$queryRaw<
      Array<{ request_id: string; display_name: string; email: string }>
    >`
      SELECT * FROM app_attestation_request_owners(${[...requestIds]}::uuid[])`;
    return new Map(
      rows.map((row) => [row.request_id, { displayName: row.display_name, email: row.email }]),
    );
  }

  private async memberNames(
    tx: TenantClient,
    userIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await tx.$queryRaw<Array<{ user_id: string; display_name: string }>>`
      SELECT * FROM app_attestation_member_names(${[...new Set(userIds)]}::uuid[])`;
    return new Map(rows.map((row) => [row.user_id, row.display_name]));
  }

  /** Which of these requests share their file's bytes with another request to this organization. */
  private async duplicateFlags(
    tx: TenantClient,
    organizationId: string,
    rows: ReadonlyArray<{
      id: string;
      currentArtifactId: string | null;
      artifacts: Array<{ id: string; sha256: string | null }>;
    }>,
  ): Promise<Set<string>> {
    const shaByRequest = new Map<string, string>();
    for (const row of rows) {
      const sha =
        row.artifacts.find((artifact) => artifact.id === row.currentArtifactId)?.sha256 ?? null;
      if (sha !== null) shaByRequest.set(row.id, sha);
    }
    if (shaByRequest.size === 0) return new Set();
    const others = await tx.attestationArtifact.findMany({
      where: {
        organizationId,
        sha256: { in: [...new Set(shaByRequest.values())] },
        request: { status: { not: AttestationRequestStatus.DRAFT } },
      },
      select: { requestId: true, sha256: true },
    });
    const flagged = new Set<string>();
    for (const [requestId, sha] of shaByRequest) {
      if (others.some((other) => other.sha256 === sha && other.requestId !== requestId))
        flagged.add(requestId);
    }
    return flagged;
  }

  private queueWhere(
    context: TenantContext,
    query: QueueQuery,
    now: Date,
  ): Prisma.AttestationRequestWhereInput {
    const tab = (QUEUE_TABS as readonly string[]).includes(query.status ?? '')
      ? (query.status as QueueTab)
      : 'ALL';
    const where: Prisma.AttestationRequestWhereInput = {
      organizationId: context.organizationId,
      status: { not: AttestationRequestStatus.DRAFT },
    };
    const and: Prisma.AttestationRequestWhereInput[] = [];
    switch (tab) {
      case 'PENDING':
        and.push({ status: AttestationRequestStatus.SUBMITTED });
        break;
      case 'IN_REVIEW':
        and.push({ status: AttestationRequestStatus.IN_REVIEW });
        break;
      case 'AWAITING_INFORMATION':
        and.push({ status: AttestationRequestStatus.NEEDS_INFORMATION });
        break;
      case 'APPROVED':
        and.push({ status: AttestationRequestStatus.APPROVED });
        break;
      case 'REJECTED':
        and.push({ status: AttestationRequestStatus.REJECTED });
        break;
      case 'REVOKED':
        and.push({ attestation: { revokedAt: { not: null } } });
        break;
      case 'EXPIRED':
        and.push({ attestation: { revokedAt: null, validUntil: { lte: now } } });
        break;
      default:
        break;
    }
    if (query.attestationTypeId !== undefined)
      and.push({ attestationTypeId: query.attestationTypeId });
    if (query.reviewerUserId !== undefined)
      and.push({ assignedReviewerUserId: query.reviewerUserId });
    if (query.paymentStatus !== undefined) and.push({ paymentStatus: query.paymentStatus });
    if (query.validity !== undefined) {
      if (query.validity === AttestationVerificationStatus.REVOKED) {
        and.push({ attestation: { revokedAt: { not: null } } });
      } else if (query.validity === AttestationVerificationStatus.EXPIRED) {
        and.push({ attestation: { revokedAt: null, validUntil: { lte: now } } });
      } else {
        and.push({
          attestation: { revokedAt: null, OR: [{ validUntil: null }, { validUntil: { gt: now } }] },
        });
      }
    }
    if (query.submittedFrom !== undefined && isCalendarDate(query.submittedFrom)) {
      and.push({ submittedAt: { gte: parseIsoDate(query.submittedFrom)! } });
    }
    if (query.submittedTo !== undefined && isCalendarDate(query.submittedTo)) {
      and.push({
        submittedAt: { lt: new Date(parseIsoDate(query.submittedTo)!.getTime() + DAY_MS) },
      });
    }
    const search = cleanText(query.search ?? null);
    if (search !== null) {
      and.push({
        OR: [
          { certificateTitle: { contains: search, mode: 'insensitive' } },
          { referenceNumber: { contains: search, mode: 'insensitive' } },
          { recipientName: { contains: search, mode: 'insensitive' } },
          { attestation: { reference: { contains: search.toUpperCase() } } },
        ],
      });
    }
    return and.length === 0 ? where : { ...where, AND: and };
  }

  private async reviewView(
    tx: TenantClient,
    context: TenantContext,
    row: RequestRow & { artifacts: AttestationArtifact[] },
  ): Promise<AttestationRequestReviewView> {
    const now = this.clock.now();
    const owners = await this.owners(tx, [row.id]);
    const reviewerNames =
      row.assignedReviewerUserId === null
        ? new Map<string, string>()
        : await this.memberNames(tx, [row.assignedReviewerUserId]);
    const current = currentArtifact(row);
    let sameArtifactRequests: AttestationRequestReviewView['sameArtifactRequests'] = [];
    if (current?.sha256) {
      const others = await tx.attestationArtifact.findMany({
        where: {
          organizationId: context.organizationId,
          sha256: current.sha256,
          requestId: { not: row.id },
          request: { status: { not: AttestationRequestStatus.DRAFT } },
        },
        select: { request: { select: { id: true, status: true, submittedAt: true } } },
        take: 20,
      });
      const seen = new Set<string>();
      sameArtifactRequests = others
        .map((other) => other.request)
        .filter((request) => (seen.has(request.id) ? false : (seen.add(request.id), true)))
        .map((request) => ({
          id: request.id,
          status: request.status as AttestationRequestStatus,
          submittedAt: request.submittedAt?.toISOString() ?? null,
        }));
    }
    const attestation: Attestation | null = row.attestation ?? null;
    let verificationUrl: string | null = null;
    if (attestation !== null) {
      const token = openAttestationToken(attestation.publicTokenSealed, this.tokenKey);
      verificationUrl = token === null ? null : verificationUrlFor(this.config.publicWebUrl, token);
    }
    const owner = owners.get(row.id);
    return {
      id: row.id,
      status: row.status as AttestationRequestStatus,
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      attestationTypeId: row.attestationTypeId,
      attestationTypeName: { en: row.typeNameEn, ar: row.typeNameAr },
      submitted: submittedMetadata(row),
      notesForReviewer: row.notesForReviewer,
      artifact: artifactView(current),
      previousAttestationId: row.previousAttestationId,
      createdAt: row.createdAt.toISOString(),
      submittedAt: row.submittedAt?.toISOString() ?? null,
      reviewStartedAt: row.reviewStartedAt?.toISOString() ?? null,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
      openInformationRequest: row.openInformationRequest,
      rejectionReason: row.rejectionReason,
      history: (row.events ?? []).map(eventView),
      attestation: attestation === null ? null : recordView(attestation, { now, verificationUrl }),
      owner: { displayName: owner?.displayName ?? '', email: owner?.email ?? '' },
      feeSnapshot: feeSnapshotView(row),
      assignedReviewer:
        row.assignedReviewerUserId === null
          ? null
          : {
              userId: row.assignedReviewerUserId,
              displayName: reviewerNames.get(row.assignedReviewerUserId) ?? '',
            },
      sameArtifactRequests,
      typePolicy: {
        defaultValidityDays: row.defaultValidityDays,
        allowNoExpiry: row.allowNoExpiry ?? false,
        reviewerMayOverrideValidity: row.reviewerMayOverrideValidity ?? true,
      },
    };
  }
}

// ---------------------------------------------------------------------------

function attestationNotFound(): AppError {
  return new AppError(PalCertErrorCode.ATTESTATION_NOT_FOUND, { message: 'No such attestation.' });
}

function integrityFailed(): AppError {
  return new AppError(PalCertErrorCode.ATTESTATION_ARTIFACT_INTEGRITY_FAILED, {
    message:
      'The stored certificate file no longer matches its recorded fingerprint. It cannot be attested.',
  });
}

function encodeOffset(offset: number): string {
  return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
}

function decodeOffset(cursor: string | undefined): number {
  if (cursor === undefined || cursor === '') return 0;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^o:(\d{1,7})$/.exec(decoded);
  return match === null ? 0 : Number(match[1]);
}

function confirmedMetadata(input: ApproveInput) {
  const title = cleanText(input.certificateTitle);
  if (title === null || title.length > 300) {
    throw new AppError(PalCertErrorCode.ATTESTATION_METADATA_INVALID, {
      message: 'Confirm the certificate title.',
      details: { field: 'certificateTitle' },
    });
  }
  let issueDate: Date | null = null;
  if (input.issueDate !== undefined && input.issueDate !== null && input.issueDate !== '') {
    if (!isCalendarDate(input.issueDate)) {
      throw new AppError(PalCertErrorCode.ATTESTATION_METADATA_INVALID, {
        message: 'The issue date must be a real date in YYYY-MM-DD form.',
        details: { field: 'issueDate' },
      });
    }
    issueDate = parseIsoDate(input.issueDate);
  }
  return {
    certificateTitle: title,
    certificateType: cleanText(input.certificateType ?? null),
    holderName: cleanText(input.holderName ?? null),
    issuingOrganization: cleanText(input.issuingOrganization ?? null),
    issueDate,
    referenceNumber: cleanText(input.referenceNumber ?? null),
  };
}

/**
 * Explicit validity instants, from the reviewer's input and the policy the
 * request was submitted under. Stored as instants, never recomputed later.
 */
function resolveValidity(
  input: ApproveInput,
  row: {
    defaultValidityDays: number | null;
    allowNoExpiry: boolean | null;
    reviewerMayOverrideValidity: boolean | null;
  },
  now: Date,
): { validFrom: Date; validUntil: Date | null } {
  const invalid = (message: string) =>
    new AppError(PalCertErrorCode.ATTESTATION_VALIDITY_INVALID, { message });

  let validFrom = now;
  if (input.validFrom !== undefined && input.validFrom !== null && input.validFrom !== '') {
    const parsed = new Date(input.validFrom);
    if (Number.isNaN(parsed.getTime())) throw invalid('validFrom is not a valid date.');
    validFrom = parsed;
  }
  const mayOverride = row.reviewerMayOverrideValidity ?? true;
  const allowNoExpiry = row.allowNoExpiry ?? false;

  const wantsCustom =
    (input.validUntil !== undefined && input.validUntil !== null && input.validUntil !== '') ||
    (input.validityDays !== undefined && input.validityDays !== null);

  if (input.noExpiry === true) {
    if (!allowNoExpiry)
      throw invalid('This attestation type does not allow an attestation without expiry.');
    if (wantsCustom) throw invalid('Choose either an expiry or no expiration, not both.');
    return { validFrom, validUntil: null };
  }

  let validUntil: Date | null;
  if (!wantsCustom) {
    if (row.defaultValidityDays === null) {
      throw invalid('Choose how long this attestation is valid.');
    }
    validUntil = addValidityDays(validFrom, row.defaultValidityDays);
  } else {
    if (!mayOverride) {
      throw invalid('This attestation type fixes the validity period; reviewers cannot change it.');
    }
    if (input.validUntil !== undefined && input.validUntil !== null && input.validUntil !== '') {
      const parsed = new Date(input.validUntil);
      if (Number.isNaN(parsed.getTime())) throw invalid('validUntil is not a valid date.');
      validUntil = parsed;
    } else {
      const days = input.validityDays!;
      if (!Number.isInteger(days) || days < 1 || days > MAX_ATTESTATION_VALIDITY_DAYS) {
        throw invalid(`The validity must be between 1 and ${MAX_ATTESTATION_VALIDITY_DAYS} days.`);
      }
      validUntil = addValidityDays(validFrom, days);
    }
  }
  if (validUntil.getTime() <= validFrom.getTime())
    throw invalid('validUntil must be after validFrom.');
  if (validUntil.getTime() <= now.getTime())
    throw invalid('An attestation cannot be issued already expired.');
  if (validUntil.getTime() - validFrom.getTime() > MAX_ATTESTATION_VALIDITY_DAYS * DAY_MS) {
    throw invalid('The validity period is too long.');
  }
  if (validFrom.getTime() > now.getTime() + 366 * DAY_MS) {
    throw invalid('validFrom may be at most a year in the future.');
  }
  return { validFrom, validUntil };
}
