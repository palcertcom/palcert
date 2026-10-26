import { Injectable } from '@nestjs/common';
import {
  AppError,
  CheckStatus,
  PalCertErrorCode,
  buildPage,
  compareFindings,
  decodeCursor,
  encodeCursor,
  resolveLimit,
  scoreForDisplay,
  type CheckFailureCode,
  type CheckReportMetadataView,
  type CheckRuleResultView,
  type CheckViolationView,
  type ComplianceDetermination,
  type DocumentCheckView,
  type DocumentFormat,
  type Page,
  type PdfDocumentView,
} from '@palcert/contracts';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../../../config/api-config.service';
import { ObjectStoragePort } from '../../../infrastructure/storage/object-storage.port';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import {
  toBillingView,
  type PurchaseWithHolds,
} from '../../finance/services/service-purchase.service';

export interface ListChecksQuery {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  readonly status?: CheckStatus | undefined;
  readonly determination?: ComplianceDetermination | undefined;
  readonly documentId?: string | undefined;
  readonly standardId?: string | undefined;
}

export interface ListResultsQuery {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  readonly outcome?: string | undefined;
  readonly severity?: string | undefined;
  readonly blocking?: boolean | undefined;
}

/**
 * Reading checks, results and reports back (§72–§80).
 *
 * Every query here runs under the caller's own row-level security context, so
 * another user's check is not hidden by a `WHERE` clause this code could
 * forget — it is invisible to the connection (ADR-0018).
 *
 * Nothing here recomputes anything. The determination, the score and the
 * counts were decided once when the report was written; a list page that
 * recalculated them could disagree with the report the user is looking at.
 */
@Injectable()
export class CheckReadService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly storage: ObjectStoragePort,
    private readonly config: ApiConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CheckReadService.name);
  }

  async list(userId: string, query: ListChecksQuery): Promise<Page<DocumentCheckView>> {
    const limit = Math.min(resolveLimit(query.limit), this.config.checks.maxPageSize);
    const cursor = parseCursor(query.cursor);

    const rows = await this.tenant.withUser(userId, (tx) =>
      tx.documentCheck.findMany({
        where: {
          ownerUserId: userId,
          ...(query.status !== undefined ? { status: query.status } : {}),
          ...(query.documentId !== undefined ? { documentId: query.documentId } : {}),
          ...(query.standardId !== undefined ? { standardId: query.standardId } : {}),
          ...(query.determination !== undefined
            ? { runs: { some: { determination: query.determination } } }
            : {}),
          ...(cursor === null
            ? {}
            : {
                OR: [
                  { createdAt: { lt: new Date(cursor.sortValue) } },
                  { createdAt: new Date(cursor.sortValue), id: { gt: cursor.id } },
                ],
              }),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: limit + 1,
        include: CHECK_VIEW_INCLUDE,
      }),
    );

    return buildPage(rows.map(toCheckView), limit, (item) => encodeCursor(item.createdAt, item.id));
  }

  async get(userId: string, checkId: string): Promise<DocumentCheckView> {
    const row = await this.tenant.withUser(userId, (tx) =>
      tx.documentCheck.findUnique({ where: { id: checkId }, include: CHECK_VIEW_INCLUDE }),
    );
    if (row === null) {
      throw new AppError(PalCertErrorCode.CHECK_NOT_FOUND, { message: 'No such check.' });
    }
    return toCheckView(row);
  }

  /**
   * The rule results of a check's completed run, worst first (§77).
   *
   * Paged, because a standard can carry hundreds of rules and each of them
   * hundreds of violations; loading all of it into one response would make
   * the report page unusable on exactly the documents that need it most.
   */
  async results(
    userId: string,
    checkId: string,
    query: ListResultsQuery,
  ): Promise<Page<CheckRuleResultView>> {
    const limit = Math.min(resolveLimit(query.limit), this.config.checks.maxPageSize);
    const runId = await this.completedRunId(userId, checkId);

    const rows = await this.tenant.withUser(userId, (tx) =>
      tx.checkRuleResult.findMany({
        where: {
          checkRunId: runId,
          ...(query.outcome !== undefined ? { outcome: query.outcome } : {}),
          ...(query.severity !== undefined ? { severity: query.severity } : {}),
          ...(query.blocking !== undefined ? { blocking: query.blocking } : {}),
        },
        include: {
          violations: {
            orderBy: { ordinal: 'asc' },
            take: this.config.checks.maxReturnedViolationsPerRule,
          },
        },
      }),
    );

    // Sorted in the application rather than the database because the order is
    // a product decision (blocking critical failures first, then severity,
    // then display order) that must match the stored report exactly (§49).
    const ordered = [...rows].sort(compareFindings);

    const offset = query.cursor === undefined ? 0 : decodeOffset(query.cursor);
    const window = ordered.slice(offset, offset + limit + 1);
    const views = window.map((row) => toRuleResultView(row));

    const hasMore = views.length > limit;
    return {
      items: hasMore ? views.slice(0, limit) : views,
      nextCursor: hasMore ? encodeOffset(offset + limit) : null,
    };
  }

  async reportMetadata(userId: string, checkId: string): Promise<CheckReportMetadataView> {
    const report = await this.tenant.withUser(userId, (tx) =>
      tx.checkReport.findFirst({
        where: { checkId },
        orderBy: { createdAt: 'desc' },
      }),
    );
    if (report === null) {
      throw new AppError(PalCertErrorCode.REPORT_NOT_FOUND, {
        message: 'This check has not produced a report.',
      });
    }
    return {
      id: report.id,
      checkId: report.checkId,
      checkRunId: report.checkRunId,
      reportSchemaVersion: report.reportSchemaVersion,
      reportCanonicalizationVersion: report.reportCanonicalizationVersion,
      reportHash: report.reportHash,
      evaluationHash: report.evaluationHash,
      createdAt: report.createdAt.toISOString(),
    };
  }

  /**
   * The stored report artifact, streamed through the API.
   *
   * Never a presigned URL and never the object key: the derived bucket is
   * private, has no public CORS and no public URL, and a key is an internal
   * detail a client has no business holding (§53, §94).
   *
   * Viewing a historical report re-reads this object. It never re-runs the
   * rule engine (§74).
   */
  async reportArtifact(userId: string, checkId: string): Promise<{ content: Buffer }> {
    const report = await this.tenant.withUser(userId, (tx) =>
      tx.checkReport.findFirst({ where: { checkId }, orderBy: { createdAt: 'desc' } }),
    );
    if (report === null) {
      throw new AppError(PalCertErrorCode.REPORT_NOT_FOUND, {
        message: 'This check has not produced a report.',
      });
    }

    const content = await this.storage.getObjectBytes({
      zone: 'derived',
      key: report.artifactObjectKey,
      versionId: report.artifactObjectVersionId,
    });

    return { content };
  }

  private async completedRunId(userId: string, checkId: string): Promise<string> {
    const check = await this.tenant.withUser(userId, (tx) =>
      tx.documentCheck.findUnique({ where: { id: checkId } }),
    );
    if (check === null) {
      throw new AppError(PalCertErrorCode.CHECK_NOT_FOUND, { message: 'No such check.' });
    }
    const run = await this.tenant.withUser(userId, (tx) =>
      tx.checkRun.findFirst({
        where: { checkId, status: 'SUCCEEDED' },
        orderBy: { attemptNumber: 'desc' },
      }),
    );
    if (run === null) {
      throw new AppError(PalCertErrorCode.REPORT_NOT_FOUND, {
        message: 'This check has no completed results yet.',
        details: { status: check.status },
      });
    }
    return run.id;
  }
}

/**
 * What a check view needs, and nothing that the caller cannot read.
 *
 * No join to `organizations`, `standards` or `standard_versions`: the check's
 * owner is not a member of the publishing organization, so those rows are
 * invisible to their session by design. The labels were captured onto the
 * check itself at creation, from the public catalogue the user chose from
 * (§57).
 */
const CHECK_VIEW_INCLUDE = {
  document: { select: { displayName: true } },
  documentVersion: {
    select: {
      versionNumber: true,
      detectedFormat: true,
      // The settled PDF analysis, if there is one. Counters only: the summary
      // the analyzer returns carries no document content (§107, §153).
      analyses: {
        where: { status: 'SUCCEEDED', analyzerName: 'palcert-pdf' },
        select: { summary: true },
        // At most one live PDF analysis exists per version — the partial
        // unique index over the live states guarantees it — so newest-first
        // with a limit of one is the analysis, not a pick among candidates.
        orderBy: { completedAt: 'desc' as const },
        take: 1,
      },
    },
  },
  runs: { orderBy: { attemptNumber: 'desc' as const }, take: 1 },
  reports: { orderBy: { createdAt: 'desc' as const }, take: 1, select: { id: true } },
  // Phase 11: what the check cost and where that money stands. Loaded with
  // the holds, because "reserved" and "charged" are what the holds say — a
  // stored copy could disagree with the ledger, and this one cannot.
  servicePurchase: { include: { allocations: { include: { hold: true } } } },
} as const;

/**
 * Project a check onto the API shape.
 *
 * The processing status and the compliance determination are separate fields
 * on purpose: "still evaluating" is not a verdict, and a failed check has no
 * determination at all rather than a FAIL (§10, §11).
 */
function toCheckView(row: {
  id: string;
  documentId: string;
  documentVersionId: string;
  organizationId: string;
  standardId: string;
  standardVersionId: string;
  status: string;
  currentRunId: string | null;
  failureCode: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  organizationName: string;
  documentTypeName: string;
  standardCode: string;
  standardName: string;
  standardVersionLabel: string;
  document: { displayName: string };
  documentVersion: {
    versionNumber: number;
    detectedFormat: string | null;
    analyses: readonly { summary: unknown }[];
  };
  runs: readonly {
    id: string;
    determination: string | null;
    scoreValue: string | null;
    scoreCoverage: string | null;
    scoreComplete: boolean | null;
    totalRules: number | null;
    passedRules: number | null;
    failedRules: number | null;
    notApplicableRules: number | null;
    reviewRequiredRules: number | null;
    indeterminateRules: number | null;
    blockingFailures: number | null;
    criticalFailures: number | null;
    majorFailures: number | null;
    minorFailures: number | null;
    infoFailures: number | null;
    totalViolations: number | null;
  }[];
  reports: readonly { id: string }[];
  servicePurchase: PurchaseWithHolds | null;
}): DocumentCheckView {
  const status = row.status as CheckStatus;
  const run = row.runs[0];
  // A determination is shown only for a check that actually completed: a run
  // that failed mid-way must never leave a stale verdict on the page (§11).
  const settled = status === CheckStatus.COMPLETED ? (run ?? null) : null;

  return {
    id: row.id,
    documentId: row.documentId,
    documentVersionId: row.documentVersionId,
    documentVersionNumber: row.documentVersion.versionNumber,
    documentName: row.document.displayName,
    documentFormat: (row.documentVersion.detectedFormat as DocumentFormat | null) ?? null,
    pdfDocument: toPdfDocumentView(row.documentVersion.analyses[0]?.summary),
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    documentTypeName: row.documentTypeName,
    standardId: row.standardId,
    standardCode: row.standardCode,
    standardName: row.standardName,
    standardVersionId: row.standardVersionId,
    standardVersionLabel: row.standardVersionLabel,
    // A check created before checks were paid for carries no purchase, and
    // PalCert does not invent one for it (§4, §89).
    billing: row.servicePurchase === null ? null : toBillingView(row.servicePurchase),
    legacyFree: row.servicePurchase === null,
    status,
    determination: (settled?.determination as ComplianceDetermination | null) ?? null,
    score:
      settled === null
        ? null
        : {
            value: settled.scoreValue,
            display: scoreForDisplay({
              value: settled.scoreValue,
              coverage: settled.scoreCoverage,
              complete: settled.scoreComplete ?? false,
              passedWeight: '0',
              evaluatedWeight: '0',
              unresolvedWeight: '0',
            }),
            coverage: settled.scoreCoverage,
            complete: settled.scoreComplete ?? false,
          },
    counts:
      settled === null
        ? null
        : {
            totalRules: settled.totalRules ?? 0,
            passedRules: settled.passedRules ?? 0,
            failedRules: settled.failedRules ?? 0,
            notApplicableRules: settled.notApplicableRules ?? 0,
            reviewRequiredRules: settled.reviewRequiredRules ?? 0,
            indeterminateRules: settled.indeterminateRules ?? 0,
            blockingFailures: settled.blockingFailures ?? 0,
            criticalFailures: settled.criticalFailures ?? 0,
            majorFailures: settled.majorFailures ?? 0,
            minorFailures: settled.minorFailures ?? 0,
            infoFailures: settled.infoFailures ?? 0,
            totalViolations: settled.totalViolations ?? 0,
          },
    failureCode: row.failureCode as CheckFailureCode | null,
    retryable: status === CheckStatus.FAILED,
    reportId: row.reports[0]?.id ?? null,
    currentRunId: row.currentRunId,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
  };
}

/**
 * The PDF analyzer's summary, narrowed to the counters the report page shows.
 *
 * Read defensively rather than cast: the summary is stored JSON written by a
 * different runtime, and a shape that has moved should leave the page without
 * a PDF panel rather than crash a report someone has paid for.
 */
function toPdfDocumentView(summary: unknown): PdfDocumentView | null {
  if (summary === null || typeof summary !== 'object') return null;
  const value = summary as Record<string, unknown>;
  const layer = value['textLayer'];
  if (
    layer !== 'NATIVE_TEXT' &&
    layer !== 'IMAGE_ONLY' &&
    layer !== 'HYBRID' &&
    layer !== 'EMPTY_OR_UNKNOWN'
  ) {
    return null;
  }
  const count = (name: string): number => {
    const raw = value[name];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  };
  return {
    textLayer: layer,
    tagged: value['tagged'] === true,
    pageCount: count('pageCount'),
    imageOnlyPages: count('imageOnlyPages'),
    nativeTextPages: count('nativeTextPages'),
  };
}

function toRuleResultView(row: {
  id: string;
  ruleCode: string;
  category: string;
  severity: string;
  blocking: boolean;
  evaluationMode: string;
  outcome: string;
  reasonCode: string;
  requiresReview: boolean;
  displayOrder: number;
  titleEn: string | null;
  titleAr: string | null;
  guidanceEn: string | null;
  guidanceAr: string | null;
  matchedFactCount: number;
  evaluatedFactCount: number;
  passedFactCount: number;
  failedFactCount: number;
  indeterminateFactCount: number;
  totalViolationCount: number;
  returnedViolationCount: number;
  violationsTruncated: boolean;
  violations: readonly {
    id: string;
    reasonCode: string;
    nodeId: string | null;
    path: string[];
    elementType: string | null;
    sectionKey: string | null;
    locationOrdinal: number | null;
    page: number | null;
    expectedValue: string | null;
    expectedUnit: string | null;
    actualValue: string | null;
    actualUnit: string | null;
    tolerance: string | null;
  }[];
}): CheckRuleResultView {
  return {
    id: row.id,
    ruleCode: row.ruleCode,
    category: row.category,
    severity: row.severity,
    blocking: row.blocking,
    evaluationMode: row.evaluationMode,
    outcome: row.outcome,
    reasonCode: row.reasonCode,
    requiresReview: row.requiresReview,
    displayOrder: row.displayOrder,
    titleEn: row.titleEn,
    titleAr: row.titleAr,
    guidanceEn: row.guidanceEn,
    guidanceAr: row.guidanceAr,
    matchedFactCount: row.matchedFactCount,
    evaluatedFactCount: row.evaluatedFactCount,
    passedFactCount: row.passedFactCount,
    failedFactCount: row.failedFactCount,
    indeterminateFactCount: row.indeterminateFactCount,
    totalViolationCount: row.totalViolationCount,
    returnedViolationCount: row.returnedViolationCount,
    violationsTruncated: row.violationsTruncated,
    violations: row.violations.map<CheckViolationView>((violation) => ({
      id: violation.id,
      reasonCode: violation.reasonCode,
      nodeId: violation.nodeId,
      path: violation.path,
      elementType: violation.elementType,
      sectionKey: violation.sectionKey,
      ordinal: violation.locationOrdinal,
      page: violation.page,
      expectedValue: violation.expectedValue,
      expectedUnit: violation.expectedUnit,
      actualValue: violation.actualValue,
      actualUnit: violation.actualUnit,
      tolerance: violation.tolerance,
    })),
  };
}

function parseCursor(cursor: string | undefined): { sortValue: string; id: string } | null {
  if (cursor === undefined) return null;
  const decoded = decodeCursor(cursor);
  if (decoded === null || Number.isNaN(Date.parse(decoded.sortValue))) {
    throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
      message: 'That page cursor is not one this API issued.',
      details: { field: 'cursor' },
    });
  }
  return decoded;
}

/**
 * Results page by offset, not by key.
 *
 * Their order is a computed ranking rather than a column, so a keyset cursor
 * would have to encode the ranking itself. The set is bounded (a standard
 * carries at most a thousand rules) and immutable once written, so an offset
 * is stable here in a way it would not be over a mutable table.
 */
function encodeOffset(offset: number): string {
  return Buffer.from(`offset:${offset}`, 'utf8').toString('base64url');
}

function decodeOffset(cursor: string): number {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^offset:(\d{1,6})$/.exec(decoded);
  if (match === null) {
    throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
      message: 'That page cursor is not one this API issued.',
      details: { field: 'cursor' },
    });
  }
  return Number.parseInt(match[1]!, 10);
}
