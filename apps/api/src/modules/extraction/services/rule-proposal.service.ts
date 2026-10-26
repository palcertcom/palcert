import { Injectable } from '@nestjs/common';
import {
  AppError,
  EvidenceKind,
  ExtractionInvocationPurpose,
  ExtractionProgressStage,
  EvidenceLocatorType,
  ObservationUniformity,
  PalCertErrorCode,
  ProposalConflictStatus,
  ProposalRejectionReason,
  ProposalValidationStatus,
  RuleExtractionStatus,
  RuleProposalKind,
  RuleProposalStatus,
  proposalIsAcceptable,
  isExtractionCancellable,
  proposalIsReadyToAccept,
  ruleStructuringBatchCount,
  type ExtractionProgressView,
  type ProposalValidationIssueView,
  type RuleDefinition,
  type RuleExtractionRunView,
  type RuleProposalDetailView,
  type RuleProposalSummaryView,
  type RuleProposalView,
  type RuleProvenanceView,
  type SourceEvidenceView,
  type StandardSourceKind,
  type StandardVersionExtractionCountersView,
  type TemplateObservationView,
} from '@palcert/contracts';
import { ApiConfigService } from '../../../config/api-config.service';
import {
  TenantPrismaService,
  type TenantTransactionOptions,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { ClockPort } from '../../auth/ports/clock.port';
import type { TenantContext } from '../../organizations/tenant-context';
import { bumpVersionRevision, insertRule } from '../../standards/services/rule.service';
import { ProposalValidationService, scopeKeyOf } from './proposal-validation.service';
import { loadRun, toRunView } from './rule-extraction.service';
import {
  assertVersionVisible,
  scopeOf,
  type SourceRequestContext,
} from './standard-source.service';

export interface AcceptProposalInput {
  /** The draft revision the reviewer was looking at (§71). */
  readonly expectedRevision: number;
  /** A rule the reviewer edited before accepting. Absent means accept as proposed. */
  readonly rule?: Record<string, unknown> | undefined;
  readonly reviewNotes?: string | undefined;
  /** The reviewer's own correction of the normative origin (§125). */
  readonly origin?: string | undefined;
}

/** How many proposals one bulk request may name. */
export const BULK_PROPOSAL_LIMIT = 200;

/** One bulk rejection is a few hundred small statements; give it room. */
const BULK_DECISION_TRANSACTION: TenantTransactionOptions = { timeoutMs: 30_000, maxWaitMs: 5_000 };

export interface BulkRejectResult {
  readonly rejected: string[];
  readonly skipped: { id: string; reason: string }[];
}

export interface RejectProposalInput {
  readonly reason?: ProposalRejectionReason | undefined;
  readonly reviewNotes?: string | undefined;
}

/**
 * Reading proposals and deciding on them (§65, §66, §67, §68, §69).
 *
 * The phase's defining sentence lives in this file: **AI proposes, an
 * authorized human decides.** Three things make that structural rather than
 * aspirational.
 *
 * The AI's proposal is never edited. A reviewer who changes a value before
 * accepting produces a *decision* carrying their version; the proposal still
 * says what the model said. Rewriting it to match would destroy the only
 * record of who actually chose (§66).
 *
 * Acceptance goes through Phase 3's own rule insert, with Phase 3's own
 * validation, at the draft's own schema version. There is deliberately no
 * second write path an "AI rule" could take (§123).
 *
 * And nothing here publishes. Publication is the Phase 3 human action it
 * always was, and no code path leads from an extraction to it (§73).
 */
@Injectable()
export class RuleProposalService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly validation: ProposalValidationService,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
    private readonly config: ApiConfigService,
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async listRuns(context: TenantContext, versionId: string): Promise<RuleExtractionRunView[]> {
    const runs = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      await assertVersionVisible(tx, versionId);
      return tx.ruleExtractionRun.findMany({
        where: { standardVersionId: versionId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { sources: { orderBy: { ordinal: 'asc' } } },
      });
    });
    return runs.map((run) =>
      toRunView(
        run,
        run.sources.map((source) => source.sourceAssetId),
      ),
    );
  }

  async getRun(
    context: TenantContext,
    versionId: string,
    runId: string,
  ): Promise<RuleExtractionRunView> {
    const { run, sources } = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      await assertVersionVisible(tx, versionId);
      const found = await loadRun(tx, versionId, runId);
      const bound = await tx.ruleExtractionRunSource.findMany({
        where: { extractionRunId: runId },
        orderBy: { ordinal: 'asc' },
      });
      return { run: found, sources: bound };
    });
    return toRunView(
      run,
      sources.map((source) => source.sourceAssetId),
    );
  }

  async listProposals(
    context: TenantContext,
    versionId: string,
    runId: string,
  ): Promise<RuleProposalView[]> {
    const rows = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      await assertVersionVisible(tx, versionId);
      await loadRun(tx, versionId, runId);
      const proposals = await tx.ruleProposal.findMany({
        where: { extractionRunId: runId },
        orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
        include: { evidenceLinks: true, decision: true },
      });
      // Three reads for the whole run, not one per proposal: the review table
      // needs each row's source and measurement without a request per row.
      const [evidence, observations, sources] = await Promise.all([
        tx.sourceEvidence.findMany({
          where: { extractionRunId: runId },
          select: { id: true, sourceAssetId: true },
        }),
        tx.templateObservation.findMany({
          where: { extractionRunId: runId },
          select: {
            id: true,
            sourceAssetId: true,
            ordinal: true,
            property: true,
            unit: true,
            modalValue: true,
            occurrenceCount: true,
            matchingCount: true,
            uniformity: true,
          },
        }),
        tx.standardSourceAsset.findMany({
          where: { standardVersionId: versionId },
          select: { id: true, originalFilename: true, sourceKind: true },
        }),
      ]);
      return { proposals, evidence, observations, sources };
    });

    const evidenceSource = new Map(rows.evidence.map((row) => [row.id, row.sourceAssetId]));
    const observationById = new Map(rows.observations.map((row) => [row.id, row]));
    const labels = new Map(rows.sources.map((source) => [source.id, source]));

    return rows.proposals.map((proposal) => {
      const view = toProposalView(proposal);
      const cited = view.observationIds
        .map((id) => observationById.get(id))
        .filter((row): row is NonNullable<typeof row> => row !== undefined)
        .sort((a, b) => a.ordinal - b.ordinal);
      const sourceIds = [
        ...new Set([
          ...view.evidenceIds
            .map((id) => evidenceSource.get(id))
            .filter((id): id is string => id !== undefined),
          ...cited.map((row) => row.sourceAssetId),
        ]),
      ];
      const first = cited[0];
      const summary: RuleProposalSummaryView = {
        sources: sourceIds.map((id) => ({
          sourceAssetId: id,
          sourceFilename: labels.get(id)?.originalFilename ?? 'source',
          sourceKind: (labels.get(id)?.sourceKind ?? 'GUIDELINE_PDF') as StandardSourceKind,
        })),
        evidenceCount: view.evidenceIds.length,
        observationCount: view.observationIds.length,
        observation:
          first === undefined
            ? null
            : {
                property: first.property,
                unit: first.unit,
                modalValue: first.modalValue,
                occurrenceCount: first.occurrenceCount,
                matchingCount: first.matchingCount,
                uniformity: first.uniformity as ObservationUniformity,
              },
      };
      return { ...view, summary };
    });
  }

  /**
   * Where a run has got to (§92), cheap enough to poll.
   *
   * Everything is read back from what the worker stored — the run's status,
   * the provider invocations it opened and settled, the evidence it saved — so
   * a reviewer who reloads the page sees the same answer, and nothing is
   * extrapolated from elapsed time.
   */
  async progress(
    context: TenantContext,
    versionId: string,
    runId: string,
  ): Promise<ExtractionProgressView> {
    const now = this.clock.now();
    const read = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      await assertVersionVisible(tx, versionId);
      const run = await loadRun(tx, versionId, runId);
      // A retried run starts its passes again with a fresh `startedAt`; only
      // the calls of the current attempt describe where it is now.
      const since = run.startedAt ?? run.createdAt;
      const [invocations, bound, evidenceCount, observationCount, proposalCount] =
        await Promise.all([
          tx.extractionInvocation.findMany({
            where: { extractionRunId: runId, startedAt: { gte: since } },
            select: { purpose: true, status: true, sourceAssetId: true, startedAt: true },
            orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
          }),
          tx.ruleExtractionRunSource.findMany({
            where: { extractionRunId: runId },
            orderBy: { ordinal: 'asc' },
            select: { sourceAssetId: true, sourceKind: true },
          }),
          tx.sourceEvidence.count({ where: { extractionRunId: runId } }),
          tx.templateObservation.count({ where: { extractionRunId: runId } }),
          tx.ruleProposal.count({ where: { extractionRunId: runId } }),
        ]);
      return { run, invocations, bound, evidenceCount, observationCount, proposalCount };
    });

    const { run, invocations, bound } = read;
    const status = run.status as RuleExtractionStatus;
    const structuring = invocations.filter(
      (row) => row.purpose === ExtractionInvocationPurpose.GUIDELINE_RULE_STRUCTURING,
    );
    const successfulBatches = structuring.filter((row) => row.status === 'SUCCEEDED').length;
    const failedBatches = structuring.filter((row) => row.status === 'FAILED').length;
    const completedBatches = successfulBatches + failedBatches;

    // Evidence and observations are saved together, before Pass B begins.
    const evidenceSaved =
      status === RuleExtractionStatus.GENERATING_PROPOSALS ||
      status === RuleExtractionStatus.VALIDATING ||
      status === RuleExtractionStatus.COMPLETED ||
      read.evidenceCount + read.observationCount > 0;
    const planned = evidenceSaved
      ? ruleStructuringBatchCount({
          items: read.evidenceCount + read.observationCount,
          maxRulesPerRequest: this.config.ai.maxRulesPerRequest,
        })
      : null;
    // Generation stops early once the proposal cap is reached, so a finished
    // run reports the calls it actually made rather than the plan.
    const totalBatches =
      status === RuleExtractionStatus.COMPLETED && structuring.length > 0
        ? completedBatches
        : planned === null
          ? null
          : Math.max(planned, completedBatches);

    const finishedAt = run.completedAt ?? run.failedAt ?? run.cancelledAt ?? null;
    const startedAt = run.startedAt ?? null;
    const elapsedSeconds =
      startedAt === null
        ? null
        : Math.max(0, Math.round(((finishedAt ?? now).getTime() - startedAt.getTime()) / 1000));

    return {
      runId: run.id,
      status,
      stage: progressStage(status, invocations, bound),
      failureKind: run.failureKind,
      completedBatches,
      totalBatches,
      successfulBatches,
      failedBatches,
      evidenceCount: evidenceSaved ? read.evidenceCount : null,
      observationCount: evidenceSaved ? read.observationCount : null,
      proposalCount: status === RuleExtractionStatus.COMPLETED ? read.proposalCount : null,
      elapsedSeconds,
      cancellable: isExtractionCancellable(status),
      startedAt: startedAt?.toISOString() ?? null,
      finishedAt: finishedAt?.toISOString() ?? null,
    };
  }

  /** One proposal with the evidence a reviewer needs beside it (§95). */
  async getProposal(
    context: TenantContext,
    versionId: string,
    runId: string,
    proposalId: string,
  ): Promise<RuleProposalDetailView> {
    return this.tenant.withTenant(scopeOf(context), async (tx) => {
      await assertVersionVisible(tx, versionId);
      await loadRun(tx, versionId, runId);
      const proposal = await tx.ruleProposal.findFirst({
        where: { id: proposalId, extractionRunId: runId },
        include: { evidenceLinks: true, decision: true },
      });
      if (proposal === null) throw proposalNotFound();

      const evidenceIds = proposal.evidenceLinks
        .map((link) => link.sourceEvidenceId)
        .filter((id): id is string => id !== null);
      const observationIds = proposal.evidenceLinks
        .map((link) => link.templateObservationId)
        .filter((id): id is string => id !== null);

      const [evidence, observations, sources] = await Promise.all([
        tx.sourceEvidence.findMany({
          where: { id: { in: evidenceIds } },
          orderBy: { ordinal: 'asc' },
        }),
        tx.templateObservation.findMany({
          where: { id: { in: observationIds } },
          orderBy: { ordinal: 'asc' },
        }),
        tx.standardSourceAsset.findMany({ where: { standardVersionId: versionId } }),
      ]);
      const labels = new Map(
        sources.map((source) => [
          source.id,
          { filename: source.originalFilename, kind: source.sourceKind as StandardSourceKind },
        ]),
      );

      return {
        ...toProposalView(proposal),
        evidence: evidence.map((row) => toEvidenceView(row, labels)),
        observations: observations.map((row) => toObservationView(row, labels)),
      };
    });
  }

  /** Where an accepted rule came from (§76). */
  async provenanceForRule(
    context: TenantContext,
    versionId: string,
    ruleId: string,
  ): Promise<RuleProvenanceView[]> {
    return this.tenant.withTenant(scopeOf(context), async (tx) => {
      await assertVersionVisible(tx, versionId);
      const rows = await tx.standardRuleProvenance.findMany({
        where: { standardRuleId: ruleId },
        orderBy: { createdAt: 'asc' },
      });
      const sources = await tx.standardSourceAsset.findMany({
        where: { id: { in: rows.map((row) => row.sourceAssetId) } },
      });
      const labels = new Map(sources.map((source) => [source.id, source]));

      return rows.map((row) => ({
        standardRuleId: row.standardRuleId,
        extractionRunId: row.extractionRunId,
        proposalId: row.proposalId,
        sourceAssetId: row.sourceAssetId,
        sourceFilename: labels.get(row.sourceAssetId)?.originalFilename ?? 'source',
        sourceKind: (labels.get(row.sourceAssetId)?.sourceKind ??
          'GUIDELINE_PDF') as StandardSourceKind,
        sourceSha256: row.sourceSha256,
        evidenceKind: row.evidenceKind as EvidenceKind,
        locatorType: row.locatorType as EvidenceLocatorType,
        startPage: row.startPage,
        endPage: row.endPage,
        nodeIds: row.nodeIds,
        createdAt: row.createdAt.toISOString(),
      }));
    });
  }

  /** Counters for the version page (§156). */
  async counters(
    context: TenantContext,
    versionId: string,
  ): Promise<StandardVersionExtractionCountersView> {
    return this.tenant.withTenant(scopeOf(context), async (tx) => {
      await assertVersionVisible(tx, versionId);
      const runs = await tx.ruleExtractionRun.findMany({
        where: { standardVersionId: versionId },
        select: { id: true },
      });
      const runIds = runs.map((run) => run.id);
      const [sources, proposals] = await Promise.all([
        tx.standardSourceAsset.count({ where: { standardVersionId: versionId } }),
        runIds.length === 0
          ? Promise.resolve([])
          : tx.ruleProposal.findMany({
              where: { extractionRunId: { in: runIds } },
              select: { status: true, conflictStatus: true },
            }),
      ]);

      return {
        sources,
        extractionRuns: runIds.length,
        pendingProposals: proposals.filter(
          (proposal) => proposal.status === RuleProposalStatus.PENDING_REVIEW,
        ).length,
        acceptedProposals: proposals.filter(
          (proposal) =>
            proposal.status === RuleProposalStatus.ACCEPTED ||
            proposal.status === RuleProposalStatus.MODIFIED_AND_ACCEPTED,
        ).length,
        rejectedProposals: proposals.filter(
          (proposal) => proposal.status === RuleProposalStatus.REJECTED,
        ).length,
        conflicts: proposals.filter(
          (proposal) => proposal.conflictStatus !== ProposalConflictStatus.NONE,
        ).length,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  /**
   * Accept a proposal, as proposed or as the reviewer edited it (§67, §68).
   *
   * Atomic: the rule, the decision, the provenance link, the retention lock and
   * the version's revision all commit together, or none of them do. A rule
   * without a decision would be a rule nobody chose; a decision without a rule
   * would be an audit trail pointing at nothing.
   */
  async accept(
    context: TenantContext,
    versionId: string,
    runId: string,
    proposalId: string,
    input: AcceptProposalInput,
    request: SourceRequestContext,
  ): Promise<RuleProposalView> {
    const now = this.clock.now();

    const result = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      const version = await assertVersionVisible(tx, versionId);
      if (version.status !== 'DRAFT') {
        throw new AppError(PalCertErrorCode.STANDARD_VERSION_IMMUTABLE, {
          message:
            'This version is published and cannot be edited. Clone it into a new draft first.',
        });
      }
      // The reviewer's view of the draft must still be current: someone else
      // may have added the very rule this proposal duplicates (§71).
      if (version.revision !== input.expectedRevision) {
        throw new AppError(PalCertErrorCode.STALE_STANDARD_REVISION, {
          message: 'This draft has changed since you loaded it. Reload and review again.',
          details: { expectedRevision: input.expectedRevision, currentRevision: version.revision },
        });
      }

      const run = await loadRun(tx, versionId, runId);
      const proposal = await tx.ruleProposal.findFirst({
        where: { id: proposalId, extractionRunId: runId },
        include: { evidenceLinks: true, decision: true },
      });
      if (proposal === null) throw proposalNotFound();
      if (proposal.decision !== null || proposal.status !== RuleProposalStatus.PENDING_REVIEW) {
        throw new AppError(PalCertErrorCode.RULE_PROPOSAL_ALREADY_DECIDED, {
          message: 'Someone has already decided on this proposal.',
        });
      }
      if (!proposalIsAcceptable(proposal.kind as RuleProposalKind)) {
        // An ambiguous, conflicting or unrepresentable proposal is information
        // for the reviewer, not a rule waiting to be clicked (§44, §74).
        throw new AppError(PalCertErrorCode.RULE_PROPOSAL_NOT_ACCEPTABLE, {
          message:
            'This is a finding rather than a rule. Resolve what it raises and write the rule you want.',
          details: { kind: proposal.kind },
        });
      }

      // The reviewer's edit wins over the model's proposal, and is validated
      // exactly as a hand-written rule would be — not more leniently because
      // an AI wrote the first draft of it (§58, §68).
      const edited = input.rule !== undefined;
      const candidate = {
        ...((proposal.suggestedRule ?? {}) as Record<string, unknown>),
        ...(input.rule ?? {}),
        ...(input.origin === undefined ? {} : { origin: input.origin }),
      };
      const validated = this.validation.validate(
        proposal.kind as RuleProposalKind,
        candidate,
        version.ruleSchemaVersion,
      );
      if (validated.status !== ProposalValidationStatus.VALID || validated.definition === null) {
        throw new AppError(PalCertErrorCode.RULE_SCHEMA_INVALID, {
          message: `This rule has ${validated.issues.length} problem(s).`,
          details: { issues: validated.issues },
        });
      }

      const existing = await tx.standardRule.findMany({
        where: { standardVersionId: versionId },
        select: { id: true, ruleCode: true, scope: true, operator: true, expectedValue: true },
      });
      const conflict = this.validation.conflictWithExisting(
        validated.definition,
        existing.map((rule) => ({
          id: rule.id,
          ruleCode: rule.ruleCode,
          scopeKey: scopeKeyOf(rule.scope as unknown as RuleDefinition['scope']),
          operator: rule.operator,
          expectedValue: rule.expectedValue,
        })),
      );
      if (conflict.status !== ProposalConflictStatus.NONE) {
        throw new AppError(PalCertErrorCode.RULE_PROPOSAL_NOT_ACCEPTABLE, {
          message: conflict.detail ?? 'This rule collides with one already in the draft.',
          details: { conflict: conflict.status, existingRuleCode: conflict.existingRuleCode },
        });
      }

      const order = await tx.standardRule.aggregate({
        where: { standardVersionId: versionId },
        _max: { displayOrder: true },
      });

      // The Phase 3 insert, not a Phase 9 one. An accepted proposal becomes an
      // ordinary draft rule and behaves like every other from here on (§123).
      const rule = await insertRule(tx, {
        organizationId: context.organizationId,
        versionId,
        definition: {
          ...validated.definition,
          displayOrder: (order._max.displayOrder ?? -1) + 1,
        },
        ruleSchemaVersion: version.ruleSchemaVersion,
      });

      const decision = edited
        ? RuleProposalStatus.MODIFIED_AND_ACCEPTED
        : RuleProposalStatus.ACCEPTED;

      await tx.ruleProposal.update({ where: { id: proposalId }, data: { status: decision } });
      await tx.ruleProposalDecision.create({
        data: {
          organizationId: context.organizationId,
          proposalId,
          decision,
          reviewedByUserId: context.userId,
          reviewedAt: now,
          resultingRuleId: rule.id,
          reviewNotes: input.reviewNotes ?? null,
          // Stored only when it differs, so "what the human chose" is never
          // confused with "what the model proposed" (§68). Prisma distinguishes
          // "absent" from "JSON null", and absent is what an unedited
          // acceptance means.
          ...(edited ? { acceptedRule: candidate as object } : {}),
        },
      });

      // Provenance, and the retention lock that keeps it explicable (§102).
      const evidenceIds = proposal.evidenceLinks
        .map((link) => link.sourceEvidenceId)
        .filter((id): id is string => id !== null);
      const evidence = await tx.sourceEvidence.findMany({ where: { id: { in: evidenceIds } } });
      const observationIds = proposal.evidenceLinks
        .map((link) => link.templateObservationId)
        .filter((id): id is string => id !== null);
      const observations = await tx.templateObservation.findMany({
        where: { id: { in: observationIds } },
      });

      const provenance = [
        ...evidence.map((row) => ({
          sourceAssetId: row.sourceAssetId,
          evidenceKind: row.evidenceKind,
          locatorType: row.locatorType,
          startPage: row.startPage,
          endPage: row.endPage,
          nodeIds: row.nodeIds,
        })),
        ...observations.map((row) => ({
          sourceAssetId: row.sourceAssetId,
          evidenceKind: EvidenceKind.TEMPLATE_OBSERVATION,
          locatorType: EvidenceLocatorType.FACT_SCOPE,
          startPage: null,
          endPage: null,
          nodeIds: [] as string[],
        })),
      ];

      const boundSources = await tx.ruleExtractionRunSource.findMany({
        where: { extractionRunId: runId },
      });
      const digests = new Map(
        boundSources.map((source) => [source.sourceAssetId, source.sourceSha256]),
      );

      for (const entry of provenance) {
        await tx.standardRuleProvenance.create({
          data: {
            organizationId: context.organizationId,
            standardRuleId: rule.id,
            extractionRunId: run.id,
            proposalId,
            sourceAssetId: entry.sourceAssetId,
            sourceSha256: digests.get(entry.sourceAssetId) ?? '',
            evidenceKind: entry.evidenceKind,
            locatorType: entry.locatorType,
            startPage: entry.startPage,
            endPage: entry.endPage,
            nodeIds: entry.nodeIds,
          },
        });
      }
      if (provenance.length > 0) {
        await tx.standardSourceAsset.updateMany({
          where: {
            id: { in: [...new Set(provenance.map((entry) => entry.sourceAssetId))] },
            retentionLockedAt: null,
          },
          data: { retentionLockedAt: now },
        });
      }

      await bumpVersionRevision(tx, versionId);

      const stored = await tx.ruleProposal.findFirstOrThrow({
        where: { id: proposalId },
        include: { evidenceLinks: true, decision: true },
      });
      return { proposal: stored, ruleId: rule.id, decision };
    });

    await this.events.audit({
      action:
        result.decision === RuleProposalStatus.MODIFIED_AND_ACCEPTED
          ? 'RULE_PROPOSAL_MODIFIED_AND_ACCEPTED'
          : 'RULE_PROPOSAL_ACCEPTED',
      actorUserId: context.userId,
      targetType: 'RuleProposal',
      targetId: proposalId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      // Identifiers and codes only: never the guideline text (§118).
      afterState: { standardVersionId: versionId, resultingRuleId: result.ruleId },
    });

    return toProposalView(result.proposal);
  }

  /** Reject a proposal, with a reason worth keeping (§69, §70). */
  async reject(
    context: TenantContext,
    versionId: string,
    runId: string,
    proposalId: string,
    input: RejectProposalInput,
    request: SourceRequestContext,
  ): Promise<RuleProposalView> {
    const now = this.clock.now();

    const stored = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      await assertVersionVisible(tx, versionId);
      await loadRun(tx, versionId, runId);
      const proposal = await tx.ruleProposal.findFirst({
        where: { id: proposalId, extractionRunId: runId },
        include: { decision: true },
      });
      if (proposal === null) throw proposalNotFound();
      if (proposal.decision !== null || proposal.status !== RuleProposalStatus.PENDING_REVIEW) {
        throw new AppError(PalCertErrorCode.RULE_PROPOSAL_ALREADY_DECIDED, {
          message: 'Someone has already decided on this proposal.',
        });
      }

      await tx.ruleProposal.update({
        where: { id: proposalId },
        data: { status: RuleProposalStatus.REJECTED },
      });
      await tx.ruleProposalDecision.create({
        data: {
          organizationId: context.organizationId,
          proposalId,
          decision: RuleProposalStatus.REJECTED,
          reviewedByUserId: context.userId,
          reviewedAt: now,
          rejectionReason: input.reason ?? null,
          reviewNotes: input.reviewNotes ?? null,
        },
      });

      return tx.ruleProposal.findFirstOrThrow({
        where: { id: proposalId },
        include: { evidenceLinks: true, decision: true },
      });
    });

    // Kept inside PalCert. Reviewer feedback is never sent to a provider, and
    // no fine-tuning or training happens anywhere in this codebase (§70).
    await this.events.audit({
      action: 'RULE_PROPOSAL_REJECTED',
      actorUserId: context.userId,
      targetType: 'RuleProposal',
      targetId: proposalId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      afterState: { reason: input.reason ?? null },
    });

    return toProposalView(stored);
  }

  /**
   * Accept several proposals in one action (§75).
   *
   * Only ones that would already have been accepted individually: valid, with
   * no conflict, not ambiguous, not unrepresentable, still pending. Each is
   * accepted through the same path and audited separately, so "accepted in
   * bulk" is never an excuse for a rule nobody can account for.
   */
  async acceptMany(
    context: TenantContext,
    versionId: string,
    runId: string,
    proposalIds: readonly string[],
    expectedRevision: number,
    request: SourceRequestContext,
  ): Promise<{ accepted: string[]; skipped: { id: string; reason: string }[] }> {
    const accepted: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    // The draft's revision moves with every acceptance, so each one is checked
    // against the revision it will actually see.
    let revision = expectedRevision;

    for (const proposalId of proposalIds) {
      try {
        await this.accept(
          context,
          versionId,
          runId,
          proposalId,
          { expectedRevision: revision },
          request,
        );
        accepted.push(proposalId);
        revision += 1;
      } catch (error) {
        skipped.push({
          id: proposalId,
          reason: error instanceof AppError ? error.code : 'UNKNOWN',
        });
        if (error instanceof AppError && error.code === PalCertErrorCode.STALE_STANDARD_REVISION) {
          // The draft moved under us; anything after this would be decided
          // against a view nobody saw.
          break;
        }
      }
    }
    return { accepted, skipped };
  }

  /**
   * Reject several named proposals in one action (§69, §75).
   *
   * One transaction: every named proposal that is still pending is rejected,
   * or none is. Each gets its own decision row and its own audit event, exactly
   * as an individual rejection would. A proposal someone already decided —
   * including by an earlier attempt of this same request — is skipped, never
   * decided twice, so a retried request is harmless.
   */
  async rejectMany(
    context: TenantContext,
    versionId: string,
    runId: string,
    proposalIds: readonly string[],
    input: RejectProposalInput,
    request: SourceRequestContext,
  ): Promise<BulkRejectResult> {
    const now = this.clock.now();
    const requested = [...new Set(proposalIds)];

    const result = await this.tenant.withTenant(
      scopeOf(context),
      async (tx) => {
        await assertVersionVisible(tx, versionId);
        await loadRun(tx, versionId, runId);
        const found = await tx.ruleProposal.findMany({
          where: { id: { in: requested }, extractionRunId: runId },
          select: { id: true },
        });
        const known = new Set(found.map((row) => row.id));

        const rejected: string[] = [];
        const skipped: { id: string; reason: string }[] = [];
        for (const proposalId of requested) {
          if (!known.has(proposalId)) {
            // Another run's proposal, another organization's, or none at all:
            // indistinguishable from here, by design.
            skipped.push({ id: proposalId, reason: PalCertErrorCode.RULE_PROPOSAL_NOT_FOUND });
            continue;
          }
          // Conditional on still being pending, so a concurrent decision —
          // which holds the row until it commits — is observed, not overwritten.
          const claimed = await tx.ruleProposal.updateMany({
            where: {
              id: proposalId,
              extractionRunId: runId,
              status: RuleProposalStatus.PENDING_REVIEW,
              decision: { is: null },
            },
            data: { status: RuleProposalStatus.REJECTED },
          });
          if (claimed.count === 0) {
            skipped.push({
              id: proposalId,
              reason: PalCertErrorCode.RULE_PROPOSAL_ALREADY_DECIDED,
            });
            continue;
          }
          rejected.push(proposalId);
        }

        if (rejected.length > 0) {
          await tx.ruleProposalDecision.createMany({
            data: rejected.map((proposalId) => ({
              organizationId: context.organizationId,
              proposalId,
              decision: RuleProposalStatus.REJECTED,
              reviewedByUserId: context.userId,
              reviewedAt: now,
              rejectionReason: input.reason ?? null,
              reviewNotes: input.reviewNotes ?? null,
            })),
          });
        }
        return { rejected, skipped };
      },
      BULK_DECISION_TRANSACTION,
    );

    // The same event an individual rejection records, one per proposal.
    for (const proposalId of result.rejected) {
      await this.events.audit({
        action: 'RULE_PROPOSAL_REJECTED',
        actorUserId: context.userId,
        targetType: 'RuleProposal',
        targetId: proposalId,
        requestId: request.requestId,
        ipAddress: request.ipAddress,
        afterState: { reason: input.reason ?? null, bulk: true },
      });
    }
    return result;
  }
}

type InvocationProgressRow = {
  purpose: string;
  status: string;
  sourceAssetId: string | null;
};

/** Which step the stored state shows the run in (see `progress`). */
function progressStage(
  status: RuleExtractionStatus,
  invocations: readonly InvocationProgressRow[],
  sources: readonly { sourceAssetId: string; sourceKind: string }[],
): ExtractionProgressStage {
  switch (status) {
    case RuleExtractionStatus.CREATED:
    case RuleExtractionStatus.QUEUED:
      return ExtractionProgressStage.PREPARING_SOURCE;
    case RuleExtractionStatus.GENERATING_PROPOSALS:
      return ExtractionProgressStage.GENERATING_PROPOSALS;
    case RuleExtractionStatus.VALIDATING:
      return ExtractionProgressStage.VALIDATING;
    case RuleExtractionStatus.COMPLETED:
      return ExtractionProgressStage.COMPLETED;
    case RuleExtractionStatus.FAILED:
      return ExtractionProgressStage.FAILED;
    case RuleExtractionStatus.CANCELLED:
      return ExtractionProgressStage.CANCELLED;
    case RuleExtractionStatus.DISCOVERING_EVIDENCE:
      break;
  }

  // Sources are processed in their bound order: guidelines are read by the
  // provider (one discovery call each), templates are measured locally (no
  // call at all). The latest discovery call therefore says which source the
  // run reached; the one after it is next.
  const discovery = invocations.filter(
    (row) => row.purpose === ExtractionInvocationPurpose.GUIDELINE_EVIDENCE_DISCOVERY,
  );
  const latest = discovery[discovery.length - 1];
  if (latest?.status === 'PENDING') return ExtractionProgressStage.ANALYSING_SOURCE;

  const reached =
    latest === undefined
      ? -1
      : sources.findIndex((source) => source.sourceAssetId === latest.sourceAssetId);
  const next = sources[reached + 1] ?? sources[sources.length - 1];
  return next?.sourceKind === 'TEMPLATE_DOCX'
    ? ExtractionProgressStage.MEASURING_TEMPLATE
    : ExtractionProgressStage.ANALYSING_SOURCE;
}

type ProposalRow = {
  id: string;
  extractionRunId: string;
  proposalKey: string;
  kind: string;
  status: string;
  validationStatus: string;
  validationIssues: unknown;
  automationSupport: string;
  conflictStatus: string;
  conflictExistingRuleId: string | null;
  conflictExistingRuleCode: string | null;
  conflictDetail: string | null;
  relatedProposalKeys: string[];
  suggestedRule: unknown;
  suggestedRuleCode: string | null;
  interpretationEn: string;
  interpretationAr: string;
  ambiguityNote: string | null;
  requiresClarification: boolean;
  displayOrder: number;
  evidenceLinks: { sourceEvidenceId: string | null; templateObservationId: string | null }[];
  decision: {
    decision: string;
    reviewedByUserId: string | null;
    reviewedAt: Date;
    resultingRuleId: string | null;
    rejectionReason: string | null;
    reviewNotes: string | null;
    acceptedRule: unknown;
  } | null;
};

export function toProposalView(proposal: ProposalRow): RuleProposalView {
  return {
    id: proposal.id,
    extractionRunId: proposal.extractionRunId,
    proposalKey: proposal.proposalKey,
    kind: proposal.kind as RuleProposalKind,
    status: proposal.status as RuleProposalStatus,
    validationStatus: proposal.validationStatus as ProposalValidationStatus,
    validationIssues: (proposal.validationIssues ?? []) as ProposalValidationIssueView[],
    automationSupport: proposal.automationSupport as RuleProposalView['automationSupport'],
    conflict: {
      status: proposal.conflictStatus as ProposalConflictStatus,
      existingRuleId: proposal.conflictExistingRuleId,
      existingRuleCode: proposal.conflictExistingRuleCode,
      relatedProposalIds: proposal.relatedProposalKeys,
      detail: proposal.conflictDetail,
    },
    suggestedRule: proposal.suggestedRule ?? null,
    suggestedRuleCode: proposal.suggestedRuleCode,
    interpretationEn: proposal.interpretationEn,
    interpretationAr: proposal.interpretationAr,
    ambiguityNote: proposal.ambiguityNote,
    requiresClarification: proposal.requiresClarification,
    evidenceIds: proposal.evidenceLinks
      .map((link) => link.sourceEvidenceId)
      .filter((id): id is string => id !== null),
    observationIds: proposal.evidenceLinks
      .map((link) => link.templateObservationId)
      .filter((id): id is string => id !== null),
    displayOrder: proposal.displayOrder,
    decision:
      proposal.decision === null
        ? null
        : {
            decision: proposal.decision.decision as RuleProposalStatus,
            reviewedByUserId: proposal.decision.reviewedByUserId,
            reviewedAt: proposal.decision.reviewedAt.toISOString(),
            resultingRuleId: proposal.decision.resultingRuleId,
            rejectionReason: proposal.decision.rejectionReason as ProposalRejectionReason | null,
            reviewNotes: proposal.decision.reviewNotes,
            acceptedRule: proposal.decision.acceptedRule ?? null,
          },
  };
}

type SourceLabel = { filename: string; kind: StandardSourceKind };

export function toEvidenceView(
  evidence: {
    id: string;
    sourceAssetId: string;
    evidenceKind: string;
    locatorType: string;
    startPage: number | null;
    endPage: number | null;
    nodeIds: string[];
    startCharIndex: number | null;
    endCharIndex: number | null;
    excerpt: string;
    excerptHash: string;
  },
  labels: ReadonlyMap<string, SourceLabel>,
): SourceEvidenceView {
  const label = labels.get(evidence.sourceAssetId);
  return {
    id: evidence.id,
    sourceAssetId: evidence.sourceAssetId,
    sourceKind: label?.kind ?? 'GUIDELINE_PDF',
    sourceFilename: label?.filename ?? 'source',
    evidenceKind: evidence.evidenceKind as EvidenceKind,
    locatorType: evidence.locatorType as EvidenceLocatorType,
    startPage: evidence.startPage,
    endPage: evidence.endPage,
    nodeIds: evidence.nodeIds,
    startCharIndex: evidence.startCharIndex,
    endCharIndex: evidence.endCharIndex,
    excerpt: evidence.excerpt,
    excerptHash: evidence.excerptHash,
  };
}

export function toObservationView(
  observation: {
    id: string;
    sourceAssetId: string;
    scopeKey: string;
    scope: unknown;
    property: string;
    unit: string | null;
    modalValue: string | null;
    occurrenceCount: number;
    matchingCount: number;
    distinctValueCount: number;
    uniformity: string;
    distribution: unknown;
    observationHash: string;
  },
  labels: ReadonlyMap<string, SourceLabel>,
): TemplateObservationView {
  return {
    id: observation.id,
    sourceAssetId: observation.sourceAssetId,
    sourceFilename: labels.get(observation.sourceAssetId)?.filename ?? 'source',
    scopeKey: observation.scopeKey,
    scope: observation.scope,
    property: observation.property,
    unit: observation.unit,
    modalValue: observation.modalValue,
    occurrenceCount: observation.occurrenceCount,
    matchingCount: observation.matchingCount,
    distinctValueCount: observation.distinctValueCount,
    uniformity: observation.uniformity as ObservationUniformity,
    distribution: (observation.distribution ?? []) as { value: string; count: number }[],
    observationHash: observation.observationHash,
  };
}

/** Exported for the bulk-acceptance gate, which must agree with the single one (§75). */
export { proposalIsReadyToAccept };

function proposalNotFound(): AppError {
  return new AppError(PalCertErrorCode.RULE_PROPOSAL_NOT_FOUND, {
    message: 'That proposal does not exist.',
  });
}
