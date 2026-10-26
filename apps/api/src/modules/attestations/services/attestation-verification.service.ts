import { Injectable } from '@nestjs/common';
import {
  AppError,
  PalCertErrorCode,
  SHA256_HEX_PATTERN,
  attestationTokenHash,
  attestationVerificationStatus,
  canonicalizeAttestationToken,
  type PublicAttestationFileMatchView,
  type PublicAttestationView,
} from '@palcert/contracts';
import * as QRCode from 'qrcode';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { isoDate } from '../attestation-support';

/** Exactly the columns the public projection returns. Nothing else exists here. */
interface PublicRow {
  reference: string;
  organization_name: string;
  organization_verified: boolean;
  type_name_en: string;
  type_name_ar: string;
  certificate_title: string;
  certificate_type: string | null;
  holder_name: string | null;
  issuing_organization: string | null;
  issue_date: Date | null;
  reference_number: string | null;
  valid_from: Date;
  valid_until: Date | null;
  approved_at: Date;
  revoked_at: Date | null;
  artifact_sha256: string;
  artifact_mime_type: string;
  attestation_hash: string;
}

/**
 * Public verification (§11, §30, §31).
 *
 * Found only by presenting a 160-bit token, looked up by its hash through a
 * narrow SECURITY DEFINER projection. The response type has no user id, no
 * email, no storage key, no reviewer, no money and no private note — not
 * hidden, absent. A revoked attestation answers REVOKED rather than
 * not-found: an old QR telling its holder the truth is the point.
 */
@Injectable()
export class AttestationVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ClockPort,
  ) {}

  async verify(token: string): Promise<PublicAttestationView> {
    const canonical = canonicalizeAttestationToken(token);
    // Malformed and unknown get one answer, so a token's shape cannot be probed.
    if (canonical === null) throw notFound();
    const rows = await this.prisma.$queryRaw<PublicRow[]>`
      SELECT * FROM app_public_attestation(${attestationTokenHash(canonical)}::text)`;
    const row = rows[0];
    if (row === undefined) throw notFound();
    return this.view(row);
  }

  /**
   * "Is there a valid PalCert attestation for exactly this file?"
   *
   * The visitor's browser hashes the file and sends only the digest, so the
   * file itself never reaches PalCert and there is nothing to retain. Only
   * unrevoked, unexpired attestations match, and only their public fields are
   * returned — the same fields their own verification link would show.
   */
  async verifyDigest(sha256: string): Promise<PublicAttestationFileMatchView> {
    const digest = sha256.trim().toLowerCase();
    if (!SHA256_HEX_PATTERN.test(digest)) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'sha256 must be 64 hexadecimal characters.',
      });
    }
    const rows = await this.prisma.$queryRaw<PublicRow[]>`
      SELECT * FROM app_public_attestations_by_artifact(${digest}::text, ${this.clock.now()}::timestamptz)`;
    const attestations = rows.map((row) => this.view(row));
    return { matched: attestations.length > 0, attestations };
  }

  private view(row: PublicRow): PublicAttestationView {
    return {
      verifiedBy: 'PalCert',
      reference: row.reference,
      verificationStatus: attestationVerificationStatus({
        revokedAt: row.revoked_at,
        validUntil: row.valid_until,
        now: this.clock.now(),
      }),
      organization: { name: row.organization_name, verified: row.organization_verified },
      attestationType: { en: row.type_name_en, ar: row.type_name_ar },
      certificate: {
        title: row.certificate_title,
        type: row.certificate_type,
        holderName: row.holder_name,
        issuingOrganization: row.issuing_organization,
        issueDate: isoDate(row.issue_date),
        referenceNumber: row.reference_number,
      },
      validFrom: row.valid_from.toISOString(),
      validUntil: row.valid_until?.toISOString() ?? null,
      attestedAt: row.approved_at.toISOString(),
      revokedAt: row.revoked_at?.toISOString() ?? null,
      artifactSha256: row.artifact_sha256,
      artifactMimeType: row.artifact_mime_type,
      attestationHash: row.attestation_hash,
    };
  }
}

/**
 * The QR code: the verification URL and nothing else.
 *
 * Takes one string and fixes every option, so no caller can add a user id, a
 * storage URL or a tracking parameter, and the same URL always renders the
 * same bytes.
 */
const QR_BASE = {
  errorCorrectionLevel: 'M',
  margin: 2,
  color: { dark: '#000000ff', light: '#ffffffff' },
} as const;

export function attestationQrPng(verificationUrl: string): Promise<Buffer> {
  return QRCode.toBuffer(verificationUrl, { ...QR_BASE, type: 'png', scale: 8 });
}

export function attestationQrSvg(verificationUrl: string): Promise<string> {
  return QRCode.toString(verificationUrl, { ...QR_BASE, type: 'svg' });
}

function notFound(): AppError {
  return new AppError(PalCertErrorCode.ATTESTATION_NOT_FOUND, {
    message: 'No attestation matches that verification link.',
  });
}
