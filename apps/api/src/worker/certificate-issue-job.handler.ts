import { Injectable } from '@nestjs/common';
import {
  CERTIFICATE_CLAIM_CANONICALIZATION_VERSION,
  CERTIFICATE_CLAIM_SCHEMA_VERSION,
  CertificateEventType,
  CertificateFailureCode,
  CertificateIssuanceStatus,
  ComplianceDetermination,
  InstitutionDecisionStatus,
  SubmissionProcessingStatus,
  canonicalCertificateClaim,
  computeCertificateClaimHash,
  formatCertificateNumber,
  computeSubmissionEvidenceHash,
  isPermanentCertificateFailure,
  type CertificateClaim,
  type DocumentFormat,
} from '@palcert/contracts';
import type { ComplianceCertificate, ProcessingJob } from '@palcert/database';
import { createHash } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { openVerificationCode } from '../common/crypto/verification-code-seal';
import { ApiConfigService } from '../config/api-config.service';
import { CERTIFICATE_LABELS } from '../infrastructure/certificates/certificate-labels';
import { CertificateRendererPort } from '../infrastructure/certificates/certificate-renderer.port';
import {
  certificateArtifactKey,
  certificateClaimKey,
} from '../infrastructure/storage/certificate-keys';
import {
  ObjectStoragePort,
  ObjectStorageUnavailableError,
} from '../infrastructure/storage/object-storage.port';
import { TenantPrismaService } from '../infrastructure/tenant/tenant-prisma.service';
import { SecurityEventService } from '../modules/auth/services/security-event.service';
import { DomainEventService } from '../modules/notifications/services/domain-event.service';
import { requireJobOwner } from './job-owner';

/**
 * Turning an approved compliant submission into a certificate (§80–§94).
 *
 * The order of operations is the argument. Every source of evidence is
 * re-verified *before* the claim is built, because a certificate asserts that
 * these exact bytes were measured and approved — and an assertion made from
 * evidence nobody re-read at the moment of asserting it is worth very little
 * years later, when somebody is relying on it.
 *
 *  1. Confirm eligibility still holds. An approval can be superseded between
 *     scheduling and rendering.
 *  2. Re-read the submitted document snapshot and hash it. It must equal both
 *     the snapshot digest and the source digest the submission recorded.
 *  3. Re-read the report snapshot and hash it against its recorded hash.
 *  4. Recompute the Phase 14 evidence hash from its own canonical inputs.
 *  5. Confirm the organization-sourced APPROVED event still exists.
 *  6. Build the claim, canonicalize it, hash it.
 *  7. Render, store both artifacts, read them back and re-hash.
 *  8. Finalize in one statement.
 *
 * Any mismatch in 2–5 is permanent: the evidence does not say what the
 * submission says it says, and retrying will only re-prove that. Anything in
 * 7 that is storage or renderer trouble is retryable, because it says nothing
 * about the submission at all.
 */
@Injectable()
export class CertificateIssueJobHandler {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly storage: ObjectStoragePort,
    private readonly renderer: CertificateRendererPort,
    private readonly events: SecurityEventService,
    private readonly domainEvents: DomainEventService,
    private readonly config: ApiConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CertificateIssueJobHandler.name);
  }

  async handle(job: ProcessingJob): Promise<void> {
    const owner = requireJobOwner(job);
    const certificateId = job.resourceId;

    const certificate = await this.tenant.withUser(owner, (tx) =>
      tx.complianceCertificate.findUnique({ where: { id: certificateId } }),
    );

    if (certificate === null) return;
    // Idempotent: a duplicate delivery of an already-issued certificate does
    // nothing at all (§144).
    if (certificate.issuanceStatus !== CertificateIssuanceStatus.PENDING) return;

    try {
      await this.issue(owner, certificate);
    } catch (error) {
      if (error instanceof IssuanceFailure) {
        // §85: evidence that does not hold up is fail-closed for good.
        // Recording it finishes the job, because there is nothing to try
        // again — retrying would eventually succeed against corrupt evidence.
        if (isPermanentCertificateFailure(error.code)) {
          await this.fail(owner, certificate, error);
          return;
        }
        // §86: an outage is not. Rethrowing hands it back to the queue's own
        // retry ladder — recording FAILED_RETRYABLE here instead would mark
        // the job SUCCEEDED, and a succeeded job is never delivered again, so
        // the "retryable" state would be the one state nothing ever retried.
        // When the ladder is exhausted the job dies and `failExhausted` marks
        // the certificate for reconciliation.
        this.logger.warn(
          { certificateId: certificate.id, failureCode: error.code },
          'certificate issuance attempt failed and will be retried',
        );
      }
      throw error;
    }
  }

  private async issue(owner: string, certificate: ComplianceCertificate): Promise<void> {
    const evidence = await this.tenant.withUser(owner, async (tx) => {
      const revision = await tx.submissionRevision.findUnique({
        where: { id: certificate.submissionRevisionId },
      });
      const submission = await tx.officialSubmission.findUnique({
        where: { id: certificate.submissionId },
      });
      const approval = await tx.submissionDecisionEvent.findFirst({
        where: {
          id: certificate.approvalDecisionEventId,
          submissionRevisionId: certificate.submissionRevisionId,
          organizationId: certificate.organizationId,
          toStatus: InstitutionDecisionStatus.APPROVED,
          eventSource: 'ORGANIZATION',
        },
      });
      return { revision, submission, approval };
    });

    const { revision, submission, approval } = evidence;

    if (revision === null || submission === null) {
      throw new IssuanceFailure(CertificateFailureCode.NO_LONGER_ELIGIBLE, 'evidence disappeared');
    }
    // §84: a forged SYSTEM approval, an approval belonging to another
    // revision, or none at all — all the same answer.
    if (approval === null) {
      throw new IssuanceFailure(
        CertificateFailureCode.APPROVAL_EVENT_INVALID,
        'no matching organization approval event',
      );
    }
    if (
      revision.processingStatus !== SubmissionProcessingStatus.READY ||
      revision.determination !== ComplianceDetermination.COMPLIANT ||
      revision.institutionDecisionStatus !== InstitutionDecisionStatus.APPROVED ||
      submission.currentRevisionId !== revision.id
    ) {
      throw new IssuanceFailure(
        CertificateFailureCode.NO_LONGER_ELIGIBLE,
        'the revision stopped being eligible',
      );
    }

    // --- 2. The document, re-read and re-hashed (§81) -----------------------
    const documentBytes = await this.read(
      revision.documentSnapshotKey,
      revision.documentSnapshotVersionId,
    );
    const documentSha = sha256(documentBytes);
    if (
      documentSha !== revision.documentSnapshotSha256 ||
      documentSha !== revision.sourceDocumentSha256
    ) {
      throw new IssuanceFailure(
        CertificateFailureCode.DOCUMENT_SNAPSHOT_MISMATCH,
        'the submitted document no longer matches its recorded digest',
      );
    }

    // --- 3. The report, likewise (§82) --------------------------------------
    const reportBytes = await this.read(
      revision.reportSnapshotKey,
      revision.reportSnapshotVersionId,
    );
    if (sha256(reportBytes) !== revision.reportSnapshotSha256) {
      throw new IssuanceFailure(
        CertificateFailureCode.REPORT_SNAPSHOT_MISMATCH,
        'the submitted report no longer matches its recorded digest',
      );
    }

    // --- 4. The Phase 14 evidence hash, recomputed (§83) --------------------
    const recomputed = computeSubmissionEvidenceHash({
      evidenceSchemaVersion: revision.evidenceSchemaVersion ?? 0,
      evidenceCanonicalizationVersion: revision.evidenceCanonicalizationVersion ?? 0,
      organizationId: revision.organizationId,
      documentTypeId: submission.documentTypeId,
      documentId: submission.documentId,
      revisionNumber: revision.revisionNumber,
      documentVersionId: revision.sourceDocumentVersionId,
      documentSha256: revision.sourceDocumentSha256,
      documentFormat: revision.sourceDocumentFormat as DocumentFormat,
      checkId: revision.sourceCheckId,
      checkRunId: revision.sourceCheckRunId,
      reportId: revision.sourceReportId,
      reportHash: revision.sourceReportHash,
      evaluationHash: revision.sourceEvaluationHash,
      determination: revision.determination as ComplianceDetermination,
      standardId: revision.standardId,
      standardVersionId: revision.standardVersionId,
      standardContentHash: revision.standardContentHash,
    });
    if (recomputed !== revision.evidenceHash) {
      throw new IssuanceFailure(
        CertificateFailureCode.EVIDENCE_HASH_MISMATCH,
        'the submission evidence hash does not recompute',
      );
    }

    // --- 6. The claim ------------------------------------------------------
    //
    // Every label comes from the Phase 14 handoff, never from a live catalogue
    // row: a university renaming itself between approval and rendering must
    // not change what an old approval appears to have said.
    // The code, opened from its sealed staging copy. It is not a column, so
    // this is the only way to get it — and once this issuance commits, the
    // staging copy is erased and there is no way at all.
    const code = openVerificationCode(
      certificate.verificationCodeCiphertext,
      this.config.certificateVerificationKey,
    );
    if (code === null) {
      // Either the key rotated under an unissued certificate or the sealed
      // value was tampered with. Neither can be recovered from here, and
      // guessing is not an option: fail closed and let reconciliation re-key
      // a row that has never been issued.
      throw new IssuanceFailure(
        CertificateFailureCode.STORAGE_UNAVAILABLE,
        'the sealed verification code could not be opened',
      );
    }
    const certificateNumber = formatCertificateNumber(code);

    const issuedAt = new Date();
    const claim: CertificateClaim = {
      claimSchemaVersion: CERTIFICATE_CLAIM_SCHEMA_VERSION,
      claimCanonicalizationVersion: CERTIFICATE_CLAIM_CANONICALIZATION_VERSION,
      certificateNumber,
      verificationCode: code,
      submissionRevisionId: revision.id,
      organizationId: revision.organizationId,
      organizationName: submission.organizationName,
      documentTypeId: submission.documentTypeId,
      documentTypeName: submission.documentTypeName,
      documentFormat: revision.sourceDocumentFormat as DocumentFormat,
      documentSha256: revision.sourceDocumentSha256,
      reportHash: revision.sourceReportHash,
      evaluationHash: revision.sourceEvaluationHash,
      standardId: revision.standardId,
      standardVersionId: revision.standardVersionId,
      standardContentHash: revision.standardContentHash,
      standardCode: revision.standardCode,
      standardName: revision.standardName,
      standardVersionLabel: revision.standardVersionLabel,
      submissionEvidenceHash: revision.evidenceHash ?? '',
      technicalDetermination: ComplianceDetermination.COMPLIANT,
      institutionDecision: 'APPROVED',
      approvalDecisionEventId: approval.id,
      approvedAt: approval.createdAt.toISOString(),
      issuedAt: issuedAt.toISOString(),
      // §28: no automatic expiry in Phase 15. The column exists so a later
      // policy can set one without a migration; inventing one now would put a
      // deadline on somebody's certificate that nobody asked for.
      validUntil: null,
    };

    const claimBytes = Buffer.from(canonicalCertificateClaim(claim), 'utf8');
    const claimHash = computeCertificateClaimHash(claim);

    // --- 7. Render and store, then read back and verify (§93) ---------------
    const verificationUrl = this.verificationUrl(certificateNumber);
    const rendered = await this.renderer
      .render({ claim, verificationUrl, labels: CERTIFICATE_LABELS })
      .catch((error: unknown) => {
        throw new IssuanceFailure(
          CertificateFailureCode.RENDERER_FAILED,
          error instanceof Error ? error.message : 'renderer failed',
        );
      });

    const claimKey = certificateClaimKey({
      organizationId: certificate.organizationId,
      certificateId: certificate.id,
    });
    const artifactKey = certificateArtifactKey({
      organizationId: certificate.organizationId,
      certificateId: certificate.id,
    });

    const storedClaim = await this.write(claimKey, claimBytes, 'application/json');
    const storedArtifact = await this.write(artifactKey, rendered.bytes, 'application/pdf');

    // A successful write response is not proof the bytes are there and intact.
    const claimReadBack = await this.read(claimKey, storedClaim.versionId);
    const artifactReadBack = await this.read(artifactKey, storedArtifact.versionId);
    if (sha256(claimReadBack) !== sha256(claimBytes)) {
      throw new IssuanceFailure(
        CertificateFailureCode.ARTIFACT_VERIFICATION_FAILED,
        'the stored claim did not read back',
      );
    }
    if (sha256(artifactReadBack) !== rendered.sha256) {
      throw new IssuanceFailure(
        CertificateFailureCode.ARTIFACT_VERIFICATION_FAILED,
        'the stored certificate did not read back',
      );
    }

    // --- 8. Finalize, all of it or none of it (§90, §91) --------------------
    const issued = await this.tenant.withUser(certificate.ownerUserId, async (tx) => {
      const result = await tx.$queryRaw<{ app_certificate_issue: boolean }[]>`
        SELECT app_certificate_issue(
          ${certificate.id}::uuid,
          ${CERTIFICATE_CLAIM_SCHEMA_VERSION}::integer,
          ${CERTIFICATE_CLAIM_CANONICALIZATION_VERSION}::integer,
          ${claimHash}::text,
          ${claimKey}::text,
          ${storedClaim.versionId}::text,
          ${sha256(claimBytes)}::text,
          ${artifactKey}::text,
          ${storedArtifact.versionId}::text,
          ${rendered.sha256}::text,
          ${rendered.rendererName}::text,
          ${rendered.rendererVersion}::text,
          ${rendered.templateVersion}::text,
          ${null}::timestamptz
        )
      `;

      if (result[0]?.app_certificate_issue !== true) return result;

      // Phase 16 §15: the certificate's own ISSUED event is what the
      // notification reports, and the event is emitted in the same
      // transaction that wrote it. A duplicate delivery never gets here —
      // the function above returns false — so the holder is told once.
      const issuedEvent = await tx.certificateEvent.findFirst({
        where: { certificateId: certificate.id, eventType: CertificateEventType.ISSUED },
      });
      if (issuedEvent !== null) {
        await this.domainEvents.emitCertificate(tx, issuedEvent.id);
      }

      return result;
    });

    if (issued[0]?.app_certificate_issue !== true) return;

    await this.events.audit({
      action: 'CERTIFICATE_ISSUED',
      actorUserId: null,
      targetType: 'ComplianceCertificate',
      targetId: certificate.id,
      // §181: ids and status. Never the claim, never the verification code.
      afterState: {
        organizationId: certificate.organizationId,
        submissionRevisionId: certificate.submissionRevisionId,
        templateVersion: rendered.templateVersion,
      },
    });
  }

  /**
   * The job ran out of attempts.
   *
   * Recorded as retryable rather than permanent: exhausting a retry ladder
   * means PalCert's machinery could not finish, which says nothing about the
   * submission. Reconciliation picks it up again, so an eligible approval is
   * never left uncertified because of an outage that has since ended.
   */
  async failExhausted(job: ProcessingJob): Promise<void> {
    const owner = requireJobOwner(job);
    const certificate = await this.tenant.withUser(owner, (tx) =>
      tx.complianceCertificate.findUnique({ where: { id: job.resourceId } }),
    );
    if (certificate === null) return;
    if (certificate.issuanceStatus !== CertificateIssuanceStatus.PENDING) return;

    await this.fail(
      owner,
      certificate,
      new IssuanceFailure(
        CertificateFailureCode.STORAGE_UNAVAILABLE,
        'issuance did not complete within its retry budget',
      ),
    );
  }

  /** Record why issuance stopped, and whether it may ever be tried again. */
  private async fail(
    owner: string,
    certificate: ComplianceCertificate,
    failure: IssuanceFailure,
  ): Promise<void> {
    const permanent = isPermanentCertificateFailure(failure.code);

    await this.tenant.withUser(
      owner,
      (tx) =>
        tx.$queryRaw`
        SELECT app_certificate_fail(
          ${certificate.id}::uuid,
          ${failure.code}::text,
          ${failure.detail}::text,
          ${permanent}::boolean
        )
      `,
    );

    await this.events.audit({
      action: 'CERTIFICATE_ISSUANCE_FAILED',
      actorUserId: null,
      targetType: 'ComplianceCertificate',
      targetId: certificate.id,
      afterState: { failureCode: failure.code, permanent },
    });

    this.logger.warn(
      { certificateId: certificate.id, failureCode: failure.code, permanent },
      'certificate issuance failed',
    );
  }

  /** The QR's destination, built from server configuration only (§41, §164). */
  private verificationUrl(certificateNumber: string): string {
    const base = this.config.publicWebUrl.replace(/\/+$/, '');
    return `${base}/verify/${certificateNumber}`;
  }

  private async read(key: string | null, versionId: string | null): Promise<Buffer> {
    if (key === null) {
      throw new IssuanceFailure(
        CertificateFailureCode.NO_LONGER_ELIGIBLE,
        'the submission has no stored evidence',
      );
    }
    try {
      return await this.storage.getObjectBytes({ zone: 'derived', key, versionId });
    } catch (error) {
      if (error instanceof ObjectStorageUnavailableError) {
        throw new IssuanceFailure(CertificateFailureCode.STORAGE_UNAVAILABLE, error.message);
      }
      throw new IssuanceFailure(
        CertificateFailureCode.STORAGE_UNAVAILABLE,
        error instanceof Error ? error.message : 'could not read the stored object',
      );
    }
  }

  private async write(
    key: string,
    content: Buffer,
    contentType: string,
  ): Promise<{ versionId: string | null }> {
    try {
      const stored = await this.storage.putObject({ zone: 'derived', key, content, contentType });
      return { versionId: stored.versionId };
    } catch (error) {
      throw new IssuanceFailure(
        CertificateFailureCode.STORAGE_UNAVAILABLE,
        error instanceof Error ? error.message : 'could not store the artifact',
      );
    }
  }
}

/** Why one issuance attempt stopped. Carries enough to classify it. */
class IssuanceFailure extends Error {
  constructor(
    readonly code: CertificateFailureCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'IssuanceFailure';
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
