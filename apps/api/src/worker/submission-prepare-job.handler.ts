import { Injectable } from '@nestjs/common';
import {
  SUBMISSION_EVIDENCE_CANONICALIZATION_VERSION,
  SUBMISSION_EVIDENCE_SCHEMA_VERSION,
  SubmissionFailureCode,
  SubmissionProcessingStatus,
  computeSubmissionEvidenceHash,
  isPermanentSubmissionFailure,
  type ComplianceDetermination,
  type DocumentFormat,
} from '@palcert/contracts';
import type { ProcessingJob, SubmissionRevision } from '@palcert/database';
import { createHash } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import {
  ObjectStoragePort,
  ObjectStorageUnavailableError,
} from '../infrastructure/storage/object-storage.port';
import {
  submissionDocumentSnapshotKey,
  submissionReportSnapshotKey,
} from '../infrastructure/storage/storage-keys';
import { TenantPrismaService } from '../infrastructure/tenant/tenant-prisma.service';
import { SecurityEventService } from '../modules/auth/services/security-event.service';
import { DomainEventService } from '../modules/notifications/services/domain-event.service';
import { requireJobOwner } from './job-owner';

/**
 * Turning an authorized handoff into immutable evidence (§34).
 *
 * The sequence, and why each step is where it is:
 *
 * 1. **Claim.** Only a PREPARING revision is worked on, so ten deliveries of
 *    the same job produce one snapshot pair and one SUBMITTED event (§97,
 *    §164).
 * 2. **Verify the source before copying it.** The document's bytes are read
 *    and hashed against the digest the check recorded, and the report artifact
 *    against its own. An institution must never be handed evidence PalCert did
 *    not re-check at the moment of handing it over (§29, §144).
 * 3. **Copy exactly.** `copyImmutable` is a server-side copy of one exact
 *    object version to a new key. Nothing is rendered, re-encoded, rebuilt or
 *    regenerated: the report is not rebuilt from current tables, and the
 *    document is not touched at all (§28, §29, §31).
 * 4. **Verify the copy.** The destination is read back and hashed. A copy that
 *    differs fails closed rather than becoming an official submission of bytes
 *    nobody checked (§163).
 * 5. **Finalize.** READY, the evidence hash, and the SUBMITTED decision event
 *    in one transaction, after which the organization can see it.
 *
 * A failure here is a processing failure and never an institution decision
 * (§35). It touches no money at all: a submission is a handoff, not a purchase
 * (§149).
 */
@Injectable()
export class SubmissionPrepareJobHandler {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly storage: ObjectStoragePort,
    private readonly events: SecurityEventService,
    private readonly domainEvents: DomainEventService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SubmissionPrepareJobHandler.name);
  }

  async handle(job: ProcessingJob): Promise<void> {
    const owner = requireJobOwner(job);
    if (owner === null) {
      throw new Error(`submission prepare job ${job.id} has no owner`);
    }

    const revision = await this.claim(owner, job.resourceId);
    if (revision === null) return; // duplicate delivery, or already finished

    try {
      await this.prepare(owner, revision);
    } catch (error) {
      const failure = classify(error);
      if (isPermanentSubmissionFailure(failure.code)) {
        await this.fail(owner, revision, failure);
        return;
      }
      await this.recordTransient(owner, revision, failure);
      throw error;
    }
  }

  /** The last attempt is spent: the preparation failed for good. */
  async failPermanently(job: ProcessingJob): Promise<void> {
    const owner = requireJobOwner(job);
    if (owner === null) return;
    const revision = await this.tenant.withUser(owner, (tx) =>
      tx.submissionRevision.findUnique({ where: { id: job.resourceId } }),
    );
    if (revision === null || revision.processingStatus !== SubmissionProcessingStatus.PREPARING) {
      return;
    }
    await this.fail(owner, revision, {
      code:
        (revision.failureCode as SubmissionFailureCode | null) ??
        SubmissionFailureCode.SUBMISSION_PREPARATION_FAILED,
      detail: 'attempts exhausted',
    });
  }

  /**
   * Take the revision, or decline because somebody else already did.
   *
   * A revision that already reached READY is finished: re-running would copy
   * over an object an institution may already have downloaded, and the
   * snapshot columns are write-once anyway.
   */
  private async claim(owner: string, revisionId: string): Promise<SubmissionRevision | null> {
    return this.tenant.withUser(owner, async (tx) => {
      const row = await tx.submissionRevision.findUnique({ where: { id: revisionId } });
      if (row === null) return null;
      if (row.processingStatus !== SubmissionProcessingStatus.PREPARING) return null;
      return row;
    });
  }

  private async prepare(owner: string, revision: SubmissionRevision): Promise<void> {
    const sources = await this.tenant.withUser(owner, async (tx) => {
      const version = await tx.documentVersion.findUniqueOrThrow({
        where: { id: revision.sourceDocumentVersionId },
      });
      const report = await tx.checkReport.findUniqueOrThrow({
        where: { id: revision.sourceReportId },
      });
      return { version, report };
    });

    if (sources.version.cleanObjectKey === null || sources.version.sha256 === null) {
      throw new PreparationFailure(
        SubmissionFailureCode.SUBMISSION_SOURCE_INTEGRITY_FAILED,
        'the submitted version no longer has a clean object',
      );
    }
    // §144, §30: the digest bound at submission is the digest of the bytes
    // being handed over. If the version's recorded digest has moved, the
    // evidence and the report no longer describe the same document.
    if (sources.version.sha256 !== revision.sourceDocumentSha256) {
      throw new PreparationFailure(
        SubmissionFailureCode.SUBMISSION_SOURCE_INTEGRITY_FAILED,
        'the document digest changed after the submission was authorized',
      );
    }
    if (sources.report.reportHash !== revision.sourceReportHash) {
      throw new PreparationFailure(
        SubmissionFailureCode.SUBMISSION_REPORT_INTEGRITY_FAILED,
        'the report hash changed after the submission was authorized',
      );
    }

    // Read the real bytes and hash them. The database says what they should
    // be; this is what they are.
    const documentBytes = await this.read({
      zone: 'clean',
      key: sources.version.cleanObjectKey,
      versionId: sources.version.cleanObjectVersionId,
    });
    if (sha256(documentBytes) !== revision.sourceDocumentSha256) {
      throw new PreparationFailure(
        SubmissionFailureCode.SUBMISSION_SOURCE_INTEGRITY_FAILED,
        'the stored document does not match its recorded digest',
      );
    }

    const reportBytes = await this.read({
      zone: 'derived',
      key: sources.report.artifactObjectKey,
      versionId: sources.report.artifactObjectVersionId,
    });
    if (sha256(reportBytes) !== sources.report.artifactSha256) {
      throw new PreparationFailure(
        SubmissionFailureCode.SUBMISSION_REPORT_INTEGRITY_FAILED,
        'the stored report artifact does not match its recorded digest',
      );
    }

    const documentKey = submissionDocumentSnapshotKey({
      organizationId: revision.organizationId,
      submissionId: revision.submissionId,
      revisionId: revision.id,
    });
    const reportKey = submissionReportSnapshotKey({
      organizationId: revision.organizationId,
      submissionId: revision.submissionId,
      revisionId: revision.id,
    });

    // §31: a copy, not a transformation. Server-side, byte for byte, into a
    // key derived from ids alone.
    const documentSnapshot = await this.copy({
      source: {
        zone: 'clean',
        key: sources.version.cleanObjectKey,
        versionId: sources.version.cleanObjectVersionId,
      },
      destination: { zone: 'derived', key: documentKey },
      contentType: 'application/octet-stream',
    });
    const reportSnapshot = await this.copy({
      source: {
        zone: 'derived',
        key: sources.report.artifactObjectKey,
        versionId: sources.report.artifactObjectVersionId,
      },
      destination: { zone: 'derived', key: reportKey },
      contentType: 'application/json',
    });

    // §119, §163: read the copies back. A destination that differs is a
    // storage layer doing something unexpected, and the right answer is to
    // fail rather than to hand an institution bytes nobody verified.
    const copiedDocument = await this.read({
      zone: 'derived',
      key: documentKey,
      versionId: documentSnapshot.versionId,
    });
    if (sha256(copiedDocument) !== revision.sourceDocumentSha256) {
      throw new PreparationFailure(
        SubmissionFailureCode.SUBMISSION_SOURCE_INTEGRITY_FAILED,
        'the copied document does not match the source digest',
      );
    }
    const copiedReport = await this.read({
      zone: 'derived',
      key: reportKey,
      versionId: reportSnapshot.versionId,
    });
    const copiedReportSha = sha256(copiedReport);
    if (copiedReportSha !== sources.report.artifactSha256) {
      throw new PreparationFailure(
        SubmissionFailureCode.SUBMISSION_REPORT_INTEGRITY_FAILED,
        'the copied report does not match the source digest',
      );
    }

    // The case carries the two identities the evidence hash needs that the
    // revision does not: the logical document and its type.
    const submissionCase = await this.tenant.withUser(owner, (tx) =>
      tx.officialSubmission.findUniqueOrThrow({ where: { id: revision.submissionId } }),
    );

    const evidenceHash = computeSubmissionEvidenceHash({
      evidenceSchemaVersion: SUBMISSION_EVIDENCE_SCHEMA_VERSION,
      evidenceCanonicalizationVersion: SUBMISSION_EVIDENCE_CANONICALIZATION_VERSION,
      organizationId: revision.organizationId,
      documentTypeId: submissionCase.documentTypeId,
      documentId: submissionCase.documentId,
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

    // §33, §43: the handoff is finalized by the database, not by this worker.
    // Becoming READY means becoming SUBMITTED — the two are one state, and the
    // `submission_revisions_ready_requires_snapshots` constraint refuses any
    // halfway row. Writing SUBMITTED is institution-decision authority, which
    // the submitter's context does not have and must not be given, so the one
    // event PalCert itself owns goes through a narrow SECURITY DEFINER path
    // that writes the snapshot identity, the evidence hash, READY, SUBMITTED,
    // the `null -> SUBMITTED` SYSTEM event and the case pointer together.
    //
    // It is idempotent: a duplicate delivery finds the revision already READY
    // and returns false, having changed nothing (§97).
    // Phase 16 §15: the answer is used rather than discarded. `true` means
    // this delivery is the one that made the revision READY, and the event
    // that tells the institution is written in the same transaction — so a
    // handoff that commits has a notification that commits with it, and a
    // duplicate delivery emits nothing because it made nothing true.
    await this.tenant.withUser(owner, async (tx) => {
      const finalized: Array<{ finalized: boolean }> = await tx.$queryRaw`
        SELECT app_submission_finalize_revision(
          ${revision.id}::uuid,
          ${documentKey}::text,
          ${documentSnapshot.versionId ?? null}::text,
          ${revision.sourceDocumentSha256}::text,
          ${copiedDocument.byteLength}::integer,
          ${reportKey}::text,
          ${reportSnapshot.versionId ?? null}::text,
          ${copiedReportSha}::text,
          ${copiedReport.byteLength}::integer,
          ${SUBMISSION_EVIDENCE_SCHEMA_VERSION}::integer,
          ${SUBMISSION_EVIDENCE_CANONICALIZATION_VERSION}::integer,
          ${evidenceHash}::text
        ) AS finalized
      `;

      if (finalized[0]?.finalized === true) {
        await this.domainEvents.emitSubmissionReady(tx, revision.id);
      }
    });

    await this.events.audit({
      action: 'OFFICIAL_SUBMISSION_READY',
      actorUserId: null,
      targetType: 'SubmissionRevision',
      targetId: revision.id,
      afterState: {
        organizationId: revision.organizationId,
        revisionNumber: revision.revisionNumber,
        determination: revision.determination,
      },
    });

    this.logger.info(
      {
        submissionId: revision.submissionId,
        revisionId: revision.id,
        organizationId: revision.organizationId,
        revisionNumber: revision.revisionNumber,
      },
      'Official submission prepared',
    );
  }

  private async read(ref: {
    zone: 'clean' | 'derived';
    key: string;
    versionId: string | null;
  }): Promise<Buffer> {
    try {
      return await this.storage.getObjectBytes(ref);
    } catch (error) {
      throw new PreparationFailure(
        SubmissionFailureCode.SUBMISSION_SNAPSHOT_STORAGE_FAILED,
        describe(error),
      );
    }
  }

  private async copy(params: {
    source: { zone: 'clean' | 'derived'; key: string; versionId: string | null };
    destination: { zone: 'derived'; key: string };
    contentType: string;
  }): Promise<{ versionId: string | null }> {
    try {
      return await this.storage.copyImmutable(params);
    } catch (error) {
      throw new PreparationFailure(
        SubmissionFailureCode.SUBMISSION_SNAPSHOT_STORAGE_FAILED,
        describe(error),
      );
    }
  }

  private async fail(
    owner: string,
    revision: SubmissionRevision,
    failure: { code: SubmissionFailureCode; detail: string },
  ): Promise<void> {
    await this.tenant.withUser(owner, (tx) =>
      tx.submissionRevision.updateMany({
        where: { id: revision.id, processingStatus: SubmissionProcessingStatus.PREPARING },
        data: {
          processingStatus: SubmissionProcessingStatus.FAILED,
          failureCode: failure.code,
          failureDetail: failure.detail.slice(0, 500),
        },
      }),
    );

    // §35: no institution decision is written, and no organization is told
    // anything. The revision never became visible, so there is nothing for a
    // reviewer to reject.
    await this.events.audit({
      action: 'OFFICIAL_SUBMISSION_FAILED',
      actorUserId: null,
      targetType: 'SubmissionRevision',
      targetId: revision.id,
      afterState: { failureCode: failure.code },
    });
  }

  private async recordTransient(
    owner: string,
    revision: SubmissionRevision,
    failure: { code: SubmissionFailureCode; detail: string },
  ): Promise<void> {
    await this.tenant.withUser(owner, (tx) =>
      tx.submissionRevision.updateMany({
        where: { id: revision.id, processingStatus: SubmissionProcessingStatus.PREPARING },
        data: { failureCode: failure.code, failureDetail: failure.detail.slice(0, 500) },
      }),
    );
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A failure that already knows its own code. */
export class PreparationFailure extends Error {
  constructor(
    readonly code: SubmissionFailureCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'PreparationFailure';
  }
}

/**
 * Give every error a code, defaulting to transient.
 *
 * "Unknown" is never evidence that the author's document is bad, so an
 * unrecognized error is retried rather than blamed on the submission (§184).
 */
function classify(error: unknown): { code: SubmissionFailureCode; detail: string } {
  if (error instanceof PreparationFailure) {
    return { code: error.code, detail: error.detail };
  }
  if (error instanceof ObjectStorageUnavailableError) {
    return {
      code: SubmissionFailureCode.SUBMISSION_SNAPSHOT_STORAGE_FAILED,
      detail: error.message,
    };
  }
  return {
    code: SubmissionFailureCode.SUBMISSION_PREPARATION_FAILED,
    detail: describe(error),
  };
}

function describe(error: unknown): string {
  // §185: never a comment, never document content. A message from storage is
  // about storage.
  return error instanceof Error ? error.message.slice(0, 200) : 'unexpected preparation failure';
}
