import { Injectable } from '@nestjs/common';
import {
  AIFailureKind,
  AIOperation,
  AIProviderError,
  AppError,
  PalCertErrorCode,
  PurchaseFailureCode,
  AIProviderPort,
  EXTRACTION_CANONICALIZATION_VERSION,
  AutomationSupport,
  DocumentFormat,
  EvidenceKind,
  EvidenceLocatorType,
  ExtractionContract,
  ExtractionFailureKind,
  ExtractionInvocationPurpose,
  ObservationUniformity,
  ProposalConflictStatus,
  ProposalValidationStatus,
  RuleExtractionStatus,
  RuleProposalKind,
  StandardSourceKind,
  computeExcerptHash,
  computeExtractionRunHash,
  isRetryableAIFailure,
  proposalRequiresRuleDefinition,
  validateExtractionContract,
  type DiscoveredCitation,
  type DocumentFactSet,
  type ExtractionDocument,
  type PalCertRuleProposalOutput,
  type ProposedRule,
  type RuleDefinition,
} from '@palcert/contracts';
import { Prisma, type ProcessingJob } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../config/api-config.service';
import {
  buildEvidenceDiscoveryInstruction,
  buildRuleStructuringPrompt,
  type EvidenceForPrompt,
  type ObservationForPrompt,
} from '../infrastructure/ai/extraction-prompt-builder';
import { PromptId, promptTemplate } from '../infrastructure/ai/prompt-registry';
import { DocumentEnginePort } from '../infrastructure/document-engine/document-engine.port';
import { ObjectStoragePort } from '../infrastructure/storage/object-storage.port';
import {
  BACKGROUND_BATCH_TRANSACTION,
  TenantPrismaService,
} from '../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../modules/auth/ports/clock.port';
import { SecurityEventService } from '../modules/auth/services/security-event.service';
import { AIServiceBillingService } from '../modules/finance/services/ai-service-billing.service';
import {
  ProposalValidationService,
  scopeKeyOf,
} from '../modules/extraction/services/proposal-validation.service';
import { TemplateObservationEngine } from '../modules/extraction/services/template-observation.service';
import { describeRuleSchema } from '@palcert/contracts';
import { requireJobOwner } from './job-owner';

/**
 * RULE_EXTRACTION (Phase 9, §22, §23, §38, §41, §109, §110).
 *
 * Two passes, because the provider API cannot serve one: citations and
 * structured outputs are mutually exclusive in a single request. Pass A grounds
 * evidence in real pages and blocks; Pass B turns that evidence into proposals
 * a person can check. Nothing between the two is taken on trust — the model's
 * prose from Pass A is never stored, and every evidence id Pass B cites must be
 * one PalCert supplied.
 *
 * What this handler cannot do is as important as what it does. It writes
 * proposals; it never writes a rule. It reads a draft version; it never changes
 * one. There is no code path from here to a published standard (§73, §145).
 *
 * On any failure the standard is untouched: the draft's rules, the sources and
 * every earlier run remain exactly as they were, and the user can try again
 * (§109).
 */
@Injectable()
export class RuleExtractionJobHandler {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly provider: AIProviderPort,
    private readonly engine: DocumentEnginePort,
    private readonly storage: ObjectStoragePort,
    private readonly observations: TemplateObservationEngine,
    private readonly validation: ProposalValidationService,
    private readonly events: SecurityEventService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
    private readonly logger: PinoLogger,
    private readonly billing: AIServiceBillingService,
  ) {
    this.logger.setContext(RuleExtractionJobHandler.name);
  }

  async handle(job: ProcessingJob): Promise<void> {
    const scope = this.scopeOf(job);
    if (scope === null) return;
    const runId = job.resourceId;

    const run = await this.tenant.withTenant(scope, (tx) =>
      tx.ruleExtractionRun.findUnique({ where: { id: runId } }),
    );
    if (run === null) {
      this.logger.warn({ jobId: job.id }, 'Extraction run no longer visible; nothing to do');
      return;
    }
    if (
      run.status === RuleExtractionStatus.COMPLETED ||
      run.status === RuleExtractionStatus.FAILED ||
      run.status === RuleExtractionStatus.CANCELLED
    ) {
      // A cancelled run whose release did not land (the cancel commits in the
      // organization's scope, the release in the payer's) is settled here.
      if (run.status === RuleExtractionStatus.CANCELLED) {
        await this.releaseFor(scope, run, PurchaseFailureCode.CANCELLED_BY_CUSTOMER, 'CANCELLED');
      }
      this.logger.info(
        { jobId: job.id, status: run.status },
        'Extraction already settled; duplicate delivery ignored',
      );
      return;
    }

    // ADR-0149: every attempt re-checks that the fee is still reserved before
    // anything reaches the provider. A lapsed or released reservation fails the
    // run here; nothing is sent and nothing is charged.
    if (!(await this.reservationLive(scope, run))) {
      await this.fail(
        scope,
        runId,
        AIFailureKind.RESERVATION_EXPIRED,
        new ExtractionFailure(
          AIFailureKind.RESERVATION_EXPIRED as never,
          'the AI service reservation is no longer active',
        ),
      );
      return;
    }

    try {
      await this.run(scope, runId);
    } catch (error) {
      const kind = classify(error);
      if (isRetryableAIFailure(kind as AIFailureKind) || isRetryableDatabaseFailure(kind)) {
        // Left for the ledger's own backoff. The run stays in flight, and the
        // standard is untouched either way.
        await this.recordTransient(scope, runId, kind);
        throw error;
      }
      await this.fail(scope, runId, kind, error);
    }
  }

  /** Mark the run FAILED once retries are exhausted (§109). */
  async failPermanently(
    job: ProcessingJob,
    failure: { code: string; message: string },
  ): Promise<void> {
    const scope = this.scopeOf(job);
    if (scope === null) return;
    // The worker's retry ladder knows only its own generic codes. The run
    // recorded what actually kept failing (`transient: <kind>`), and that is
    // the truthful kind to settle on — a database timeout must not end up
    // labelled as anything else.
    const run = await this.tenant.withTenant(scope, (tx) =>
      tx.ruleExtractionRun.findUnique({
        where: { id: job.resourceId },
        select: { failureDetail: true },
      }),
    );
    const recorded = /^transient: ([A-Z_]+)$/.exec(run?.failureDetail ?? '')?.[1];
    const kind = recorded ?? failure.code;
    await this.fail(
      scope,
      job.resourceId,
      kind,
      recorded !== undefined
        ? new ExtractionFailure(kind as never, detailFor(kind))
        : new Error(failure.message),
    );
  }

  // -------------------------------------------------------------------------
  // The two passes
  // -------------------------------------------------------------------------

  private async run(scope: Scope, runId: string): Promise<void> {
    const now = this.clock.now();
    await this.transition(scope, runId, RuleExtractionStatus.DISCOVERING_EVIDENCE, {
      startedAt: now,
    });

    const bindings = await this.loadBindings(scope, runId);

    // Pass A, per source. One call per document rather than one for all of
    // them: a 20 MB PDF and a DOCX have nothing to gain from sharing a request,
    // and a failure on one source must be attributable to that source (§110).
    const evidence: StoredEvidence[] = [];
    const observations: StoredObservation[] = [];
    let sourcesProcessed = 0;

    for (const source of bindings.sources) {
      if (source.sourceKind === StandardSourceKind.TEMPLATE_DOCX) {
        // A template is measured, never read by a model: PalCert already knows
        // exactly what it does, and asking would be slower and less accurate
        // (§31, §32).
        observations.push(...(await this.observeTemplate(scope, runId, source)));
        sourcesProcessed += 1;
        continue;
      }
      evidence.push(...(await this.discover(scope, runId, source)));
      sourcesProcessed += 1;
    }

    if (evidence.length === 0 && observations.length === 0) {
      throw new ExtractionFailure(
        ExtractionFailureKind.NO_EVIDENCE_DISCOVERED,
        'no source stated a requirement PalCert could ground',
      );
    }

    const storedEvidence = await this.persistEvidence(scope, runId, evidence, observations);

    // Pass B. Only the grounded evidence and the deterministic observations —
    // never the source documents again (§103).
    await this.transition(scope, runId, RuleExtractionStatus.GENERATING_PROPOSALS, {});
    const output = await this.propose(scope, runId, bindings, storedEvidence);

    await this.transition(scope, runId, RuleExtractionStatus.VALIDATING, {});
    await this.persistProposals(scope, runId, bindings, storedEvidence, output, sourcesProcessed);
  }

  /** Pass A for one guideline. */
  private async discover(
    scope: Scope,
    runId: string,
    source: BoundSource,
  ): Promise<StoredEvidence[]> {
    const document = await this.loadDocument(source);
    const template = promptTemplate(PromptId.GUIDELINE_EVIDENCE_DISCOVERY);
    const invocation = await this.beginInvocation(
      scope,
      runId,
      ExtractionInvocationPurpose.GUIDELINE_EVIDENCE_DISCOVERY,
      source.sourceAssetId,
      template,
    );

    const response = await this.provider
      .discoverGuidelineEvidence({
        extractionRunId: runId,
        systemPrompt: template.system,
        instruction: buildEvidenceDiscoveryInstruction({
          sourceLabels: [source.label],
          truncated: document.truncated,
        }),
        documents: [document.block],
      })
      .catch(async (error: unknown) => {
        await this.settleInvocation(scope, invocation, null, classify(error));
        throw error;
      });

    await this.settleInvocation(scope, invocation, response.usage, null);

    const found: StoredEvidence[] = [];
    for (const citation of response.citations) {
      // A citation naming a document PalCert did not send in this call locates
      // nothing, and a fabricated location is worse than no location (§55).
      if (citation.sourceAssetId !== source.sourceAssetId) continue;
      const normalized = this.normalize(citation, source, document.nodeIds);
      if (normalized !== null) found.push(normalized);
      if (found.length >= this.config.extraction.maxEvidenceBlocks) break;
    }
    return found;
  }

  /** The deterministic half: a template is measured, not read (§32). */
  private async observeTemplate(
    scope: Scope,
    runId: string,
    source: BoundSource,
  ): Promise<StoredObservation[]> {
    void scope;
    // Analysed here rather than reusing a Phase 6 analysis: those are
    // user-scoped, and an organization's template must never be satisfied by
    // reading a student's document (ADR-0031).
    void runId;
    const factSet = await this.analyzeTemplate(source);
    if (factSet === null) {
      throw new ExtractionFailure(
        ExtractionFailureKind.ANALYSIS_UNAVAILABLE,
        'the template could not be analysed',
      );
    }

    return this.observations
      .observe({
        factSet,
        sourceAssetId: source.sourceAssetId,
        sourceSha256: source.sha256,
        maxObservations: this.config.extraction.maxTemplateObservations,
      })
      .map((observation) => ({ ...observation, sourceAssetId: source.sourceAssetId }));
  }

  /** Pass B. */
  private async propose(
    scope: Scope,
    runId: string,
    bindings: Bindings,
    evidence: PersistedEvidence,
  ): Promise<PalCertRuleProposalOutput> {
    const template = promptTemplate(PromptId.GUIDELINE_RULE_STRUCTURING);
    const catalogue = await this.engine.describeDocxProperties();
    const schema = describeRuleSchema();

    const forPrompt: EvidenceForPrompt[] = evidence.evidence.map((row) => ({
      evidenceId: row.id,
      sourceLabel: bindings.labels.get(row.sourceAssetId) ?? 'source',
      sourceKind: bindings.kinds.get(row.sourceAssetId) ?? StandardSourceKind.GUIDELINE_PDF,
      evidenceKind: row.evidenceKind,
      locatorType: row.locatorType,
      locatorLabel: row.locatorLabel,
      excerpt: row.excerpt,
    }));
    const observationsForPrompt: ObservationForPrompt[] = evidence.observations.map((row) => ({
      evidenceId: row.id,
      sourceLabel: bindings.labels.get(row.sourceAssetId) ?? 'template',
      scopeKey: row.scopeKey,
      property: row.property,
      unit: row.unit,
      modalValue: row.modalValue,
      occurrenceCount: row.occurrenceCount,
      matchingCount: row.matchingCount,
      distinctValueCount: row.distinctValueCount,
      uniformity: row.uniformity,
    }));

    const vocabulary = {
      ruleSchemaVersion: bindings.ruleSchemaVersion,
      categories: schema.categories,
      operators: schema.operators.map((entry) => ({
        operator: entry.operator,
        valueTypes: entry.valueTypes,
      })),
      units: schema.units,
      patterns: schema.patterns.map((pattern) => pattern.name),
      elementTypes: schema.elementTypes,
      origins: schema.origins,
      severities: schema.severities,
    };
    const properties = catalogue.map((property) => ({
      name: property.name,
      scopes: property.scopes,
      unit: property.unit,
      support: this.validation.automationSupport(
        {
          evaluationMode: 'DETERMINISTIC',
          scope: { kind: property.scopes[0] ?? 'DOCUMENT', property: property.name },
        } as unknown as RuleDefinition,
        catalogue.map((entry) => ({
          name: entry.name,
          scopes: entry.scopes,
          exactness: entry.exactness,
        })),
      ),
    }));
    const existingRules = bindings.existingRules.map((rule) => ({
      ruleCode: rule.ruleCode,
      scopeKey: rule.scopeKey,
      summary: rule.titleEn,
    }));

    // Pass B in batches. One call asked for every proposal at once, which made
    // the answer — and the structure the provider had to generate — as large as
    // the whole corpus. Each call now sees a few evidence items and may return
    // at most AI_MAX_RULES_PER_REQUEST proposals; room is left for one passage
    // stating several requirements. Evidence keeps its stored order, so the
    // batches, and therefore the merged result, are deterministic.
    const proposalsPerCall = this.config.ai.maxRulesPerRequest;
    const itemsPerCall = Math.max(1, Math.ceil(proposalsPerCall / 2));
    const items: Array<
      | { kind: 'evidence'; entry: EvidenceForPrompt }
      | { kind: 'observation'; entry: ObservationForPrompt }
    > = [
      ...forPrompt.map((entry) => ({ kind: 'evidence' as const, entry })),
      ...observationsForPrompt.map((entry) => ({ kind: 'observation' as const, entry })),
    ];
    const batches: Array<typeof items> = [];
    for (let index = 0; index < items.length; index += itemsPerCall) {
      batches.push(items.slice(index, index + itemsPerCall));
    }
    // No evidence at all is still one call: "nothing to propose" is the
    // provider's answer to give, and the run records that it was asked.
    if (batches.length === 0) batches.push([]);

    const merged: PalCertRuleProposalOutput['proposals'][number][] = [];
    for (const [batchIndex, batch] of batches.entries()) {
      const remaining = this.config.extraction.maxProposals - merged.length;
      if (remaining <= 0) break;
      const maxProposals = Math.min(proposalsPerCall, remaining);

      const batchEvidence = batch.flatMap((item) => (item.kind === 'evidence' ? [item.entry] : []));
      const batchObservations = batch.flatMap((item) =>
        item.kind === 'observation' ? [item.entry] : [],
      );
      const userPrompt = buildRuleStructuringPrompt({
        vocabulary,
        properties,
        evidence: batchEvidence,
        observations: batchObservations,
        existingRules,
        maxProposals,
      });

      // Bounded before the call, not after: an oversized request is refused
      // with an actionable error rather than truncated silently (§89).
      if (userPrompt.length > this.config.extraction.maxContextChars) {
        throw new ExtractionFailure(
          ExtractionFailureKind.SOURCE_TOO_LARGE,
          'the discovered evidence exceeds the configured context budget',
        );
      }

      const invocation = await this.beginInvocation(
        scope,
        runId,
        ExtractionInvocationPurpose.GUIDELINE_RULE_STRUCTURING,
        null,
        template,
      );
      const response = await this.provider
        .extractRuleProposals({
          extractionRunId: runId,
          systemPrompt: template.system,
          userPrompt,
          suppliedEvidenceIds: [
            ...batchEvidence.map((entry) => entry.evidenceId),
            ...batchObservations.map((entry) => entry.evidenceId),
          ],
          maxProposals,
        })
        .catch(async (error: unknown) => {
          await this.settleInvocation(scope, invocation, null, classify(error));
          throw error;
        });
      await this.settleInvocation(scope, invocation, response.usage, null);

      // Validated again here, whatever the provider's structured-output mode
      // claims: an institution's candidate rules are the wrong place to
      // discover a constraint was not honoured (§84).
      const contract = validateExtractionContract(
        ExtractionContract.PROPOSAL_OUTPUT,
        response.output,
      );
      if (!contract.valid || response.output.proposals.length > maxProposals) {
        throw new AIProviderError(
          AIFailureKind.OUTPUT_INVALID,
          'the provider response failed PalCert validation',
        );
      }
      merged.push(
        ...(batches.length === 1
          ? response.output.proposals
          : namespacedProposals(response.output.proposals, batchIndex + 1)),
      );
    }

    const output = { proposals: merged } as PalCertRuleProposalOutput;
    // The merged whole is canonical too, not only its parts.
    if (!validateExtractionContract(ExtractionContract.PROPOSAL_OUTPUT, output).valid) {
      throw new AIProviderError(
        AIFailureKind.OUTPUT_INVALID,
        'the provider response failed PalCert validation',
      );
    }
    return output;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private async persistEvidence(
    scope: Scope,
    runId: string,
    evidence: readonly StoredEvidence[],
    observations: readonly StoredObservation[],
  ): Promise<PersistedEvidence> {
    // Bulk, not one upsert per row: a template alone can yield hundreds of
    // observations, and a round trip each under RLS outran Prisma's 5 s
    // interactive-transaction timeout on a real thesis template (P2028).
    //
    // Idempotence is unchanged. `skipDuplicates` is ON CONFLICT DO NOTHING on
    // the same run/hash unique indexes the upserts used, so a retried
    // delivery adds nothing, and the rows are then read back by those keys.
    // Only database work happens in here: the provider and the Document
    // Engine were called before this transaction began.
    return this.tenant.withTenant(
      scope,
      async (tx) => {
        for (const chunk of chunked(evidence, BULK_ROWS)) {
          await tx.sourceEvidence.createMany({
            data: chunk.map(({ item, index }) => ({
              organizationId: scope.organizationId,
              extractionRunId: runId,
              sourceAssetId: item.sourceAssetId,
              evidenceKind: item.evidenceKind,
              locatorType: item.locatorType,
              startPage: item.startPage,
              endPage: item.endPage,
              nodeIds: [...item.nodeIds],
              startCharIndex: item.startCharIndex,
              endCharIndex: item.endCharIndex,
              excerpt: item.excerpt,
              excerptHash: item.excerptHash,
              ordinal: index,
            })),
            skipDuplicates: true,
          });
        }
        for (const chunk of chunked(observations, BULK_ROWS)) {
          await tx.templateObservation.createMany({
            data: chunk.map(({ item, index }) => ({
              organizationId: scope.organizationId,
              extractionRunId: runId,
              sourceAssetId: item.sourceAssetId,
              scopeKey: item.scopeKey,
              scope: item.scope as object,
              property: item.property,
              unit: item.unit,
              modalValue: item.modalValue,
              occurrenceCount: item.occurrenceCount,
              matchingCount: item.matchingCount,
              distinctValueCount: item.distinctValueCount,
              uniformity: item.uniformity,
              distribution: item.distribution as unknown as object,
              observationHash: item.observationHash,
              ordinal: index,
            })),
            skipDuplicates: true,
          });
        }

        const evidenceRows = new Map(
          (
            await tx.sourceEvidence.findMany({
              where: {
                extractionRunId: runId,
                excerptHash: { in: [...new Set(evidence.map((item) => item.excerptHash))] },
              },
            })
          ).map((row) => [row.excerptHash, row]),
        );
        const observationRows = new Map(
          (
            await tx.templateObservation.findMany({
              where: {
                extractionRunId: runId,
                observationHash: {
                  in: [...new Set(observations.map((item) => item.observationHash))],
                },
              },
            })
          ).map((row) => [row.observationHash, row]),
        );

        // One entry per input, in input order, exactly as before: a repeated
        // excerpt maps to the one row that holds it.
        const storedEvidence: PersistedEvidence['evidence'] = evidence.map((item) => {
          const row = evidenceRows.get(item.excerptHash)!;
          return {
            id: row.id,
            sourceAssetId: row.sourceAssetId,
            evidenceKind: row.evidenceKind as EvidenceKind,
            locatorType: row.locatorType as EvidenceLocatorType,
            locatorLabel: item.locatorLabel,
            excerpt: row.excerpt,
            excerptHash: row.excerptHash,
          };
        });
        const storedObservations: PersistedEvidence['observations'] = observations.map((item) => {
          const row = observationRows.get(item.observationHash)!;
          return {
            id: row.id,
            sourceAssetId: row.sourceAssetId,
            scopeKey: row.scopeKey,
            property: row.property,
            unit: row.unit,
            modalValue: row.modalValue,
            occurrenceCount: row.occurrenceCount,
            matchingCount: row.matchingCount,
            distinctValueCount: row.distinctValueCount,
            uniformity: row.uniformity as ObservationUniformity,
            observationHash: row.observationHash,
          };
        });

        return { evidence: storedEvidence, observations: storedObservations };
      },
      BACKGROUND_BATCH_TRANSACTION,
    );
  }

  private async persistProposals(
    scope: Scope,
    runId: string,
    bindings: Bindings,
    evidence: PersistedEvidence,
    output: PalCertRuleProposalOutput,
    sourcesProcessed: number,
  ): Promise<void> {
    const catalogue = (await this.engine.describeDocxProperties()).map((entry) => ({
      name: entry.name,
      scopes: entry.scopes,
      exactness: entry.exactness,
    }));
    const suppliedEvidence = new Map(evidence.evidence.map((row) => [row.id, row]));
    const suppliedObservations = new Map(evidence.observations.map((row) => [row.id, row]));

    // Every proposal is validated, classified and conflict-checked by PalCert
    // before anything is written. A model's own view of its output decides
    // nothing (§52, §55, §58).
    const prepared = output.proposals
      .slice(0, this.config.extraction.maxProposals)
      .map((proposal) =>
        this.prepare(proposal, bindings, suppliedEvidence, suppliedObservations, catalogue),
      );

    // Two proposals measuring the same thing differently are a disagreement
    // between sources, and PalCert reports both rather than choosing (§62).
    const crossSource = this.validation.findCrossSourceConflicts(
      prepared.map((entry) => ({
        key: entry.proposalKey,
        definition: entry.definition,
        sourceAssetIds: entry.sourceAssetIds,
      })),
    );

    const now = this.clock.now();
    // The rows, fully built before the transaction opens: inside it there is
    // only database work, and only a handful of statements however many
    // proposals there are.
    const proposalRows = prepared.map((entry, displayOrder) => {
      const related = crossSource.get(entry.proposalKey) ?? [];
      const conflict =
        related.length > 0
          ? {
              status: ProposalConflictStatus.CROSS_SOURCE,
              existingRuleId: null,
              existingRuleCode: null,
              detail: 'Another source in this run states something incompatible.',
            }
          : entry.conflict;
      const kind = related.length > 0 ? RuleProposalKind.CONFLICTING_REQUIREMENT : entry.kind;
      return {
        organizationId: scope.organizationId,
        extractionRunId: runId,
        proposalKey: entry.proposalKey,
        kind,
        validationStatus: entry.validation,
        validationIssues: entry.issues as unknown as object[],
        automationSupport: entry.automationSupport,
        conflictStatus: conflict.status,
        conflictExistingRuleId: conflict.existingRuleId,
        conflictExistingRuleCode: conflict.existingRuleCode,
        conflictDetail: conflict.detail,
        relatedProposalKeys: [...related],
        // The rule exactly as the model proposed it, whether or not PalCert's
        // validator accepted it. An invalid proposal is kept *with* its issues
        // so the reviewer can see what was suggested and fix it — discarding it
        // would hide a requirement the source really does state (§59, §68). A
        // conflicting or unrepresentable proposal carries no rule at all, and
        // the database CHECK refuses one (§44).
        suggestedRule:
          proposalRequiresRuleDefinition(kind) && entry.suggested !== null
            ? (entry.suggested as object)
            : Prisma.DbNull,
        suggestedRuleCode:
          proposalRequiresRuleDefinition(kind) && entry.suggested !== null
            ? entry.suggestedRuleCode
            : null,
        interpretationEn: entry.interpretationEn,
        interpretationAr: entry.interpretationAr,
        ambiguityNote: entry.ambiguityNote,
        requiresClarification: entry.requiresClarification,
        displayOrder,
      };
    });

    // One atomic step: every proposal, every evidence link and the COMPLETED
    // run, or none of them. A retry after a rollback therefore starts clean,
    // and a retry after a commit finds the run COMPLETED and stops. The
    // bound is explicit and generous for the few bulk statements it holds;
    // web requests keep the short default.
    // Set inside the transaction; read after it commits.
    const captured: { purchase: { id: string; payer: string } | null } = { purchase: null };
    await this.tenant.withTenant(
      scope,
      async (tx) => {
        for (const chunk of chunked(proposalRows, BULK_ROWS)) {
          await tx.ruleProposal.createMany({
            data: chunk.map(({ item }) => item),
            skipDuplicates: true,
          });
        }
        const ids = new Map(
          (
            await tx.ruleProposal.findMany({
              where: {
                extractionRunId: runId,
                proposalKey: { in: prepared.map((entry) => entry.proposalKey) },
              },
              select: { id: true, proposalKey: true },
            })
          ).map((row) => [row.proposalKey, row.id]),
        );

        const evidenceLinks = prepared.flatMap((entry) =>
          [...new Set(entry.evidenceIds)].map((sourceEvidenceId) => ({
            organizationId: scope.organizationId,
            proposalId: ids.get(entry.proposalKey)!,
            sourceEvidenceId,
          })),
        );
        const observationLinks = prepared.flatMap((entry) =>
          [...new Set(entry.observationIds)].map((templateObservationId) => ({
            organizationId: scope.organizationId,
            proposalId: ids.get(entry.proposalKey)!,
            templateObservationId,
          })),
        );
        for (const chunk of chunked(evidenceLinks, BULK_ROWS)) {
          await tx.ruleProposalEvidence.createMany({
            data: chunk.map(({ item }) => item),
            skipDuplicates: true,
          });
        }
        for (const chunk of chunked(observationLinks, BULK_ROWS)) {
          await tx.ruleProposalEvidence.createMany({
            data: chunk.map(({ item }) => item),
            skipDuplicates: true,
          });
        }

        const counts = countKinds(prepared, crossSource);
        const digest = computeExtractionRunHash({
          extractionCanonicalizationVersion: EXTRACTION_CANONICALIZATION_VERSION,
          proposalSchemaVersion: bindings.proposalSchemaVersion,
          standardVersionId: bindings.standardVersionId,
          sourceSetHash: bindings.sourceSetHash,
          provider: bindings.provider,
          configuredModel: bindings.configuredModel,
          promptVersion: bindings.promptVersion,
          promptHash: bindings.promptHash,
          contextBuilderVersion: bindings.contextBuilderVersion,
          evidence: evidence.evidence.map((row) => ({
            excerptHash: row.excerptHash,
            evidenceKind: row.evidenceKind,
            locatorType: row.locatorType,
          })),
          observations: evidence.observations.map((row) => ({
            observationHash: row.observationHash,
          })),
          proposals: prepared.map((entry) => ({
            proposalKey: entry.proposalKey,
            kind: entry.kind,
            suggestedRuleCode: entry.definition?.ruleCode ?? null,
            validationStatus: entry.validation,
            evidenceHashes: entry.evidenceIds
              .map((id) => suppliedEvidence.get(id)?.excerptHash ?? '')
              .filter((hash) => hash !== ''),
          })),
        });

        const usage = await tx.extractionInvocation.aggregate({
          where: { extractionRunId: runId },
          _sum: { inputTokens: true, outputTokens: true },
          _count: true,
        });

        await tx.ruleExtractionRun.update({
          where: { id: runId },
          data: {
            status: RuleExtractionStatus.COMPLETED,
            completedAt: now,
            extractionRunHash: digest.hash,
            sourcesProcessed,
            evidenceCount: evidence.evidence.length,
            observationCount: evidence.observations.length,
            explicitRequirementCount: counts.explicit,
            templateInferenceCount: counts.template,
            ambiguousRequirementCount: counts.ambiguous,
            conflictingRequirementCount: counts.conflicting,
            unrepresentableRequirementCount: counts.unrepresentable,
            invalidProposalCount: counts.invalid,
            inputTokens: usage._sum.inputTokens ?? 0,
            outputTokens: usage._sum.outputTokens ?? 0,
            invocationCount: usage._count,
          },
        });

        // ADR-0149: COMPLETED is delivery, so it is charged — in this same
        // transaction, exactly once, from the member who started the run. How
        // many proposals are later accepted does not enter into it. A lapsed
        // reservation throws and the completion rolls back with it.
        const bound = await tx.ruleExtractionRun.findUnique({
          where: { id: runId },
          select: { servicePurchaseId: true, createdByUserId: true },
        });
        if (bound !== null && bound.servicePurchaseId !== null) {
          const { charged } = await this.billing.capture(tx, bound.servicePurchaseId);
          if (charged) {
            captured.purchase = {
              id: bound.servicePurchaseId,
              payer: bound.createdByUserId ?? scope.userId,
            };
          }
        }
      },
      BACKGROUND_BATCH_TRANSACTION,
    );
    if (captured.purchase !== null) {
      await this.billing.audit({
        action: 'AI_SERVICE_CAPTURED',
        operation: AIOperation.AI_RULE_EXTRACTION,
        purchaseId: captured.purchase.id,
        resourceId: runId,
        payerUserId: captured.purchase.payer,
        actorUserId: null,
        organizationId: scope.organizationId,
      });
    }

    await this.events.audit({
      action: 'RULE_EXTRACTION_COMPLETED',
      actorUserId: null,
      targetType: 'RuleExtractionRun',
      targetId: runId,
      // Counts only. Never a guideline excerpt, a filename or a rule title (§118).
      afterState: {
        sourcesProcessed,
        evidenceCount: evidence.evidence.length,
        proposalCount: prepared.length,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private prepare(
    proposal: ProposedRule,
    bindings: Bindings,
    evidence: ReadonlyMap<string, PersistedEvidence['evidence'][number]>,
    observations: ReadonlyMap<string, PersistedEvidence['observations'][number]>,
    catalogue: readonly {
      name: string;
      scopes: readonly string[];
      exactness: 'EXACT' | 'DERIVED';
    }[],
  ): PreparedProposal {
    // Only ids PalCert supplied. An id the model invented is a fabricated
    // citation and is dropped rather than stored as provenance (§55, §56).
    const evidenceIds = proposal.evidenceIds.filter((id) => evidence.has(id));
    const observationIds = proposal.evidenceIds.filter((id) => observations.has(id));

    let kind = proposal.kind as RuleProposalKind;
    // A proposal resting only on a template observation is a template
    // inference whatever the model called it: provenance is PalCert's fact,
    // and the distinction between "observed" and "required" is the whole
    // point of the phase (§4, §46).
    if (
      kind === RuleProposalKind.EXPLICIT_REQUIREMENT &&
      evidenceIds.length === 0 &&
      observationIds.length > 0
    ) {
      kind = RuleProposalKind.TEMPLATE_INFERENCE;
    }
    // An explicit requirement with no grounded evidence at all is not an
    // explicit requirement (§160).
    if (
      kind === RuleProposalKind.EXPLICIT_REQUIREMENT &&
      evidenceIds.length === 0 &&
      observationIds.length === 0
    ) {
      kind = RuleProposalKind.UNREPRESENTABLE_REQUIREMENT;
    }

    const validated = this.validation.validate(
      kind,
      proposal.suggestedRule ?? null,
      bindings.ruleSchemaVersion,
    );

    const conflict = this.validation.conflictWithExisting(
      validated.definition,
      bindings.existingRules,
    );

    const sourceAssetIds = [
      ...new Set([
        ...evidenceIds.map((id) => evidence.get(id)?.sourceAssetId ?? ''),
        ...observationIds.map((id) => observations.get(id)?.sourceAssetId ?? ''),
      ]),
    ].filter((id) => id !== '');

    const suggested = (proposal.suggestedRule ?? null) as Record<string, unknown> | null;
    const suggestedRuleCode =
      typeof suggested?.['ruleCode'] === 'string' ? (suggested['ruleCode'] as string) : null;

    // A kind that requires a rule but carries none is not that kind. Recording
    // it as one would leave a row the database would refuse and a reviewer
    // could not act on.
    if (proposalRequiresRuleDefinition(kind) && suggested === null) {
      kind = RuleProposalKind.UNREPRESENTABLE_REQUIREMENT;
    }

    return {
      proposalKey: proposal.proposalKey,
      kind,
      suggested,
      suggestedRuleCode,
      definition: validated.definition,
      validation: validated.status,
      issues: validated.issues,
      automationSupport: this.validation.automationSupport(validated.definition, catalogue),
      conflict,
      evidenceIds,
      observationIds,
      sourceAssetIds,
      interpretationEn: proposal.interpretationEn,
      interpretationAr: proposal.interpretationAr,
      ambiguityNote: proposal.ambiguityNote ?? null,
      requiresClarification: proposal.requiresClarification,
    };
  }

  private normalize(
    citation: DiscoveredCitation,
    source: BoundSource,
    nodeIds: readonly string[],
  ): StoredEvidence | null {
    const excerpt = citation.citedText.slice(0, this.config.extraction.maxEvidenceChars);
    if (excerpt.trim().length === 0) return null;

    if (citation.kind === 'PDF_PAGE') {
      return {
        sourceAssetId: source.sourceAssetId,
        evidenceKind: EvidenceKind.EXPLICIT_TEXT,
        locatorType: EvidenceLocatorType.PDF_PAGE,
        locatorLabel: `page ${citation.startPage}${citation.endPage > citation.startPage ? `–${citation.endPage}` : ''}`,
        startPage: citation.startPage,
        endPage: citation.endPage,
        nodeIds: [],
        startCharIndex: null,
        endCharIndex: null,
        excerpt,
        excerptHash: computeExcerptHash({
          sourceAssetId: source.sourceAssetId,
          sourceSha256: source.sha256,
          locatorType: EvidenceLocatorType.PDF_PAGE,
          locator: { startPage: citation.startPage, endPage: citation.endPage },
          excerpt,
        }),
      };
    }

    if (citation.kind === 'DOCX_BLOCK') {
      // The block index space is the one PalCert built, so it maps back to
      // exact node ids deterministically. An index outside it locates nothing
      // and is dropped (§29).
      const cited = nodeIds.slice(citation.startBlockIndex, citation.endBlockIndex);
      if (cited.length === 0) return null;
      return {
        sourceAssetId: source.sourceAssetId,
        evidenceKind: EvidenceKind.EXPLICIT_TEXT,
        locatorType: EvidenceLocatorType.DOCX_NODE,
        locatorLabel:
          cited.length === 1 ? (cited[0] ?? '') : `${cited[0]}…${cited[cited.length - 1]}`,
        startPage: null,
        endPage: null,
        nodeIds: cited,
        startCharIndex: null,
        endCharIndex: null,
        excerpt,
        excerptHash: computeExcerptHash({
          sourceAssetId: source.sourceAssetId,
          sourceSha256: source.sha256,
          locatorType: EvidenceLocatorType.DOCX_NODE,
          locator: { nodeIds: cited },
          excerpt,
        }),
      };
    }

    return {
      sourceAssetId: source.sourceAssetId,
      evidenceKind: EvidenceKind.EXPLICIT_TEXT,
      locatorType: EvidenceLocatorType.TEXT_CHAR,
      locatorLabel: `characters ${citation.startCharIndex}–${citation.endCharIndex}`,
      startPage: null,
      endPage: null,
      nodeIds: [],
      startCharIndex: citation.startCharIndex,
      endCharIndex: citation.endCharIndex,
      excerpt,
      excerptHash: computeExcerptHash({
        sourceAssetId: source.sourceAssetId,
        sourceSha256: source.sha256,
        locatorType: EvidenceLocatorType.TEXT_CHAR,
        locator: { start: citation.startCharIndex, end: citation.endCharIndex },
        excerpt,
      }),
    };
  }

  /** The source's bytes, bounded and verified against the digest bound at creation. */
  private async loadDocument(
    source: BoundSource,
  ): Promise<{ block: ExtractionDocument; nodeIds: readonly string[]; truncated: boolean }> {
    const stream = await this.storage.getObjectBytes({
      zone: 'clean',
      key: source.cleanObjectKey,
      versionId: source.cleanObjectVersionId,
    });

    if (source.sourceKind === StandardSourceKind.GUIDELINE_PDF) {
      if (stream.length > this.config.extraction.maxPdfBytes) {
        // Refused with an actionable error, never truncated: half a guideline
        // read as if it were the whole one is worse than not reading it (§89).
        throw new ExtractionFailure(
          ExtractionFailureKind.SOURCE_TOO_LARGE,
          `the PDF is larger than the configured extraction limit of ${this.config.extraction.maxPdfBytes} bytes`,
        );
      }
      return {
        block: {
          kind: 'PDF',
          sourceAssetId: source.sourceAssetId,
          title: source.label,
          bytes: stream,
        },
        nodeIds: [],
        truncated: false,
      };
    }

    // A guideline DOCX is never sent as bytes: there is no DOCX document block,
    // and sending OOXML would be sending a ZIP to a text model (§27, §28).
    const analysis = await this.engine.analyzeDocument({
      documentId: source.sourceAssetId,
      content: stream,
      expectedSha256: source.sha256,
      // Rule extraction reads institutional guidelines, which are DOCX.
      format: DocumentFormat.DOCX,
    });
    const artifact = JSON.parse(analysis.artifact.toString('utf8')) as {
      structuralModel?: {
        paragraphs?: { locator?: { nodeId?: string }; text?: string }[];
        equations?: ExtractionEquation[];
      };
    };
    const paragraphs = artifact.structuralModel?.paragraphs ?? [];
    const equationsByParagraph = new Map<string, ExtractionEquation[]>();
    for (const equation of artifact.structuralModel?.equations ?? []) {
      if (equation.paragraphNodeId === undefined) continue;
      const list = equationsByParagraph.get(equation.paragraphNodeId) ?? [];
      list.push(equation);
      equationsByParagraph.set(equation.paragraphNodeId, list);
    }

    const blocks: string[] = [];
    const nodeIds: string[] = [];
    let characters = 0;
    let truncated = false;
    for (const paragraph of paragraphs) {
      const nodeId = paragraph.locator?.nodeId;
      // An equation is never dropped just because its paragraph has no words:
      // the model is told one is there, and whether its maths could be read.
      const markers = (nodeId === undefined ? [] : (equationsByParagraph.get(nodeId) ?? [])).map(
        equationMarker,
      );
      const text = [(paragraph.text ?? '').trim(), ...markers]
        .filter((part) => part !== '')
        .join(' ');
      if (text === '' || nodeId === undefined) continue;
      if (
        blocks.length >= this.config.extraction.maxDocxBlocks ||
        characters + text.length > this.config.extraction.maxDocxTextChars
      ) {
        truncated = true;
        break;
      }
      blocks.push(text);
      nodeIds.push(nodeId);
      characters += text.length;
    }

    return {
      block: {
        kind: 'BLOCKS',
        sourceAssetId: source.sourceAssetId,
        title: source.label,
        blocks,
        nodeIds,
      },
      nodeIds,
      truncated,
    };
  }

  /** A template's fact set, produced by PalCert's own analyzer. */
  private async analyzeTemplate(source: BoundSource): Promise<DocumentFactSet | null> {
    const bytes = await this.storage.getObjectBytes({
      zone: 'clean',
      key: source.cleanObjectKey,
      versionId: source.cleanObjectVersionId,
    });
    const analysis = await this.engine.analyzeDocument({
      documentId: source.sourceAssetId,
      content: bytes,
      expectedSha256: source.sha256,
      format: DocumentFormat.DOCX,
    });
    const artifact = JSON.parse(analysis.artifact.toString('utf8')) as {
      factSet?: DocumentFactSet;
    };
    return artifact.factSet ?? null;
  }

  private async loadBindings(scope: Scope, runId: string): Promise<Bindings> {
    return this.tenant.withTenant(scope, async (tx) => {
      const run = await tx.ruleExtractionRun.findUniqueOrThrow({ where: { id: runId } });
      const bound = await tx.ruleExtractionRunSource.findMany({
        where: { extractionRunId: runId },
        orderBy: { ordinal: 'asc' },
      });
      const assets = await tx.standardSourceAsset.findMany({
        where: { id: { in: bound.map((entry) => entry.sourceAssetId) } },
      });
      const byId = new Map(assets.map((asset) => [asset.id, asset]));

      const sources: BoundSource[] = [];
      for (const entry of bound) {
        const asset = byId.get(entry.sourceAssetId);
        // Re-verified before the bytes are read: a source whose digest moved is
        // not the source this run was created against (§120).
        if (
          asset === undefined ||
          asset.status !== 'READY' ||
          asset.sha256 !== entry.sourceSha256 ||
          asset.cleanObjectKey === null
        ) {
          throw new ExtractionFailure(
            ExtractionFailureKind.SOURCE_INTEGRITY_FAILED,
            'a bound source is no longer the document this run was created against',
          );
        }
        sources.push({
          sourceAssetId: asset.id,
          sourceKind: asset.sourceKind as StandardSourceKind,
          sha256: asset.sha256,
          cleanObjectKey: asset.cleanObjectKey,
          cleanObjectVersionId: asset.cleanObjectVersionId,
          label: asset.originalFilename,
        });
      }

      const existing = await tx.standardRule.findMany({
        where: { standardVersionId: run.standardVersionId },
        select: {
          id: true,
          ruleCode: true,
          scope: true,
          operator: true,
          expectedValue: true,
          titleEn: true,
        },
      });

      return {
        standardVersionId: run.standardVersionId,
        ruleSchemaVersion: run.ruleSchemaVersion,
        proposalSchemaVersion: run.proposalSchemaVersion,
        sourceSetHash: run.sourceSetHash,
        provider: run.provider,
        configuredModel: run.configuredModel,
        promptVersion: run.promptVersion,
        promptHash: run.promptHash,
        contextBuilderVersion: run.contextBuilderVersion,
        sources,
        labels: new Map(sources.map((source) => [source.sourceAssetId, source.label])),
        kinds: new Map(sources.map((source) => [source.sourceAssetId, source.sourceKind])),
        existingRules: existing.map((rule) => ({
          id: rule.id,
          ruleCode: rule.ruleCode,
          scopeKey: scopeKeyOf(rule.scope as unknown as RuleDefinition['scope']),
          operator: rule.operator,
          expectedValue: rule.expectedValue,
          titleEn: rule.titleEn,
        })),
      };
    });
  }

  private async beginInvocation(
    scope: Scope,
    runId: string,
    purpose: ExtractionInvocationPurpose,
    sourceAssetId: string | null,
    template: { version: string; hash: string },
  ): Promise<string> {
    const capabilities = this.provider.getCapabilities();
    // Opened *before* the call: a crash between the request and the write
    // leaves a record rather than a silence, which is the honest shape when
    // exactly-once is not on offer (§79).
    const row = await this.tenant.withTenant(scope, async (tx) => {
      const attempt = await tx.extractionInvocation.count({
        where: { extractionRunId: runId, purpose, sourceAssetId },
      });
      return tx.extractionInvocation.create({
        data: {
          organizationId: scope.organizationId,
          extractionRunId: runId,
          provider: capabilities.provider,
          purpose,
          sourceAssetId,
          configuredModel: capabilities.configuredModel,
          promptVersion: template.version,
          promptHash: template.hash,
          contextBuilderVersion: 'extraction-1',
          status: 'PENDING',
          attempt,
          startedAt: this.clock.now(),
        },
      });
    });
    return row.id;
  }

  private async settleInvocation(
    scope: Scope,
    invocationId: string,
    usage: {
      providerRequestId: string | null;
      providerReturnedModel: string | null;
      inputTokens: number;
      outputTokens: number;
      latencyMs: number;
    } | null,
    failureKind: string | null,
  ): Promise<void> {
    await this.tenant.withTenant(scope, (tx) =>
      tx.extractionInvocation.update({
        where: { id: invocationId },
        data: {
          status: failureKind === null ? 'SUCCEEDED' : 'FAILED',
          completedAt: this.clock.now(),
          failureKind,
          ...(usage === null
            ? {}
            : {
                providerRequestId: usage.providerRequestId,
                providerReturnedModel: usage.providerReturnedModel,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                latencyMs: usage.latencyMs,
              }),
        },
      }),
    );
  }

  private async transition(
    scope: Scope,
    runId: string,
    status: RuleExtractionStatus,
    extra: Record<string, Date>,
  ): Promise<void> {
    await this.tenant.withTenant(scope, (tx) =>
      tx.ruleExtractionRun.updateMany({
        where: {
          id: runId,
          status: {
            notIn: [
              RuleExtractionStatus.COMPLETED,
              RuleExtractionStatus.FAILED,
              RuleExtractionStatus.CANCELLED,
            ],
          },
        },
        data: { status, ...extra },
      }),
    );
  }

  /**
   * Whether the run's fee is still reserved, marking the purchase processing
   * if so. Runs created before AI billing have no purchase: history, never
   * billed, run as they always did.
   */
  private async reservationLive(
    scope: Scope,
    run: { servicePurchaseId: string | null },
  ): Promise<boolean> {
    if (run.servicePurchaseId === null) return true;
    const purchaseId = run.servicePurchaseId;
    try {
      await this.tenant.withTenant(scope, async (tx) => {
        await this.billing.assertReservationLive(tx, purchaseId);
        await this.billing.markProcessing(tx, purchaseId);
      });
      return true;
    } catch (error) {
      if (
        error instanceof AppError &&
        error.code === PalCertErrorCode.SERVICE_RESERVATION_EXPIRED
      ) {
        return false;
      }
      throw error;
    }
  }

  /** Release a settled run's reservation if it is somehow still held. Idempotent. */
  private async releaseFor(
    scope: Scope,
    run: { id: string; servicePurchaseId: string | null; createdByUserId: string | null },
    failureCode: PurchaseFailureCode,
    reason: string,
  ): Promise<void> {
    if (run.servicePurchaseId === null) return;
    const purchaseId = run.servicePurchaseId;
    const payer = run.createdByUserId ?? scope.userId;
    const { released } = await this.tenant.withUser(payer, (tx) =>
      this.billing.release(tx, purchaseId, failureCode),
    );
    if (!released) return;
    await this.billing.audit({
      action: 'AI_SERVICE_RELEASED',
      operation: AIOperation.AI_RULE_EXTRACTION,
      purchaseId,
      resourceId: run.id,
      payerUserId: payer,
      actorUserId: null,
      organizationId: scope.organizationId,
      failureCode: reason,
    });
  }

  private async recordTransient(scope: Scope, runId: string, kind: string): Promise<void> {
    await this.tenant.withTenant(scope, (tx) =>
      tx.ruleExtractionRun.updateMany({
        where: { id: runId },
        // The kind only; the message may carry provider detail (§150).
        data: { failureDetail: `transient: ${kind}` },
      }),
    );
  }

  private async fail(scope: Scope, runId: string, kind: string, error: unknown): Promise<void> {
    const now = this.clock.now();
    // ADR-0149: FAILED is never charged. The reservation goes back in the same
    // transaction that records the failure — provider error, timeout, invalid
    // output, no evidence, partial source failure, budget, internal failure,
    // exhausted retries or a lapsed reservation alike.
    const released = await this.tenant.withTenant(scope, async (tx) => {
      const updated = await tx.ruleExtractionRun.updateMany({
        where: {
          id: runId,
          status: {
            notIn: [
              RuleExtractionStatus.COMPLETED,
              RuleExtractionStatus.FAILED,
              RuleExtractionStatus.CANCELLED,
            ],
          },
        },
        data: {
          status: RuleExtractionStatus.FAILED,
          failedAt: now,
          failureKind: kind,
          failureDetail: safeDetail(error),
        },
      });
      if (updated.count !== 1) return null;
      const bound = await tx.ruleExtractionRun.findUnique({
        where: { id: runId },
        select: { servicePurchaseId: true, createdByUserId: true },
      });
      if (bound === null || bound.servicePurchaseId === null) return null;
      const failureCode =
        kind === AIFailureKind.RESERVATION_EXPIRED
          ? PurchaseFailureCode.RESERVATION_EXPIRED
          : PurchaseFailureCode.SERVICE_FAILED;
      const result = await this.billing.release(tx, bound.servicePurchaseId, failureCode);
      return result.released
        ? { id: bound.servicePurchaseId, payer: bound.createdByUserId ?? scope.userId }
        : null;
    });
    if (released !== null) {
      await this.billing.audit({
        action: 'AI_SERVICE_RELEASED',
        operation: AIOperation.AI_RULE_EXTRACTION,
        purchaseId: released.id,
        resourceId: runId,
        payerUserId: released.payer,
        actorUserId: null,
        organizationId: scope.organizationId,
        failureCode: kind,
      });
    }
    await this.events.audit({
      action: 'RULE_EXTRACTION_FAILED',
      actorUserId: null,
      targetType: 'RuleExtractionRun',
      targetId: runId,
      afterState: { failureKind: kind },
    });
    // The error itself goes to the operator log, where the logger's own
    // redaction applies. The stored `failureDetail` stays content-free,
    // because it is shown to an institution (§150).
    this.logger.warn(
      { err: error, runId, failureKind: kind },
      'Rule extraction failed; standard untouched',
    );
  }

  private scopeOf(job: ProcessingJob): Scope | null {
    if (job.organizationId === null) {
      this.logger.error(
        { jobId: job.id },
        'Extraction job carries no organization; refusing to guess a scope',
      );
      return null;
    }
    return { organizationId: job.organizationId, userId: requireJobOwner(job) };
  }
}

// ---------------------------------------------------------------------------
// Types and helpers
// ---------------------------------------------------------------------------

type Scope = { organizationId: string; userId: string };

interface BoundSource {
  readonly sourceAssetId: string;
  readonly sourceKind: StandardSourceKind;
  readonly sha256: string;
  readonly cleanObjectKey: string;
  readonly cleanObjectVersionId: string | null;
  readonly label: string;
}

interface Bindings {
  readonly standardVersionId: string;
  readonly ruleSchemaVersion: number;
  readonly proposalSchemaVersion: number;
  readonly sourceSetHash: string;
  readonly provider: string;
  readonly configuredModel: string;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly contextBuilderVersion: string;
  readonly sources: readonly BoundSource[];
  readonly labels: ReadonlyMap<string, string>;
  readonly kinds: ReadonlyMap<string, StandardSourceKind>;
  readonly existingRules: readonly {
    id: string;
    ruleCode: string;
    scopeKey: string;
    operator: string;
    expectedValue: unknown;
    titleEn: string;
  }[];
}

interface StoredEvidence {
  readonly sourceAssetId: string;
  readonly evidenceKind: EvidenceKind;
  readonly locatorType: EvidenceLocatorType;
  readonly locatorLabel: string;
  readonly startPage: number | null;
  readonly endPage: number | null;
  readonly nodeIds: readonly string[];
  readonly startCharIndex: number | null;
  readonly endCharIndex: number | null;
  readonly excerpt: string;
  readonly excerptHash: string;
}

interface StoredObservation {
  readonly sourceAssetId: string;
  readonly scopeKey: string;
  readonly scope: unknown;
  readonly property: string;
  readonly unit: string | null;
  readonly modalValue: string | null;
  readonly occurrenceCount: number;
  readonly matchingCount: number;
  readonly distinctValueCount: number;
  readonly uniformity: ObservationUniformity;
  readonly distribution: readonly { value: string; count: number }[];
  readonly observationHash: string;
}

interface PersistedEvidence {
  readonly evidence: {
    id: string;
    sourceAssetId: string;
    evidenceKind: EvidenceKind;
    locatorType: EvidenceLocatorType;
    locatorLabel: string;
    excerpt: string;
    excerptHash: string;
  }[];
  readonly observations: {
    id: string;
    sourceAssetId: string;
    scopeKey: string;
    property: string;
    unit: string | null;
    modalValue: string | null;
    occurrenceCount: number;
    matchingCount: number;
    distinctValueCount: number;
    uniformity: ObservationUniformity;
    observationHash: string;
  }[];
}

interface PreparedProposal {
  readonly proposalKey: string;
  readonly kind: RuleProposalKind;
  /** Exactly as the model proposed it, valid or not (§59). */
  readonly suggested: Record<string, unknown> | null;
  readonly suggestedRuleCode: string | null;
  /** The same rule once PalCert's own validator accepted it, else null. */
  readonly definition: RuleDefinition | null;
  readonly validation: ProposalValidationStatus;
  readonly issues: readonly { path: string; message: string }[];
  readonly automationSupport: AutomationSupport;
  readonly conflict: {
    status: ProposalConflictStatus;
    existingRuleId: string | null;
    existingRuleCode: string | null;
    detail: string | null;
  };
  readonly evidenceIds: readonly string[];
  readonly observationIds: readonly string[];
  readonly sourceAssetIds: readonly string[];
  readonly interpretationEn: string;
  readonly interpretationAr: string;
  readonly ambiguityNote: string | null;
  readonly requiresClarification: boolean;
}

/** PalCert's own failures, alongside the Phase 8 provider ones. */
class ExtractionFailure extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = 'ExtractionFailure';
  }
}

function classify(error: unknown): string {
  if (error instanceof AIProviderError) return error.kind;
  if (error instanceof ExtractionFailure) return error.kind;
  // ADR-0149: the reservation lapsed before the completion could be charged.
  if (error instanceof AppError && error.code === PalCertErrorCode.SERVICE_RESERVATION_EXPIRED) {
    return AIFailureKind.RESERVATION_EXPIRED;
  }
  // PalCert's own database, before anything provider-shaped is considered:
  // a transaction that expired is infrastructure, never the AI provider.
  const database = databaseFailureKind(error);
  if (database !== null) return database;
  if (error instanceof Error && /unreachable|timed out|ECONN/i.test(error.message)) {
    return AIFailureKind.NETWORK;
  }
  return AIFailureKind.UNKNOWN_PROVIDER_ERROR;
}

/** Operator-facing and content-free: never an excerpt, a prompt or a response (§150). */
function safeDetail(error: unknown): string {
  if (error instanceof ExtractionFailure) return error.message.slice(0, 300);
  if (error instanceof AIProviderError) return error.message.slice(0, 300);
  // Never a Prisma message: it names tables, columns and timings.
  const database = databaseFailureKind(error);
  if (database !== null) return detailFor(database);
  return 'the extraction could not be completed';
}

function detailFor(kind: string): string {
  switch (kind) {
    case ExtractionFailureKind.DATABASE_TRANSACTION_FAILED:
      return 'PalCert could not save the results in time';
    case ExtractionFailureKind.DATABASE_UNAVAILABLE:
      return 'PalCert storage was unavailable';
    default:
      return 'the extraction could not be completed';
  }
}

/** Rows per bulk statement: far below PostgreSQL's 65,535 bind parameters. */
const BULK_ROWS = 250;

/** `items` in consecutive chunks, each item with its position in the whole. */
export function chunked<T>(
  items: readonly T[],
  size: number,
): Array<Array<{ item: T; index: number }>> {
  const chunks: Array<Array<{ item: T; index: number }>> = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(
      items.slice(start, start + size).map((item, offset) => ({ item, index: start + offset })),
    );
  }
  return chunks;
}

/**
 * A failure of PalCert's own database, by Prisma error code, or null.
 *
 * - P2028: the interactive transaction expired or was closed (the 8443
 *   failure). P2034: a write conflict or deadlock; the transaction must be
 *   retried. Both leave nothing behind: the transaction rolled back.
 * - P1001/P1002/P1008/P1017 and an initialization error: the database could
 *   not be reached or dropped the connection.
 */
export function databaseFailureKind(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  const name = (error as { name?: unknown }).name;
  if (code === 'P2028' || code === 'P2034') {
    return ExtractionFailureKind.DATABASE_TRANSACTION_FAILED;
  }
  if (
    code === 'P1001' ||
    code === 'P1002' ||
    code === 'P1008' ||
    code === 'P1017' ||
    name === 'PrismaClientInitializationError'
  ) {
    return ExtractionFailureKind.DATABASE_UNAVAILABLE;
  }
  return null;
}

/**
 * Retried by the worker's own ladder. Safe because the run is idempotent:
 * evidence and observations are keyed by run and hash, and proposals are
 * written with the COMPLETED run in one transaction that either commits
 * whole or leaves nothing.
 */
export function isRetryableDatabaseFailure(kind: string): boolean {
  return (
    kind === ExtractionFailureKind.DATABASE_TRANSACTION_FAILED ||
    kind === ExtractionFailureKind.DATABASE_UNAVAILABLE
  );
}

function countKinds(
  prepared: readonly PreparedProposal[],
  crossSource: ReadonlyMap<string, readonly string[]>,
): {
  explicit: number;
  template: number;
  ambiguous: number;
  conflicting: number;
  unrepresentable: number;
  invalid: number;
} {
  const counts = {
    explicit: 0,
    template: 0,
    ambiguous: 0,
    conflicting: 0,
    unrepresentable: 0,
    invalid: 0,
  };
  for (const entry of prepared) {
    if (entry.validation === ProposalValidationStatus.INVALID) counts.invalid += 1;
    const kind =
      (crossSource.get(entry.proposalKey) ?? []).length > 0
        ? RuleProposalKind.CONFLICTING_REQUIREMENT
        : entry.kind;
    switch (kind) {
      case RuleProposalKind.EXPLICIT_REQUIREMENT:
        counts.explicit += 1;
        break;
      case RuleProposalKind.TEMPLATE_INFERENCE:
        counts.template += 1;
        break;
      case RuleProposalKind.AMBIGUOUS_REQUIREMENT:
        counts.ambiguous += 1;
        break;
      case RuleProposalKind.CONFLICTING_REQUIREMENT:
        counts.conflicting += 1;
        break;
      default:
        counts.unrepresentable += 1;
        break;
    }
  }
  return counts;
}

/** What the analyzer says about one equation (structuralModel.equations[]). */
interface ExtractionEquation {
  readonly sourceFormat?: string;
  readonly legacyClass?: string;
  readonly number?: string;
  readonly semanticsAvailable?: boolean;
  readonly paragraphNodeId?: string;
}

/**
 * The equation, as the model reads it among the guideline's text.
 *
 * Explicit rather than silent: a legacy MathType or Equation 3.0 object is
 * never parsed or executed, so its mathematics is unknown — but that an
 * equation is here, numbered so, is exactly what a numbering rule needs.
 */
export function equationMarker(equation: ExtractionEquation): string {
  const number = equation.number === undefined ? '' : ` (${equation.number})`;
  if (equation.sourceFormat === 'legacy-ole' || equation.semanticsAvailable === false) {
    return `[Equation${number}: legacy ${equation.legacyClass ?? 'equation'} object, processed in safe mode; mathematical content not available]`;
  }
  return `[Equation${number}: Office Math]`;
}

/**
 * Proposals from one Pass B batch, with keys that cannot collide with another
 * batch's.
 *
 * A key is only the model's handle for relating entries within one answer, so
 * each batch's keys are renamed `b<batch>-<n>` in answer order, and related
 * keys are renamed with them. A related key that names nothing in the same
 * answer relates to nothing and is dropped.
 */
export function namespacedProposals(
  proposals: PalCertRuleProposalOutput['proposals'],
  batch: number,
): PalCertRuleProposalOutput['proposals'] {
  const renamed = new Map(
    proposals.map((proposal, index) => [proposal.proposalKey, `b${batch}-${index + 1}`]),
  );
  return proposals.map((proposal) => {
    const { relatedProposalKeys, ...rest } = proposal;
    const related = (relatedProposalKeys ?? []).flatMap((key) => {
      const target = renamed.get(key);
      return target === undefined ? [] : [target];
    });
    return {
      ...rest,
      proposalKey: renamed.get(proposal.proposalKey)!,
      ...(related.length === 0 ? {} : { relatedProposalKeys: related }),
    } as PalCertRuleProposalOutput['proposals'][number];
  });
}
