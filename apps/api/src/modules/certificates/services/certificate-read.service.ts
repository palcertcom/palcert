import { Injectable } from '@nestjs/common';
import {
  AppError,
  CertificateIssuanceStatus,
  ComplianceDetermination,
  PalCertErrorCode,
  buildPage,
  canonicalizeVerificationCode,
  computeCertificateClaimHash,
  decodeCursor,
  encodeCursor,
  resolveLimit,
  verificationCodeHash,
  type OrganizationCertificateFilter,
  type OrganizationCertificateListEntryView,
  type Page,
  type CertificateEventView,
  type CertificateRevocationReason,
  type CertificateView,
  type DocumentFormat,
  type CertificateClaim,
  type SubmissionCertificateStatusView,
} from '@palcert/contracts';
import { createHash } from 'node:crypto';
import { ApiConfigService } from '../../../config/api-config.service';
import {
  ObjectStoragePort,
  ObjectStorageUnavailableError,
} from '../../../infrastructure/storage/object-storage.port';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { SecurityEventService } from '../../auth/services/security-event.service';
import type { TenantContext } from '../../organizations/tenant-context';
import { CertificateEligibilityService } from './certificate-eligibility.service';

/**
 * What the two parties may read about a certificate (§52, §53).
 *
 * Both get the same view, because both are legitimately party to it — and
 * both get the verification code, because the subject has to be able to share
 * it and the institution has to be able to look up what it issued. That code
 * is private to this view; it appears in no public response and no log.
 */
@Injectable()
export class CertificateReadService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly storage: ObjectStoragePort,
    private readonly events: SecurityEventService,
    private readonly config: ApiConfigService,
    private readonly eligibility: CertificateEligibilityService,
  ) {}

  /** The author's own certificates, newest first. */
  async listForUser(userId: string): Promise<CertificateView[]> {
    const rows = await this.tenant.withUser(userId, (tx) =>
      tx.complianceCertificate.findMany({
        where: { ownerUserId: userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { revision: { include: { submission: true } } },
      }),
    );
    return Promise.all(
      rows.map(async (row) =>
        this.view(row, row.revision, row.revision.submission, await this.readClaim(row)),
      ),
    );
  }

  /** One certificate of the author's own. */
  async forUser(userId: string, certificateId: string): Promise<CertificateView> {
    const row = await this.tenant.withUser(userId, (tx) =>
      tx.complianceCertificate.findFirst({
        where: { id: certificateId, ownerUserId: userId },
        include: { revision: { include: { submission: true } } },
      }),
    );
    if (row === null) throw notFound();
    return this.view(row, row.revision, row.revision.submission, await this.readClaim(row));
  }

  /** One certificate this organization's approval produced. */
  async forOrganization(context: TenantContext, certificateId: string): Promise<CertificateView> {
    const row = await this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      (tx) =>
        tx.complianceCertificate.findFirst({
          where: { id: certificateId, organizationId: context.organizationId },
          include: { revision: { include: { submission: true } } },
        }),
    );
    if (row === null) throw notFound();
    return this.view(row, row.revision, row.revision.submission, await this.readClaim(row));
  }

  /**
   * The organization's certificate register, newest first (§119).
   *
   * Under the tenant's own RLS scope, exactly like reading one certificate:
   * the list reaches nothing a member could not already open one by one.
   *
   * Search matches the standard and the document type by text, and a
   * certificate number exactly — through the same one-way digest public
   * verification uses, so no number is ever compared as a column value.
   */
  async listForOrganization(
    context: TenantContext,
    query: {
      readonly status?: OrganizationCertificateFilter | undefined;
      readonly search?: string | undefined;
      readonly cursor?: string | undefined;
      readonly limit?: number | undefined;
    },
  ): Promise<Page<OrganizationCertificateListEntryView>> {
    const limit = resolveLimit(query.limit);
    const decoded = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && decoded === null) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, { message: 'Invalid cursor.' });
    }

    const search = query.search?.trim() ?? '';
    const canonical = search.length > 0 ? canonicalizeVerificationCode(search) : null;
    const text = { contains: search, mode: 'insensitive' as const };

    const rows = await this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      (tx) =>
        tx.complianceCertificate.findMany({
          where: {
            organizationId: context.organizationId,
            ...(query.status === undefined
              ? {}
              : { issuanceStatus: { in: ISSUANCE_STATUSES[query.status] } }),
            ...(search.length === 0
              ? {}
              : {
                  OR: [
                    ...(canonical === null
                      ? []
                      : [{ verificationCodeHash: verificationCodeHash(canonical) }]),
                    { revision: { standardCode: text } },
                    { revision: { standardName: text } },
                    { revision: { submission: { documentTypeName: text } } },
                  ],
                }),
            ...(decoded === null
              ? {}
              : {
                  AND: [
                    {
                      OR: [
                        { createdAt: { lt: new Date(decoded.sortValue) } },
                        { createdAt: new Date(decoded.sortValue), id: { lt: decoded.id } },
                      ],
                    },
                  ],
                }),
          },
          // Stable: a non-unique column and then the key, so no row is
          // skipped or repeated between pages.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          include: { revision: { include: { submission: true } } },
        }),
    );

    const page = buildPage(rows, limit, (row) => encodeCursor(row.createdAt, row.id));
    const holders = await this.holders(
      context,
      page.items.map((row) => row.submissionId),
    );

    const items = await Promise.all(
      page.items.map(async (row): Promise<OrganizationCertificateListEntryView> => {
        // One unreadable claim must not take the whole register down with
        // it. The row still lists; opening it reports the problem properly.
        const claim = await this.readClaim(row).catch(() => null);
        return {
          id: row.id,
          certificateNumber: claim?.certificateNumber ?? null,
          issuanceStatus: row.issuanceStatus as CertificateIssuanceStatus,
          submissionId: row.submissionId,
          holder: holders.get(row.submissionId) ?? null,
          documentTypeName: row.revision.submission.documentTypeName,
          documentFormat: row.revision.sourceDocumentFormat as DocumentFormat,
          standardCode: row.revision.standardCode,
          standardName: row.revision.standardName,
          standardVersionLabel: row.revision.standardVersionLabel,
          issuedAt: row.issuedAt?.toISOString() ?? null,
          revokedAt: row.revokedAt?.toISOString() ?? null,
          revocationReason: row.revocationReason as CertificateRevocationReason | null,
          createdAt: row.createdAt.toISOString(),
        };
      }),
    );
    return { items, nextCursor: page.nextCursor };
  }

  /** The certificate for one submission revision, if there is one. */
  async forRevision(userId: string, revisionId: string): Promise<CertificateView | null> {
    const row = await this.tenant.withUser(userId, (tx) =>
      tx.complianceCertificate.findFirst({
        where: { submissionRevisionId: revisionId, ownerUserId: userId },
        include: { revision: { include: { submission: true } } },
      }),
    );
    return row === null
      ? null
      : this.view(row, row.revision, row.revision.submission, await this.readClaim(row));
  }

  /**
   * What the author's own submission screen shows about a certificate
   * (§116–§121).
   *
   * Either a certificate, or the reason there is none. The reason matters as
   * much as the certificate: somebody whose compliant work was rejected, and
   * somebody whose approved work was not compliant, must each be told which
   * of the two happened rather than a shared "not eligible".
   */
  async statusForRevision(
    userId: string,
    revisionId: string,
  ): Promise<SubmissionCertificateStatusView> {
    const revision = await this.tenant.withUser(userId, (tx) =>
      tx.submissionRevision.findFirst({
        where: { id: revisionId },
        include: { submission: true },
      }),
    );
    if (revision === null) throw notFound();

    const verdict = this.eligibility.verdict({
      processingStatus: revision.processingStatus,
      determination: revision.determination,
      institutionDecisionStatus: revision.institutionDecisionStatus,
      revisionId: revision.id,
      currentRevisionId: revision.submission.currentRevisionId,
    });

    return {
      eligible: verdict.eligible,
      reason: verdict.reason,
      certificate: await this.forRevision(userId, revisionId),
    };
  }

  /** The append-only lifecycle, as either party may read it (§121). */
  async events_(params: {
    readonly certificateId: string;
    readonly userId: string;
    readonly organizationId?: string;
  }): Promise<CertificateEventView[]> {
    const rows =
      params.organizationId === undefined
        ? await this.tenant.withUser(params.userId, (tx) =>
            tx.certificateEvent.findMany({
              where: { certificateId: params.certificateId, ownerUserId: params.userId },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            }),
          )
        : await this.tenant.withTenant(
            { organizationId: params.organizationId, userId: params.userId },
            (tx) =>
              tx.certificateEvent.findMany({
                where: {
                  certificateId: params.certificateId,
                  organizationId: params.organizationId,
                },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              }),
          );

    return rows.map((row) => ({
      id: row.id,
      eventType: row.eventType as CertificateEventView['eventType'],
      eventSource: row.eventSource as CertificateEventView['eventSource'],
      // §67: the category, never the private note.
      reasonCode: row.reasonCode as CertificateRevocationReason | null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * A short-lived signed GET of the exact certificate PDF version (§52, §185).
   *
   * The exact object version, never "latest": a certificate's artifact is
   * immutable, and asking for whatever is newest would quietly undermine that.
   */
  async download(params: {
    readonly certificateId: string;
    readonly userId: string;
    readonly organizationId?: string;
  }): Promise<{ method: 'GET'; url: string; expiresAt: string; filename: string }> {
    const certificate =
      params.organizationId === undefined
        ? await this.tenant.withUser(params.userId, (tx) =>
            tx.complianceCertificate.findFirst({
              where: { id: params.certificateId, ownerUserId: params.userId },
            }),
          )
        : await this.tenant.withTenant(
            { organizationId: params.organizationId, userId: params.userId },
            (tx) =>
              tx.complianceCertificate.findFirst({
                where: { id: params.certificateId, organizationId: params.organizationId },
              }),
          );

    if (certificate === null) throw notFound();
    if (
      certificate.certificateObjectKey === null ||
      (certificate.issuanceStatus !== CertificateIssuanceStatus.ISSUED &&
        certificate.issuanceStatus !== CertificateIssuanceStatus.REVOKED)
    ) {
      throw new AppError(PalCertErrorCode.CERTIFICATE_NOT_ISSUED, {
        message: 'This certificate is still being prepared.',
      });
    }

    // §70: a revoked certificate's artifact is still downloadable. It is the
    // record of what was issued; what changed is what verification says.
    // Named from the claim, which is where the number lives now. A download
    // whose claim cannot be read is refused rather than given a made-up name.
    const claim = await this.readClaim(certificate);
    const filename = `${claim === null ? 'certificate' : claim.certificateNumber}.pdf`;
    const grant = await this.storage
      .createDownloadAuthorization({
        ref: {
          zone: 'derived',
          key: certificate.certificateObjectKey,
          versionId: certificate.certificateObjectVersionId,
        },
        expiresInSeconds: this.config.storage.downloadUrlTtlSeconds,
        contentDisposition: `attachment; filename="${filename}"`,
        contentType: 'application/pdf',
      })
      .catch((error: unknown) => {
        if (error instanceof ObjectStorageUnavailableError) {
          throw new AppError(PalCertErrorCode.STORAGE_UNAVAILABLE, {
            message: 'Storage is temporarily unavailable. Please try again.',
          });
        }
        throw error;
      });

    await this.events.audit({
      action: 'CERTIFICATE_DOWNLOADED',
      actorUserId: params.userId,
      targetType: 'ComplianceCertificate',
      targetId: certificate.id,
      afterState: { organizationId: params.organizationId ?? null },
    });

    return {
      method: 'GET',
      url: grant.url,
      expiresAt: grant.expiresAt.toISOString(),
      filename,
    };
  }

  /**
   * Who each submission came from, through the same tenant-scoped function
   * the review queue uses — which returns only this organization's own
   * submitters. The internal user id is dropped: the register has no use
   * for it.
   */
  private async holders(
    context: TenantContext,
    submissionIds: readonly string[],
  ): Promise<Map<string, { displayName: string | null; email: string }>> {
    if (submissionIds.length === 0) return new Map();
    const rows = await this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      (tx) =>
        tx.$queryRaw<{ submission_id: string; display_name: string | null; email: string }[]>`
          SELECT submission_id, display_name, email
          FROM app_submission_submitters(${[...new Set(submissionIds)]}::uuid[])`,
    );
    return new Map(
      rows.map((row) => [row.submission_id, { displayName: row.display_name, email: row.email }]),
    );
  }

  /**
   * The immutable claim artifact, read back and verified (§34, §93).
   *
   * This is where the certificate number and the verification code live now,
   * because a relational column holding them would be a bulk capability: one
   * SELECT and the reader can verify every certificate on the platform. The
   * claim is a private per-certificate object, and reading it costs a storage
   * round trip — which is the price of not keeping that column.
   *
   * The bytes are verified against the digest recorded at issuance before
   * anything is read out of them, so a swapped object produces nothing rather
   * than a different certificate number.
   */
  private async readClaim(certificate: {
    claimObjectKey: string | null;
    claimObjectVersionId: string | null;
    claimObjectSha256: string | null;
    claimHash: string | null;
  }): Promise<CertificateClaim | null> {
    if (
      certificate.claimObjectKey === null ||
      certificate.claimObjectSha256 === null ||
      certificate.claimHash === null
    ) {
      return null;
    }

    const bytes = await this.storage
      .getObjectBytes({
        zone: 'derived',
        key: certificate.claimObjectKey,
        versionId: certificate.claimObjectVersionId,
      })
      .catch((error: unknown) => {
        if (error instanceof ObjectStorageUnavailableError) {
          throw new AppError(PalCertErrorCode.STORAGE_UNAVAILABLE, {
            message: 'Storage is temporarily unavailable. Please try again.',
          });
        }
        throw error;
      });

    if (createHash('sha256').update(bytes).digest('hex') !== certificate.claimObjectSha256) {
      throw new AppError(PalCertErrorCode.CERTIFICATE_EVIDENCE_INTEGRITY_FAILED, {
        message: 'This certificate’s stored claim does not match what was issued.',
      });
    }

    const claim = JSON.parse(bytes.toString('utf8')) as CertificateClaim;
    // And the claim's own hash, so the artifact agrees with the row that
    // points at it rather than merely being the bytes that were stored.
    if (computeCertificateClaimHash(claim) !== certificate.claimHash) {
      throw new AppError(PalCertErrorCode.CERTIFICATE_EVIDENCE_INTEGRITY_FAILED, {
        message: 'This certificate’s stored claim does not match what was issued.',
      });
    }
    return claim;
  }

  private view(
    certificate: {
      id: string;
      issuanceStatus: string;
      claimObjectKey: string | null;
      claimObjectVersionId: string | null;
      claimObjectSha256: string | null;
      submissionId: string;
      submissionRevisionId: string;
      organizationId: string;
      issuedAt: Date | null;
      validUntil: Date | null;
      revokedAt: Date | null;
      revocationReason: string | null;
      claimHash: string | null;
      certificateObjectSha256: string | null;
    },
    revision: {
      sourceDocumentFormat: string;
      sourceDocumentSha256: string;
      sourceReportHash: string;
      standardContentHash: string;
      standardCode: string;
      standardName: string;
      standardVersionLabel: string;
      evidenceHash: string | null;
    },
    submission: { organizationName: string; documentTypeName: string },
    claim: CertificateClaim | null,
  ): CertificateView {
    // Both come from the claim or not at all. An unissued certificate has no
    // claim yet, and therefore no number and no code to show — which is
    // correct: nothing has been issued to name.
    const code = claim?.verificationCode ?? null;
    const issued =
      certificate.issuanceStatus === CertificateIssuanceStatus.ISSUED ||
      certificate.issuanceStatus === CertificateIssuanceStatus.REVOKED;

    return {
      id: certificate.id,
      certificateNumber: claim?.certificateNumber ?? null,
      issuanceStatus: certificate.issuanceStatus as CertificateIssuanceStatus,
      submissionId: certificate.submissionId,
      submissionRevisionId: certificate.submissionRevisionId,
      organizationId: certificate.organizationId,
      organizationName: submission.organizationName,
      documentTypeName: submission.documentTypeName,
      documentFormat: revision.sourceDocumentFormat as DocumentFormat,
      standardCode: revision.standardCode,
      standardName: revision.standardName,
      standardVersionLabel: revision.standardVersionLabel,
      technicalResult: ComplianceDetermination.COMPLIANT,
      institutionDecision: 'APPROVED',
      issuedAt: certificate.issuedAt?.toISOString() ?? null,
      validUntil: certificate.validUntil?.toISOString() ?? null,
      revokedAt: certificate.revokedAt?.toISOString() ?? null,
      revocationReason: certificate.revocationReason as CertificateRevocationReason | null,
      documentSha256: revision.sourceDocumentSha256,
      reportHash: revision.sourceReportHash,
      standardContentHash: revision.standardContentHash,
      submissionEvidenceHash: revision.evidenceHash ?? '',
      certificateClaimHash: certificate.claimHash,
      certificateArtifactSha256: certificate.certificateObjectSha256,
      verificationCode: issued ? code : null,
      verificationUrl:
        issued && claim !== null
          ? `${this.config.publicWebUrl.replace(/\/+$/, '')}/verify/${claim.certificateNumber}`
          : null,
    };
  }
}

const ISSUANCE_STATUSES: Record<OrganizationCertificateFilter, string[]> = {
  ISSUED: [CertificateIssuanceStatus.ISSUED],
  REVOKED: [CertificateIssuanceStatus.REVOKED],
  IN_PREPARATION: [CertificateIssuanceStatus.PENDING, CertificateIssuanceStatus.FAILED_RETRYABLE],
  FAILED: [CertificateIssuanceStatus.FAILED_PERMANENT],
};

/** Somebody else's certificate id is not found, never forbidden (§212). */
function notFound(): AppError {
  return new AppError(PalCertErrorCode.CERTIFICATE_NOT_FOUND, {
    message: 'That certificate does not exist.',
  });
}
