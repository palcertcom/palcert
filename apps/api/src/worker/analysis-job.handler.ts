import { Injectable } from '@nestjs/common';
import {
  DocumentAnalysisFailureCode,
  DocumentAnalysisStatus,
  DocumentFormat,
  DocumentVersionStatus,
  isPermanentAnalysisFailure,
} from '@palcert/contracts';
import type { DocumentAnalysis, ProcessingJob } from '@palcert/database';
import { createHash } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../config/api-config.service';
import {
  DocumentEngineError,
  DocumentEnginePort,
} from '../infrastructure/document-engine/document-engine.port';
import {
  ObjectStoragePort,
  ObjectStorageUnavailableError,
} from '../infrastructure/storage/object-storage.port';
import { TenantPrismaService } from '../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../modules/auth/ports/clock.port';
import { SecurityEventService } from '../modules/auth/services/security-event.service';
import { DocumentAnalysisService } from '../modules/analysis/services/document-analysis.service';
import { DocumentCheckService } from '../modules/checks/services/document-check.service';
import { requireJobOwner } from './job-owner';

/**
 * Running one document analysis, whatever its format (§4, §5, §90, §91).
 *
 * The sequence, and why each step is where it is:
 *
 * 1. **Claim.** `PENDING → RUNNING` atomically. An at-least-once delivery of a
 *    job already finished, or held elsewhere, is a no-op rather than a second
 *    analysis (§90).
 * 2. **Read the exact clean object version** Phase 5 recorded — not the latest
 *    version of the key, not the quarantine object, never a path from a
 *    request (§4).
 * 3. **Verify the digest** against the version's authoritative SHA-256 before
 *    the bytes are believed. The analyzer checks it again on its own side;
 *    checking here means a swapped object fails before it crosses a service
 *    boundary (§5).
 * 4. **Analyze**, then store the artifact bytes exactly as returned and verify
 *    the stored object's digest (§87).
 * 5. **Record.** Success writes the artifact identity once; the trigger makes
 *    that write-once for real.
 */
@Injectable()
export class AnalysisJobHandler {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly storage: ObjectStoragePort,
    private readonly engine: DocumentEnginePort,
    private readonly analyses: DocumentAnalysisService,
    private readonly checks: DocumentCheckService,
    private readonly events: SecurityEventService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AnalysisJobHandler.name);
  }

  async handle(job: ProcessingJob): Promise<void> {
    const owner = requireJobOwner(job);
    if (owner === null) {
      throw new Error(`analysis job ${job.id} has no owner`);
    }

    const claimed = await this.claim(owner, job.resourceId);
    if (claimed === null) return; // duplicate delivery, or already finished

    try {
      const result = await this.analyze(owner, claimed);
      await this.succeed(owner, claimed, result);
    } catch (error) {
      const failure = classify(error);
      // A permanent failure is recorded and the job succeeds: its task was to
      // decide, and deciding "this document cannot be analyzed" is a decision.
      // A transient one is rethrown so the ledger spends an attempt (§91).
      if (isPermanentAnalysisFailure(failure.code)) {
        await this.fail(owner, claimed, failure);
        return;
      }
      await this.recordTransient(owner, claimed, failure);
      throw error;
    }
  }

  /** The last attempt has been spent: the analysis is failed for good. */
  async failPermanently(job: ProcessingJob): Promise<void> {
    const owner = requireJobOwner(job);
    if (owner === null) return;
    const analysis = await this.tenant.withUser(owner, (tx) =>
      tx.documentAnalysis.findUnique({ where: { id: job.resourceId } }),
    );
    if (analysis === null || analysis.status !== DocumentAnalysisStatus.RUNNING) return;
    await this.fail(owner, analysis, {
      code:
        (analysis.failureCode as DocumentAnalysisFailureCode | null) ??
        DocumentAnalysisFailureCode.ENGINE_ERROR,
      detail: 'attempts exhausted',
    });
  }

  private async claim(owner: string, analysisId: string): Promise<DocumentAnalysis | null> {
    const now = this.clock.now();
    return this.tenant.withUser(owner, async (tx) => {
      const updated = await tx.documentAnalysis.updateMany({
        where: {
          id: analysisId,
          status: { in: [DocumentAnalysisStatus.PENDING, DocumentAnalysisStatus.RUNNING] },
        },
        data: { status: DocumentAnalysisStatus.RUNNING, startedAt: now },
      });
      if (updated.count !== 1) return null;
      return tx.documentAnalysis.findUniqueOrThrow({ where: { id: analysisId } });
    });
  }

  private async analyze(owner: string, analysis: DocumentAnalysis): Promise<AnalysisSuccess> {
    const version = await this.tenant.withUser(owner, (tx) =>
      tx.documentVersion.findUniqueOrThrow({ where: { id: analysis.documentVersionId } }),
    );

    if (
      version.status !== DocumentVersionStatus.READY ||
      version.cleanObjectKey === null ||
      version.sha256 === null
    ) {
      throw new AnalysisFailure(
        DocumentAnalysisFailureCode.DOCUMENT_INVALID,
        'the version is no longer an analyzable READY document',
      );
    }
    if (version.sha256 !== analysis.sourceSha256) {
      // The version's digest changed under the analysis. Impossible by design
      // (identity is write-once), so treat it as an integrity failure rather
      // than analyzing bytes nobody asked about.
      throw new AnalysisFailure(
        DocumentAnalysisFailureCode.DOCUMENT_SOURCE_INTEGRITY_FAILED,
        'the version digest no longer matches the analysis request',
      );
    }
    if ((version.sizeBytes ?? 0) > this.config.analysis.maxSourceBytes) {
      throw new AnalysisFailure(
        DocumentAnalysisFailureCode.DOCUMENT_TOO_COMPLEX,
        'the document exceeds the analysis size limit',
      );
    }

    // The exact object version Phase 5 promoted. Never the latest (ADR-0034).
    const content = await this.storage
      .getObjectBytes({
        zone: 'clean',
        key: version.cleanObjectKey,
        versionId: version.cleanObjectVersionId,
      })
      .catch((error: unknown) => {
        throw new AnalysisFailure(DocumentAnalysisFailureCode.STORAGE_UNAVAILABLE, describe(error));
      });

    const actual = createHash('sha256').update(content).digest('hex');
    if (actual !== analysis.sourceSha256) {
      throw new AnalysisFailure(
        DocumentAnalysisFailureCode.DOCUMENT_SOURCE_INTEGRITY_FAILED,
        'the stored object does not match the recorded document digest',
      );
    }

    // The format Phase 5 detected from the bytes, never a declared one (§83).
    const format = version.detectedFormat as DocumentFormat | null;
    if (format !== DocumentFormat.DOCX && format !== DocumentFormat.PDF) {
      throw new AnalysisFailure(
        DocumentAnalysisFailureCode.DOCUMENT_INVALID,
        'the version has no format PalCert can analyze',
      );
    }

    const analyzed = await this.engine.analyzeDocument({
      documentId: analysis.documentVersionId,
      content,
      expectedSha256: analysis.sourceSha256,
      format,
    });

    if (analyzed.artifact.byteLength > this.config.analysis.maxArtifactBytes) {
      throw new AnalysisFailure(
        DocumentAnalysisFailureCode.DOCUMENT_TOO_COMPLEX,
        'the analysis artifact exceeds the storage limit',
      );
    }
    if (
      analyzed.analyzerName !== analysis.analyzerName ||
      analyzed.analyzerVersion !== analysis.analyzerVersion ||
      analyzed.factSchemaVersion !== analysis.factSchemaVersion
    ) {
      // The deployed analyzer is not the one this analysis was created for.
      // Storing its output under this row's identity would make the record a
      // lie about what produced the facts (§7).
      throw new AnalysisFailure(
        DocumentAnalysisFailureCode.ENGINE_UNAVAILABLE,
        'the analyzer identity does not match the analysis record',
      );
    }

    const key = this.analyses.artifactKeyFor(analysis);
    const stored = await this.storage
      .putObject({
        zone: 'derived',
        key,
        content: analyzed.artifact,
        contentType: 'application/json',
      })
      .catch((error: unknown) => {
        throw new AnalysisFailure(DocumentAnalysisFailureCode.STORAGE_UNAVAILABLE, describe(error));
      });

    if (stored.sizeBytes !== analyzed.artifact.byteLength) {
      throw new AnalysisFailure(
        DocumentAnalysisFailureCode.ARTIFACT_INVALID,
        'the stored artifact size differs from the analyzer output',
      );
    }

    return { analyzed, key, versionId: stored.versionId };
  }

  private async succeed(
    owner: string,
    analysis: DocumentAnalysis,
    result: AnalysisSuccess,
  ): Promise<void> {
    const now = this.clock.now();
    await this.tenant.withUser(owner, (tx) =>
      tx.documentAnalysis.updateMany({
        where: { id: analysis.id, status: DocumentAnalysisStatus.RUNNING },
        data: {
          status: DocumentAnalysisStatus.SUCCEEDED,
          artifactObjectKey: result.key,
          artifactObjectVersionId: result.versionId,
          artifactSha256: result.analyzed.artifactSha256,
          artifactSizeBytes: result.analyzed.artifact.byteLength,
          factCount: result.analyzed.factCount,
          warningCount: result.analyzed.warningCount,
          warningCodes: [...result.analyzed.warningCodes],
          summary: result.analyzed.summary,
          durationMs: result.analyzed.durationMs,
          completedAt: now,
          failureCode: null,
          failureDetail: null,
        },
      }),
    );

    await this.events.audit({
      action: 'DOCUMENT_ANALYSIS_SUCCEEDED',
      actorUserId: null,
      targetType: 'DocumentAnalysis',
      targetId: analysis.id,
      // Counters only: never a title, a filename or any extracted text (§71).
      afterState: {
        factCount: result.analyzed.factCount,
        warningCount: result.analyzed.warningCount,
        analyzerVersion: analysis.analyzerVersion,
      },
    });

    // Every check parked on this analysis is woken here, inside the flow that
    // completed it. A worker that only wrote the row and left the checks to
    // notice would be the polling loop Phase 7 exists to avoid (§28).
    await this.checks.onAnalysisSettled(owner, analysis.id, 'SUCCEEDED', null);

    this.logger.info(
      {
        analysisId: analysis.id,
        factCount: result.analyzed.factCount,
        warningCount: result.analyzed.warningCount,
        durationMs: result.analyzed.durationMs,
      },
      'Document analysis completed',
    );
  }

  private async fail(
    owner: string,
    analysis: DocumentAnalysis,
    failure: { code: DocumentAnalysisFailureCode; detail: string },
  ): Promise<void> {
    const now = this.clock.now();
    await this.tenant.withUser(owner, (tx) =>
      tx.documentAnalysis.updateMany({
        where: {
          id: analysis.id,
          status: { in: [DocumentAnalysisStatus.PENDING, DocumentAnalysisStatus.RUNNING] },
        },
        data: {
          status: DocumentAnalysisStatus.FAILED,
          failureCode: failure.code,
          failureDetail: failure.detail.slice(0, 500),
          failedAt: now,
        },
      }),
    );

    await this.events.audit({
      action: 'DOCUMENT_ANALYSIS_FAILED',
      actorUserId: null,
      targetType: 'DocumentAnalysis',
      targetId: analysis.id,
      afterState: { failureCode: failure.code },
    });

    // A check waiting on an analysis that will never succeed is failed now,
    // rather than left waiting for an event that is not coming (§28).
    await this.checks.onAnalysisSettled(owner, analysis.id, 'FAILED', failure.code);
  }

  /** Remember why an attempt failed without ending the analysis. */
  private async recordTransient(
    owner: string,
    analysis: DocumentAnalysis,
    failure: { code: DocumentAnalysisFailureCode; detail: string },
  ): Promise<void> {
    await this.tenant.withUser(owner, (tx) =>
      tx.documentAnalysis.updateMany({
        where: { id: analysis.id, status: DocumentAnalysisStatus.RUNNING },
        data: { failureCode: failure.code, failureDetail: failure.detail.slice(0, 500) },
      }),
    );
  }
}

interface AnalysisSuccess {
  readonly analyzed: Awaited<ReturnType<DocumentEnginePort['analyzeDocument']>>;
  readonly key: string;
  readonly versionId: string | null;
}

/** A failure that already knows its own code. */
export class AnalysisFailure extends Error {
  constructor(
    readonly code: DocumentAnalysisFailureCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'AnalysisFailure';
  }
}

/**
 * Give every error a code, defaulting to transient.
 *
 * "Unknown" is never evidence that the user's document is bad, so an
 * unrecognized error is retried rather than blamed on the document (§91).
 */
function classify(error: unknown): { code: DocumentAnalysisFailureCode; detail: string } {
  if (error instanceof AnalysisFailure) {
    return { code: error.code, detail: error.detail };
  }
  if (error instanceof ObjectStorageUnavailableError) {
    return { code: DocumentAnalysisFailureCode.STORAGE_UNAVAILABLE, detail: error.message };
  }
  if (error instanceof DocumentEngineError) {
    if (error.kind === 'DOCUMENT') {
      return { code: documentFailureFor(error.analysisError), detail: error.message };
    }
    return {
      code: /timed out/i.test(error.message)
        ? DocumentAnalysisFailureCode.ENGINE_TIMEOUT
        : DocumentAnalysisFailureCode.ENGINE_UNAVAILABLE,
      detail: error.message,
    };
  }
  return { code: DocumentAnalysisFailureCode.ENGINE_ERROR, detail: describe(error) };
}

/** Map the analyzer's own code onto PalCert's failure vocabulary. */
function documentFailureFor(analysisError: string | null): DocumentAnalysisFailureCode {
  switch (analysisError) {
    case 'DOCX_SOURCE_INTEGRITY_FAILED':
    case 'DOCUMENT_SOURCE_INTEGRITY_FAILED':
      return DocumentAnalysisFailureCode.DOCUMENT_SOURCE_INTEGRITY_FAILED;
    case 'DOCX_PROFILE_UNSUPPORTED':
      return DocumentAnalysisFailureCode.DOCUMENT_PROFILE_UNSUPPORTED;
    case 'DOCX_RESOURCE_LIMIT_EXCEEDED':
      return DocumentAnalysisFailureCode.DOCUMENT_TOO_COMPLEX;
    // The PDF analyzer's vocabulary (Phase 13 §19, §104). A password-protected
    // document is the user's to fix, not PalCert's to retry, and a check that
    // hits it settles unpaid.
    case 'PDF_PASSWORD_REQUIRED':
      return DocumentAnalysisFailureCode.DOCUMENT_PASSWORD_REQUIRED;
    case 'PDF_ENCRYPTION_UNSUPPORTED':
      return DocumentAnalysisFailureCode.DOCUMENT_ENCRYPTION_UNSUPPORTED;
    case 'PDF_LIMIT_EXCEEDED':
      return DocumentAnalysisFailureCode.DOCUMENT_TOO_COMPLEX;
    default:
      return DocumentAnalysisFailureCode.DOCUMENT_INVALID;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'unexpected analysis failure';
}
