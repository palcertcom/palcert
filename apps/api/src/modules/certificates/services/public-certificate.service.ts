import { Injectable } from '@nestjs/common';
import {
  AppError,
  CertificateIssuanceStatus,
  ComplianceDetermination,
  PalCertErrorCode,
  canonicalizeVerificationCode,
  formatCertificateNumber,
  verificationCodeHash,
  verificationStatusOf,
  type CertificateRevocationReason,
  type DocumentFormat,
  type PublicCertificateVerificationView,
} from '@palcert/contracts';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';

/** Exactly the columns the projection returns. Nothing else exists here. */
interface PublicRow {
  issuance_status: string;
  issued_at: Date | null;
  valid_until: Date | null;
  revoked_at: Date | null;
  revocation_reason: string | null;
  organization_name: string;
  document_type_name: string;
  document_format: string;
  standard_code: string;
  standard_name: string;
  standard_version_label: string;
  document_sha256: string;
  report_hash: string;
  standard_content_hash: string;
  submission_evidence_hash: string;
  claim_hash: string;
  certificate_object_sha256: string;
}

/**
 * Verification, for whoever holds the code (§13, §17, §18).
 *
 * There is no directory and no search: a certificate is found only by
 * presenting its own high-entropy code, which is what makes this safe to
 * expose unauthenticated. Possessing a code identifies one certificate and
 * grants nothing else (§16).
 *
 * The lookup goes through a narrow SECURITY DEFINER projection rather than a
 * widened policy, and by the code's *hash*. The projection returns no readable
 * number either: the caller supplied the code, so the displayed number is
 * derived from the request. Nothing in the relational row can be turned back
 * into a working verification.
 */
@Injectable()
export class PublicCertificateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockPort,
  ) {}

  async verify(code: string): Promise<PublicCertificateVerificationView> {
    const canonical = canonicalizeVerificationCode(code);
    // Malformed input and an unknown certificate get the same answer, so the
    // shape of a code cannot be probed for either.
    if (canonical === null) throw notFound();

    const rows = await this.prisma.$queryRaw<PublicRow[]>`
      SELECT * FROM app_public_certificate(${verificationCodeHash(canonical)}::text)
    `;
    const row = rows[0];
    if (row === undefined) throw notFound();

    const status = verificationStatusOf({
      issuanceStatus: row.issuance_status as CertificateIssuanceStatus,
      validUntil: row.valid_until,
      now: this.clock.now(),
    });
    // The projection already excludes anything unissued; this is the belt to
    // that braces, and keeps the null case from becoming a 500.
    if (status === null) throw notFound();

    return {
      // Formatted from the code the caller supplied, never read from a column.
      // Anybody who can reach this line already holds the code, so the
      // database has no reason to keep a copy of its readable form.
      certificateNumber: formatCertificateNumber(canonical),
      verificationStatus: status,
      organizationName: row.organization_name,
      documentTypeName: row.document_type_name,
      documentFormat: row.document_format as DocumentFormat,
      standardName: row.standard_name,
      standardCode: row.standard_code,
      standardVersionLabel: row.standard_version_label,
      technicalResult: ComplianceDetermination.COMPLIANT,
      institutionDecision: 'APPROVED',
      issuedAt: (row.issued_at ?? new Date(0)).toISOString(),
      validUntil: row.valid_until?.toISOString() ?? null,
      revokedAt: row.revoked_at?.toISOString() ?? null,
      // §68: the category is public; the private note is not.
      revocationReason: row.revocation_reason as CertificateRevocationReason | null,
      documentSha256: row.document_sha256,
      reportHash: row.report_hash,
      standardContentHash: row.standard_content_hash,
      submissionEvidenceHash: row.submission_evidence_hash,
      certificateClaimHash: row.claim_hash,
      certificateArtifactSha256: row.certificate_object_sha256,
    };
  }
}

/**
 * One answer for every miss (§153, §154, §155).
 *
 * A code that never existed, one still being prepared, and one whose issuance
 * failed are indistinguishable from outside. An internal failure is nobody
 * else's business, and a distinguishable "pending" would let somebody watch
 * for a certificate to appear.
 */
function notFound(): AppError {
  return new AppError(PalCertErrorCode.CERTIFICATE_NOT_FOUND, {
    message: 'No certificate matches that verification code.',
  });
}
