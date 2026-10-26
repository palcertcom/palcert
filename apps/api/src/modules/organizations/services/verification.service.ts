import { Injectable } from '@nestjs/common';
import {
  AppError,
  OrganizationVerificationStatus,
  PalCertErrorCode,
  SecurityEventType,
  VerificationRequestStatus,
  canTransitionVerificationStatus,
  type OrganizationVerificationView,
} from '@palcert/contracts';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import type { TenantContext } from '../tenant-context';

/**
 * Organization identity verification (§25, §26).
 *
 * Deliberately a maintainable foundation rather than a KYC platform: request,
 * approve, reject, resubmit, read status. Each attempt is its own row, so a
 * rejection followed by a resubmission produces a history instead of
 * overwriting the earlier decision — which is what makes the workflow
 * extensible to evidence upload later without replacing it.
 */
@Injectable()
export class VerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantPrismaService,
    private readonly clock: ClockPort,
    private readonly events: SecurityEventService,
  ) {}

  async view(context: TenantContext): Promise<OrganizationVerificationView> {
    return this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      async (tx) => {
        const organization = await tx.organization.findUniqueOrThrow({
          where: { id: context.organizationId },
          select: { verificationStatus: true },
        });

        const latest = await tx.organizationVerificationRequest.findFirst({
          where: { organizationId: context.organizationId },
          orderBy: { requestedAt: 'desc' },
        });

        const status = organization.verificationStatus as OrganizationVerificationStatus;

        return {
          status,
          requestedAt: latest?.requestedAt.toISOString() ?? null,
          reviewedAt: latest?.reviewedAt?.toISOString() ?? null,
          // Only the applicant-facing reason. `internalNotes` is never read
          // here, so a reviewer's private note cannot reach the organization.
          decisionReason: latest?.decisionReason ?? null,
          canRequest: canTransitionVerificationStatus(
            status,
            OrganizationVerificationStatus.PENDING,
          ),
        };
      },
    );
  }

  async request(
    context: TenantContext,
    note: string | undefined,
  ): Promise<OrganizationVerificationView> {
    await this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      async (tx) => {
        const organization = await tx.organization.findUniqueOrThrow({
          where: { id: context.organizationId },
          select: { verificationStatus: true },
        });

        const current = organization.verificationStatus as OrganizationVerificationStatus;

        if (current === OrganizationVerificationStatus.VERIFIED) {
          throw new AppError(PalCertErrorCode.ORGANIZATION_ALREADY_VERIFIED, {
            message: 'This organization is already verified.',
          });
        }
        if (current === OrganizationVerificationStatus.PENDING) {
          throw new AppError(PalCertErrorCode.ORGANIZATION_VERIFICATION_PENDING, {
            message: 'A verification request is already under review.',
          });
        }
        if (!canTransitionVerificationStatus(current, OrganizationVerificationStatus.PENDING)) {
          throw new AppError(PalCertErrorCode.CONFLICT, {
            message: 'Verification cannot be requested from this state.',
            details: { status: current },
          });
        }

        await tx.organizationVerificationRequest.create({
          data: {
            organizationId: context.organizationId,
            status: VerificationRequestStatus.PENDING,
            requestedByUserId: context.userId,
            requestedAt: this.clock.now(),
            submissionNote: note?.trim() || null,
          },
        });

        await tx.organization.update({
          where: { id: context.organizationId },
          data: { verificationStatus: OrganizationVerificationStatus.PENDING },
        });
      },
    );

    await this.events.record({
      type: SecurityEventType.ORGANIZATION_VERIFICATION_REQUESTED,
      userId: context.userId,
      actorUserId: context.userId,
      metadata: { organizationId: context.organizationId },
      requestId: context.requestId,
    });
    await this.events.audit({
      action: 'ORGANIZATION_VERIFICATION_REQUESTED',
      actorUserId: context.userId,
      targetType: 'Organization',
      targetId: context.organizationId,
      requestId: context.requestId,
      afterState: { verificationStatus: OrganizationVerificationStatus.PENDING },
    });

    return this.view(context);
  }

  /**
   * PalCert staff decision. Runs through the explicit elevated path, because
   * the reviewer is by definition not a member of the organization (§22).
   */
  async decide(params: {
    actorUserId: string;
    organizationId: string;
    approve: boolean;
    decisionReason?: string | undefined;
    internalNotes?: string | undefined;
    requestId: string | null;
  }): Promise<{ status: OrganizationVerificationStatus }> {
    const nextStatus = params.approve
      ? OrganizationVerificationStatus.VERIFIED
      : OrganizationVerificationStatus.REJECTED;

    const previous = await this.tenant.withPlatformAdmin(
      {
        actorUserId: params.actorUserId,
        organizationId: params.organizationId,
        reason: `Organization verification decision: ${params.approve ? 'approve' : 'reject'}`,
      },
      async (tx) => {
        const organization = await tx.organization.findUnique({
          where: { id: params.organizationId },
          select: { verificationStatus: true },
        });
        if (organization === null) {
          throw new AppError(PalCertErrorCode.ORGANIZATION_NOT_FOUND, {
            message: 'Organization not found.',
          });
        }

        const current = organization.verificationStatus as OrganizationVerificationStatus;
        if (!canTransitionVerificationStatus(current, nextStatus)) {
          throw new AppError(PalCertErrorCode.CONFLICT, {
            message: `Verification cannot move from ${current} to ${nextStatus}.`,
            details: { from: current, to: nextStatus },
          });
        }

        const pending = await tx.organizationVerificationRequest.findFirst({
          where: {
            organizationId: params.organizationId,
            status: VerificationRequestStatus.PENDING,
          },
          orderBy: { requestedAt: 'desc' },
        });
        if (pending === null) {
          throw new AppError(PalCertErrorCode.NOT_FOUND, {
            message: 'There is no verification request awaiting review.',
          });
        }

        await tx.organizationVerificationRequest.update({
          where: { id: pending.id },
          data: {
            status: params.approve
              ? VerificationRequestStatus.APPROVED
              : VerificationRequestStatus.REJECTED,
            reviewedByUserId: params.actorUserId,
            reviewedAt: this.clock.now(),
            decisionReason: params.decisionReason?.trim() || null,
            internalNotes: params.internalNotes?.trim() || null,
          },
        });

        await tx.organization.update({
          where: { id: params.organizationId },
          data: { verificationStatus: nextStatus },
        });

        return current;
      },
    );

    await this.events.record({
      type: params.approve
        ? SecurityEventType.ORGANIZATION_VERIFIED
        : SecurityEventType.ORGANIZATION_VERIFICATION_REJECTED,
      actorUserId: params.actorUserId,
      metadata: { organizationId: params.organizationId },
      requestId: params.requestId,
    });
    await this.events.audit({
      action: params.approve ? 'ORGANIZATION_VERIFIED' : 'ORGANIZATION_VERIFICATION_REJECTED',
      actorUserId: params.actorUserId,
      targetType: 'Organization',
      targetId: params.organizationId,
      requestId: params.requestId,
      beforeState: { verificationStatus: previous },
      // The internal reviewer note is deliberately not audited into a record
      // the organization could later be given access to.
      afterState: { verificationStatus: nextStatus },
    });

    return { status: nextStatus };
  }

  /** Pending requests awaiting PalCert review. */
  async listPending(actorUserId: string): Promise<
    Array<{
      requestId: string;
      organizationId: string;
      organizationName: string;
      requestedAt: string;
      submissionNote: string | null;
    }>
  > {
    return this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'Reviewing the organization verification queue' },
      async (tx) => {
        const rows = await tx.organizationVerificationRequest.findMany({
          where: { status: VerificationRequestStatus.PENDING },
          include: { organization: { select: { id: true, displayName: true } } },
          orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
          take: 100,
        });

        return rows.map((row) => ({
          requestId: row.id,
          organizationId: row.organization.id,
          organizationName: row.organization.displayName,
          requestedAt: row.requestedAt.toISOString(),
          submissionNote: row.submissionNote,
        }));
      },
    );
  }
}
