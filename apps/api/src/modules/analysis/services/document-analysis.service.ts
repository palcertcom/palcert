import { Injectable } from '@nestjs/common';
import {
  AppError,
  DocumentAnalysisFailureCode,
  DocumentAnalysisStatus,
  DocumentFormat,
  DocumentVersionStatus,
  PalCertErrorCode,
  ProcessingJobType,
  isPermanentAnalysisFailure,
  type DocumentAnalysisView,
} from '@palcert/contracts';
import type { DocumentAnalysis } from '@palcert/database';
import { randomUUID } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../../../config/api-config.service';
import { OutboxDispatcher } from '../../../infrastructure/queue/outbox-dispatcher';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import { analysisArtifactKey } from '../../../infrastructure/storage/storage-keys';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';

/** The analyzers this release runs. Semantic, not build identifiers (§15). */
export const DOCX_ANALYZER_NAME = 'palcert-docx';
/**
 * Phase 18 moved this three times: '2' read Word's citation evidence into the
 * artifact, '3' projects four properties of it into facts, and '4' declares
 * that DOCX cannot answer `citationTargetResolved` at all.
 *
 * The first two moves are the same rule: a check run against an analysis from
 * the previous version finds no citation facts and reports nothing about
 * citations, silently, because an artifact without them is a valid artifact.
 *
 * The third is stronger. A version 3 analysis carries no coverage entry for
 * the new property, so a rule about it would be read under this format's
 * COMPLETE citation coverage and could pass or fail on silence. Reusing one
 * would be wrong rather than merely incomplete.
 *
 * '5' recognizes legacy equation objects (MathType, Equation 3.0): '4'
 * counted each as a figure, so its figure and equation counts for such a
 * document are wrong, not merely incomplete.
 *
 * It has to move in lockstep with the engine's own constant, and the worker
 * enforces that rather than trusting it — an analysis whose row says one
 * version and whose artifact says another is refused rather than stored.
 */
export const DOCX_ANALYZER_VERSION = '5';
export const PDF_ANALYZER_NAME = 'palcert-pdf';
/**
 * Phase 18 moved this five times. '2.0.0' read the citation evidence a tagged
 * PDF declares; '3.0.0' added the link annotations whose destinations name a
 * declared reference entry; '4.0.0' projects the one citation property a PDF
 * could then prove into the fact set — and fixes two fact value shapes that
 * had been unreadable by the rule engine since Phase 13; '5.0.0' projects a
 * second, a per-citation `citationTargetResolved` value; '6.0.0' recovers
 * numeric citation structure heuristically from readable untagged PDFs, which
 * carried an empty citation graph under every earlier version; '7.0.0' adds
 * the author-year family, so a reference list ordered alphabetically rather
 * than numbered is recognized too; '8.0.0' parses structured fields out of
 * a recognized entry - title, container title, DOI and URL; '9.0.0' reads an
 * identifier out of a citation's own text and links on it, so DOI_IDENTITY
 * fires for the first time; '10.0.0' supports several reference regions in one
 * document, publishes them, and recognizes raised and parenthesised numeric
 * citations; '11.0.0' projects the first advisory facts - heuristic citation
 * and reference counters that the evaluator reports and never decides on.
 *
 * Every move is the same rule. A check run against an earlier analysis finds
 * whatever that analyzer found and reports nothing about the rest, silently,
 * because an artifact without the newer evidence is a valid artifact.
 */
export const PDF_ANALYZER_VERSION = '11.0.0';

/**
 * Which analyzer reads which format (Phase 13 §10, §11).
 *
 * Dispatch is a table rather than a branch so that adding a format is adding a
 * row. The DOCX entry is exactly what Phase 6 used, unchanged: a historical
 * DOCX analysis must still resolve to the analyzer that produced it, and its
 * artifact hashes must not move (§11).
 */
const ANALYZERS: Readonly<
  Record<
    'DOCX' | 'PDF',
    {
      name: string;
      version: string;
      /**
       * The artifact envelope version this analyzer emits.
       *
       * Per analyzer rather than per release. Phase 18 moved DOCX to envelope
       * 2 first and PDF later, so for part of the phase they genuinely
       * disagreed — and this number is stamped on the row before the artifact
       * exists, so a shared one would have been wrong in the record rather
       * than in a variable.
       */
      analysisSchemaVersion: number;
      jobType: ProcessingJobType;
    }
  >
> = {
  DOCX: {
    name: DOCX_ANALYZER_NAME,
    version: DOCX_ANALYZER_VERSION,
    analysisSchemaVersion: 2,
    jobType: ProcessingJobType.DOCX_ANALYSIS,
  },
  PDF: {
    name: PDF_ANALYZER_NAME,
    version: PDF_ANALYZER_VERSION,
    analysisSchemaVersion: 2,
    jobType: ProcessingJobType.PDF_ANALYSIS,
  },
};

/** Formats that have an analyzer at all. */
export const ANALYZABLE_FORMATS: readonly DocumentFormat[] = [
  DocumentFormat.DOCX,
  DocumentFormat.PDF,
];

export function analyzerFor(format: DocumentFormat): { name: string; version: string } {
  const analyzer = ANALYZERS[format as 'DOCX' | 'PDF'];
  if (analyzer === undefined) {
    throw new AppError(PalCertErrorCode.DOCX_ANALYSIS_UNSUPPORTED_FORMAT, {
      message: 'PalCert has no analyzer for this format.',
      details: { format },
    });
  }
  return { name: analyzer.name, version: analyzer.version };
}

export interface EnsureAnalysisResult {
  readonly analysis: DocumentAnalysis;
  /** True when this call created the row rather than reusing one. */
  readonly created: boolean;
}

/**
 * Producing and reusing document analyses (§8, §9).
 *
 * **Analysis is on demand, not on upload.** Every READY DOCX and PDF is
 * *analyzable*;
 * none is analyzed until something asks. Phase 7 will ask when a user requests
 * a check, and paying to parse documents nobody checks would be a cost with no
 * customer (§9).
 *
 * **Asking twice costs once.** `ensureDocumentAnalysis` returns any compatible
 * analysis — same version, same analyzer, same analyzer version, same fact
 * schema — and
 * creates one only when there is none. The database enforces that with a
 * partial unique index over the live states, so two concurrent callers race
 * safely: one inserts, the other reads the winner.
 *
 * **A successful analysis is immutable.** A new analyzer version produces a
 * new row, never a rewritten one, so a check recorded months ago still
 * resolves to the facts that produced it (§7, ADR-0041).
 */
@Injectable()
export class DocumentAnalysisService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly jobs: ProcessingJobService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DocumentAnalysisService.name);
  }

  /**
   * The compatible analysis for a version, creating and queueing one if needed.
   *
   * Returns immediately: analysis is asynchronous. The caller polls or waits
   * for the job, exactly as Phase 5's ingestion does.
   */
  async ensureDocumentAnalysis(
    userId: string,
    documentVersionId: string,
  ): Promise<EnsureAnalysisResult> {
    // The format decides the analyzer, so it has to be known before a
    // compatible analysis can even be looked for: a PDF analysis is not a
    // compatible substitute for a DOCX one and vice versa.
    const format = await this.tenant.withUser(userId, async (tx) => {
      const version = await this.loadAnalyzableVersion(tx, documentVersionId);
      return version.detectedFormat as DocumentFormat;
    });

    const existing = await this.findCompatible(userId, documentVersionId, format);
    if (existing !== null) {
      return { analysis: existing, created: false };
    }

    const analyzer = ANALYZERS[format as 'DOCX' | 'PDF'];
    const created = await this.tenant.withUser(userId, async (tx) => {
      const version = await this.loadAnalyzableVersion(tx, documentVersionId);

      // Re-check inside the transaction: between the read above and here,
      // another request may have created the analysis this one would duplicate.
      const concurrent = await tx.documentAnalysis.findFirst({
        where: this.compatibilityWhere(documentVersionId, format),
      });
      if (concurrent !== null) return { analysis: concurrent, created: false };

      const analysisId = randomUUID();
      const analysis = await tx.documentAnalysis.create({
        data: {
          id: analysisId,
          documentVersionId,
          ownerUserId: userId,
          analyzerName: analyzer.name,
          analyzerVersion: analyzer.version,
          factSchemaVersion: this.config.analysis.factSchemaVersion,
          analysisSchemaVersion: analyzer.analysisSchemaVersion,
          status: DocumentAnalysisStatus.PENDING,
          // Pinned now: the worker verifies the bytes against this and refuses
          // to analyze anything else (§5).
          sourceSha256: version.sha256!,
        },
      });

      await this.jobs.enqueueInTransaction(tx, {
        type: analyzer.jobType,
        resourceType: 'DOCUMENT_ANALYSIS',
        resourceId: analysis.id,
        ownerUserId: userId,
      });

      return { analysis, created: true };
    });

    if (created.created) {
      const job = await this.jobs.findByResource(analyzer.jobType, created.analysis.id);
      if (job !== null) await this.dispatcher.dispatchNow(job.id);
    }
    return created;
  }

  /** Every analysis of one version the caller owns, newest first. */
  async listForVersion(userId: string, documentVersionId: string): Promise<DocumentAnalysis[]> {
    return this.tenant.withUser(userId, async (tx) => {
      await this.loadVersion(tx, documentVersionId);
      return tx.documentAnalysis.findMany({
        where: { documentVersionId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
      });
    });
  }

  async findById(userId: string, analysisId: string): Promise<DocumentAnalysis> {
    const analysis = await this.tenant.withUser(userId, (tx) =>
      tx.documentAnalysis.findUnique({ where: { id: analysisId } }),
    );
    if (analysis === null) {
      // Row-level security already returns nothing for another user's
      // analysis, so this is the same 404 a stranger gets (ADR-0017).
      throw new AppError(PalCertErrorCode.DOCX_ANALYSIS_NOT_AVAILABLE, {
        message: 'No such analysis.',
      });
    }
    return analysis;
  }

  /** The compatible analysis, if one exists in a live state. */
  private async findCompatible(
    userId: string,
    documentVersionId: string,
    format: DocumentFormat,
  ): Promise<DocumentAnalysis | null> {
    return this.tenant.withUser(userId, (tx) =>
      tx.documentAnalysis.findFirst({ where: this.compatibilityWhere(documentVersionId, format) }),
    );
  }

  private compatibilityWhere(
    documentVersionId: string,
    format: DocumentFormat,
  ): {
    documentVersionId: string;
    analyzerName: string;
    analyzerVersion: string;
    factSchemaVersion: number;
    status: { in: string[] };
  } {
    const analyzer = analyzerFor(format);
    return {
      documentVersionId,
      analyzerName: analyzer.name,
      analyzerVersion: analyzer.version,
      factSchemaVersion: this.config.analysis.factSchemaVersion,
      // FAILED is excluded deliberately: a failed analysis keeps its record of
      // what went wrong and must not stand in for a usable one (§7).
      status: {
        in: [
          DocumentAnalysisStatus.PENDING,
          DocumentAnalysisStatus.RUNNING,
          DocumentAnalysisStatus.SUCCEEDED,
        ],
      },
    };
  }

  private async loadVersion(tx: TenantClient, documentVersionId: string) {
    const version = await tx.documentVersion.findUnique({ where: { id: documentVersionId } });
    if (version === null) {
      throw new AppError(PalCertErrorCode.DOCUMENT_VERSION_NOT_FOUND, {
        message: 'No such document version.',
      });
    }
    return version;
  }

  /**
   * The version must be a READY DOCX or PDF with a clean object and a digest.
   *
   * Every one of those is a Phase 5 guarantee, and analysis depends on all of
   * them: nothing may read an object that was not scanned, promoted and
   * hashed (§4, §124).
   */
  private async loadAnalyzableVersion(tx: TenantClient, documentVersionId: string) {
    const version = await this.loadVersion(tx, documentVersionId);

    if (version.status !== DocumentVersionStatus.READY) {
      throw new AppError(PalCertErrorCode.DOCUMENT_NOT_READY, {
        message: 'This version is still being processed.',
      });
    }
    if (!ANALYZABLE_FORMATS.includes(version.detectedFormat as DocumentFormat)) {
      throw new AppError(PalCertErrorCode.DOCX_ANALYSIS_UNSUPPORTED_FORMAT, {
        message: 'PalCert reads Word documents and PDFs.',
        details: { format: version.detectedFormat },
      });
    }
    if (version.cleanObjectKey === null || version.sha256 === null) {
      // A READY version without both is a broken invariant, not a user error.
      throw new AppError(PalCertErrorCode.DOCX_ANALYSIS_NOT_AVAILABLE, {
        message: 'This version cannot be analyzed.',
        internalContext: { versionId: documentVersionId, reason: 'missing clean object identity' },
      });
    }
    return version;
  }

  /** The artifact key for an analysis. Server-generated, never user-supplied. */
  artifactKeyFor(analysis: DocumentAnalysis): string {
    return analysisArtifactKey({
      ownerUserId: analysis.ownerUserId,
      documentVersionId: analysis.documentVersionId,
      analysisId: analysis.id,
    });
  }
}

/** The API-facing shape. No object key, no bucket, no artifact URL (§94). */
export function toDocumentAnalysisView(analysis: DocumentAnalysis): DocumentAnalysisView {
  const failureCode = analysis.failureCode as DocumentAnalysisFailureCode | null;
  return {
    id: analysis.id,
    documentVersionId: analysis.documentVersionId,
    status: analysis.status as DocumentAnalysisStatus,
    analyzerName: analysis.analyzerName,
    analyzerVersion: analysis.analyzerVersion,
    factSchemaVersion: analysis.factSchemaVersion,
    analysisSchemaVersion: analysis.analysisSchemaVersion,
    factCount: analysis.factCount,
    warningCount: analysis.warningCount,
    warningCodes: analysis.warningCodes,
    failureCode,
    retryable: failureCode === null ? false : !isPermanentAnalysisFailure(failureCode),
    createdAt: analysis.createdAt.toISOString(),
    startedAt: analysis.startedAt?.toISOString() ?? null,
    completedAt: analysis.completedAt?.toISOString() ?? null,
    failedAt: analysis.failedAt?.toISOString() ?? null,
  };
}
