import { Injectable } from '@nestjs/common';
import {
  AppError,
  CERTIFICATE_REVOCATION_COMMENT_MAX_LENGTH,
  CertificateEventSource,
  CertificateEventType,
  CertificateIssuanceStatus,
  PalCertErrorCode,
  type CertificateRevocationReason,
} from '@palcert/contracts';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { DomainEventService } from '../../notifications/services/domain-event.service';
import type { TenantContext } from '../../organizations/tenant-context';

/**
 * Withdrawing a certificate (§62, §63, §70).
 *
 * Revocation changes exactly one thing: what public verification says. It does
 * not touch PalCert's technical determination, the institution's approval, the
 * Phase 14 decision history, or the issued PDF — which keeps existing, keeps
 * its hash, and whose QR now resolves to a page saying the certificate was
 * withdrawn. That is the entire reason online verification is worth having.
 *
 * Authorization is a permission, checked by the guard on the route, and then
 * checked again by the database function, which confirms the caller is acting
 * for the organization that approved the submission in the first place.
 */
@Injectable()
export class CertificateRevocationService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly events: SecurityEventService,
    private readonly domainEvents: DomainEventService,
  ) {}

  async revoke(
    context: TenantContext,
    certificateId: string,
    input: {
      readonly reasonCode: CertificateRevocationReason;
      readonly comment?: string;
    },
  ): Promise<void> {
    const comment = input.comment?.trim() ?? '';
    if (comment.length > CERTIFICATE_REVOCATION_COMMENT_MAX_LENGTH) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: `A revocation note may be at most ${CERTIFICATE_REVOCATION_COMMENT_MAX_LENGTH} characters.`,
      });
    }

    const revoked = await this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      async (tx) => {
        const certificate = await tx.complianceCertificate.findFirst({
          where: { id: certificateId, organizationId: context.organizationId },
        });
        if (certificate === null) {
          throw new AppError(PalCertErrorCode.CERTIFICATE_NOT_FOUND, {
            message: 'That certificate does not exist.',
          });
        }
        // §69: there is no un-revoke, so saying so twice is a conflict rather
        // than a silent success that implies something happened.
        if (certificate.issuanceStatus === CertificateIssuanceStatus.REVOKED) {
          throw new AppError(PalCertErrorCode.CERTIFICATE_ALREADY_REVOKED, {
            message: 'This certificate has already been revoked.',
          });
        }
        if (certificate.issuanceStatus !== CertificateIssuanceStatus.ISSUED) {
          throw new AppError(PalCertErrorCode.CERTIFICATE_NOT_ISSUED, {
            message: 'This certificate has not been issued.',
          });
        }

        const result = await tx.$queryRaw<{ app_certificate_revoke: boolean }[]>`
          SELECT app_certificate_revoke(
            ${certificateId}::uuid,
            ${input.reasonCode}::text,
            ${comment === '' ? null : comment}::text,
            ${CertificateEventSource.ORGANIZATION}::text
          )
        `;
        if (result[0]?.app_certificate_revoke !== true) return false;

        // Phase 16 §15, §70: the holder may already have shown this
        // certificate to an employer, so the event that tells them is written
        // in the same transaction as the revocation itself. A reviewer who
        // loses the race above emits nothing, because they revoked nothing.
        const revocationEvent = await tx.certificateEvent.findFirst({
          where: { certificateId, eventType: CertificateEventType.REVOKED },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        if (revocationEvent !== null) {
          await this.domainEvents.emitCertificate(tx, revocationEvent.id);
        }

        return true;
      },
    );

    // Lost a race with another reviewer revoking the same certificate. One
    // event committed, which is the correct outcome (§159).
    if (!revoked) {
      throw new AppError(PalCertErrorCode.CERTIFICATE_ALREADY_REVOKED, {
        message: 'This certificate has already been revoked.',
      });
    }

    await this.events.audit({
      action: 'CERTIFICATE_REVOKED',
      actorUserId: context.userId,
      targetType: 'ComplianceCertificate',
      targetId: certificateId,
      // §183: the category and the ids. Never the private note.
      afterState: {
        organizationId: context.organizationId,
        reasonCode: input.reasonCode,
      },
    });
  }
}
