import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  AIOperation,
  AppError,
  EXTRACTION_CONTEXT_BUILDER_VERSION,
  PROPOSAL_SCHEMA_VERSION,
  PalCertErrorCode,
  ProcessingJobType,
  PurchaseFailureCode,
  RuleExtractionStatus,
  StandardSourceStatus,
  computeSourceSetHash,
  isExtractionCancellable,
  type RuleExtractionRunView,
} from '@palcert/contracts';
import type { RuleExtractionRun } from '@palcert/database';
import { AIProviderPort } from '@palcert/contracts';
import { ApiConfigService } from '../../../config/api-config.service';
import { OutboxDispatcher } from '../../../infrastructure/queue/outbox-dispatcher';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import { PromptId, promptTemplate } from '../../../infrastructure/ai/prompt-registry';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { AIServiceBillingService } from '../../finance/services/ai-service-billing.service';
import type { TenantContext } from '../../organizations/tenant-context';
import { OrganizationAIConsentService } from './organization-ai-consent.service';
import {
  assertVersionVisible,
  scopeOf,
  type SourceRequestContext,
} from './standard-source.service';

export interface CreateExtractionInput {
  /** Which sources to read. Empty means every READY source on the draft. */
  readonly sourceAssetIds?: readonly string[] | undefined;
  /**
   * ADR-0149: the AI_RULE_EXTRACTION quote that pays for the run. It belongs to
   * the caller, and the caller — not the organization — is charged.
   */
  readonly priceQuoteId: string;
  readonly idempotencyKey?: string | undefined;
}

/**
 * Starting and cancelling a rule extraction (§36, §37, §71, §73).
 *
 * Everything this service refuses matters more than what it does:
 *
 * - Without organization consent, nothing is sent (§17).
 * - Against a non-draft version, nothing runs — and the database trigger
 *   refuses the insert even if this check were wrong (§72).
 * - Against "the latest sources", nothing runs: the exact source ids and their
 *   digests are bound into the run at creation, so re-running later cannot
 *   quietly mean reading different documents (§36).
 *
 * And what it never does: publish. There is no code path from a completed
 * extraction to a published standard version, and an e2e test asserts it (§73).
 */
@Injectable()
export class RuleExtractionService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly consent: OrganizationAIConsentService,
    private readonly jobs: ProcessingJobService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly events: SecurityEventService,
    private readonly config: ApiConfigService,
    private readonly provider: AIProviderPort,
    private readonly billing: AIServiceBillingService,
  ) {}

  async create(
    context: TenantContext,
    versionId: string,
    input: CreateExtractionInput,
    request: SourceRequestContext,
  ): Promise<RuleExtractionRunView> {
    this.assertEnabled();
    await this.consent.assertGranted(context);

    const existing = await this.findByIdempotencyKey(context, input.idempotencyKey);
    if (existing !== null) return this.toView(context, existing);

    // ADR-0149: one quote funds one run. Repeating the same confirmation
    // returns the run that quote already paid for — never a second reservation.
    const funded = await this.tenant.withTenant(scopeOf(context), (tx) =>
      this.billing.purchaseFundedBy(
        tx,
        context.userId,
        AIOperation.AI_RULE_EXTRACTION,
        input.priceQuoteId,
      ),
    );
    if (funded !== null) {
      const run = await this.tenant.withTenant(scopeOf(context), (tx) =>
        tx.ruleExtractionRun.findFirst({
          where: { id: funded.resourceId, standardVersionId: versionId },
        }),
      );
      if (run === null) {
        throw new AppError(PalCertErrorCode.QUOTE_ALREADY_USED, {
          message: 'That price quote has already been used. Please ask for a new one.',
        });
      }
      return this.toView(context, run);
    }

    const capabilities = this.provider.getCapabilities();
    const template = promptTemplate(PromptId.GUIDELINE_RULE_STRUCTURING);
    const runId = randomUUID();
    const purchaseId = randomUUID();

    const created = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      const version = await assertVersionVisible(tx, versionId);
      if (version.status !== 'DRAFT') {
        throw new AppError(PalCertErrorCode.STANDARD_SOURCE_VERSION_NOT_DRAFT, {
          message:
            'Rule extraction runs against a draft. Clone this version into a new draft first.',
        });
      }

      // Only READY sources: a source still scanning has not been proven safe,
      // and one rejected never will be.
      const sources = await tx.standardSourceAsset.findMany({
        where: {
          standardVersionId: versionId,
          status: StandardSourceStatus.READY,
          ...(input.sourceAssetIds === undefined || input.sourceAssetIds.length === 0
            ? {}
            : { id: { in: [...input.sourceAssetIds] } }),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      if (sources.length === 0) {
        throw new AppError(PalCertErrorCode.EXTRACTION_NO_USABLE_SOURCES, {
          message: 'This draft has no source ready to read. Upload a guideline or template first.',
        });
      }
      if (sources.length > this.config.extraction.maxSources) {
        throw new AppError(PalCertErrorCode.STANDARD_SOURCE_LIMIT_EXCEEDED, {
          message: `A single extraction may read at most ${this.config.extraction.maxSources} sources.`,
        });
      }

      // One run at a time per draft: two concurrent readings of the same
      // sources would produce two sets of proposals for the same requirements
      // and leave a reviewer to work out which was which.
      const live = await tx.ruleExtractionRun.count({
        where: {
          standardVersionId: versionId,
          status: {
            in: [
              RuleExtractionStatus.CREATED,
              RuleExtractionStatus.QUEUED,
              RuleExtractionStatus.DISCOVERING_EVIDENCE,
              RuleExtractionStatus.GENERATING_PROPOSALS,
              RuleExtractionStatus.VALIDATING,
            ],
          },
        },
      });
      if (live > 0) {
        throw new AppError(PalCertErrorCode.EXTRACTION_ALREADY_RUNNING, {
          message: 'An extraction is already running for this draft.',
        });
      }

      const sourceSetHash = computeSourceSetHash(
        sources.map((source) => ({
          sourceAssetId: source.id,
          sourceKind: source.sourceKind,
          sha256: source.sha256 ?? '',
        })),
      );

      // Every eligibility check above has passed (permission, consent, draft,
      // sources, one run at a time), so only now is money reserved — from the
      // initiating member's own balance. The organization is never the payer
      // and no organization role is exempt. A shortfall throws and nothing,
      // run or job, is written.
      const purchase = await this.billing.reserve(tx, {
        payerUserId: context.userId,
        operation: AIOperation.AI_RULE_EXTRACTION,
        resourceId: runId,
        purchaseId,
        priceQuoteId: input.priceQuoteId,
      });

      const run = await tx.ruleExtractionRun.create({
        data: {
          id: runId,
          servicePurchaseId: purchase.id,
          organizationId: context.organizationId,
          standardVersionId: versionId,
          status: RuleExtractionStatus.QUEUED,
          // Captured now. The draft may move while the provider works, and
          // acceptance re-checks the current revision rather than throwing
          // away everything the run found (§71).
          baseStandardRevision: version.revision,
          ruleSchemaVersion: version.ruleSchemaVersion,
          provider: capabilities.provider,
          configuredModel: capabilities.configuredModel,
          promptVersion: template.version,
          promptHash: template.hash,
          contextBuilderVersion: EXTRACTION_CONTEXT_BUILDER_VERSION,
          proposalSchemaVersion: PROPOSAL_SCHEMA_VERSION,
          sourceSetHash,
          idempotencyKey: input.idempotencyKey ?? null,
          createdByUserId: context.userId,
          sources: {
            create: sources.map((source, ordinal) => ({
              organizationId: context.organizationId,
              sourceAssetId: source.id,
              sourceKind: source.sourceKind,
              sourceSha256: source.sha256 ?? '',
              ordinal,
            })),
          },
        },
      });

      const job = await this.jobs.enqueueInTransaction(tx, {
        type: ProcessingJobType.RULE_EXTRACTION,
        resourceType: 'RULE_EXTRACTION_RUN',
        resourceId: run.id,
        ownerUserId: context.userId,
        organizationId: context.organizationId,
      });
      return { run, job, purchase, sourceIds: sources.map((source) => source.id) };
    });

    await this.billing.audit({
      action: 'AI_SERVICE_RESERVED',
      operation: AIOperation.AI_RULE_EXTRACTION,
      purchaseId: created.purchase.id,
      resourceId: created.run.id,
      payerUserId: context.userId,
      actorUserId: context.userId,
      organizationId: context.organizationId,
      amountMinor: created.purchase.amountMinor,
      currency: created.purchase.currency,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
    });
    await this.dispatcher.dispatchNow(created.job.id);
    await this.events.audit({
      action: 'RULE_EXTRACTION_REQUESTED',
      actorUserId: context.userId,
      targetType: 'RuleExtractionRun',
      targetId: created.run.id,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      afterState: {
        standardVersionId: versionId,
        sourceCount: created.sourceIds.length,
        provider: capabilities.provider,
        configuredModel: capabilities.configuredModel,
      },
    });

    return this.toView(context, created.run);
  }

  /**
   * Cancel a run that has not reached the provider (§38).
   *
   * PalCert does not claim to recall a request already in flight: saying "we
   * stopped it" when a provider may already have the bytes would be a promise
   * PalCert cannot keep.
   */
  async cancel(
    context: TenantContext,
    versionId: string,
    runId: string,
    request: SourceRequestContext,
  ): Promise<RuleExtractionRunView> {
    const run = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      const current = await loadRun(tx, versionId, runId);
      if (!isExtractionCancellable(current.status as RuleExtractionStatus)) {
        throw new AppError(PalCertErrorCode.EXTRACTION_NOT_CANCELLABLE, {
          message: 'This extraction has already started and cannot be cancelled.',
        });
      }
      return tx.ruleExtractionRun.update({
        where: { id: runId },
        data: { status: RuleExtractionStatus.CANCELLED, cancelledAt: new Date() },
      });
    });

    // Cancelled before any provider work: the reservation goes back to the
    // member who paid, who may not be the member cancelling. Row-level security
    // keeps a purchase visible only to its owner, so the release runs in the
    // payer's own scope. It is idempotent, and the worker releases too if it
    // ever meets a cancelled run whose purchase is still reserved.
    await this.releaseCancelled(run, context.organizationId, context.userId, request);

    await this.events.audit({
      action: 'RULE_EXTRACTION_CANCELLED',
      actorUserId: context.userId,
      targetType: 'RuleExtractionRun',
      targetId: runId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
    });

    return this.toView(context, run);
  }

  private async releaseCancelled(
    run: RuleExtractionRun,
    organizationId: string,
    actorUserId: string | null,
    request: SourceRequestContext | null,
  ): Promise<void> {
    if (run.servicePurchaseId === null || run.createdByUserId === null) return;
    const purchaseId = run.servicePurchaseId;
    const payer = run.createdByUserId;
    const { released } = await this.tenant.withUser(payer, (tx) =>
      this.billing.release(tx, purchaseId, PurchaseFailureCode.CANCELLED_BY_CUSTOMER),
    );
    if (!released) return;
    await this.billing.audit({
      action: 'AI_SERVICE_RELEASED',
      operation: AIOperation.AI_RULE_EXTRACTION,
      purchaseId,
      resourceId: run.id,
      payerUserId: payer,
      actorUserId,
      organizationId,
      failureCode: PurchaseFailureCode.CANCELLED_BY_CUSTOMER,
      ...(request === null ? {} : { requestId: request.requestId, ipAddress: request.ipAddress }),
    });
  }

  private assertEnabled(): void {
    if (this.config.ai.enabled) return;
    throw new AppError(PalCertErrorCode.AI_DISABLED, {
      message: 'AI rule extraction is not available on this deployment.',
    });
  }

  private async findByIdempotencyKey(
    context: TenantContext,
    key: string | undefined,
  ): Promise<RuleExtractionRun | null> {
    if (key === undefined) return null;
    return this.tenant.withTenant(scopeOf(context), (tx) =>
      tx.ruleExtractionRun.findUnique({
        where: {
          organizationId_idempotencyKey: {
            organizationId: context.organizationId,
            idempotencyKey: key,
          },
        },
      }),
    );
  }

  private async toView(
    context: TenantContext,
    run: RuleExtractionRun,
  ): Promise<RuleExtractionRunView> {
    const sources = await this.tenant.withTenant(scopeOf(context), (tx) =>
      tx.ruleExtractionRunSource.findMany({
        where: { extractionRunId: run.id },
        orderBy: { ordinal: 'asc' },
      }),
    );
    return toRunView(
      run,
      sources.map((source) => source.sourceAssetId),
    );
  }
}

export function toRunView(
  run: RuleExtractionRun,
  sourceAssetIds: readonly string[],
): RuleExtractionRunView {
  return {
    id: run.id,
    standardVersionId: run.standardVersionId,
    status: run.status as RuleExtractionStatus,
    failureKind: run.failureKind,
    baseStandardRevision: run.baseStandardRevision,
    provider: run.provider,
    configuredModel: run.configuredModel,
    providerReturnedModel: run.providerReturnedModel,
    promptVersion: run.promptVersion,
    contextBuilderVersion: run.contextBuilderVersion,
    proposalSchemaVersion: run.proposalSchemaVersion,
    sourceSetHash: run.sourceSetHash,
    extractionRunHash: run.extractionRunHash,
    sourceAssetIds,
    summary:
      run.sourcesProcessed === null
        ? null
        : {
            sourcesProcessed: run.sourcesProcessed,
            evidenceBlocks: run.evidenceCount ?? 0,
            templateObservations: run.observationCount ?? 0,
            explicitRequirementProposals: run.explicitRequirementCount ?? 0,
            templateInferenceProposals: run.templateInferenceCount ?? 0,
            ambiguousRequirements: run.ambiguousRequirementCount ?? 0,
            conflictingRequirements: run.conflictingRequirementCount ?? 0,
            unrepresentableRequirements: run.unrepresentableRequirementCount ?? 0,
            invalidProposals: run.invalidProposalCount ?? 0,
          },
    usage:
      run.inputTokens === null
        ? null
        : {
            inputTokens: run.inputTokens,
            outputTokens: run.outputTokens ?? 0,
            invocationCount: run.invocationCount,
          },
    createdByUserId: run.createdByUserId,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    failedAt: run.failedAt?.toISOString() ?? null,
  };
}

export async function loadRun(
  tx: TenantClient,
  versionId: string,
  runId: string,
): Promise<RuleExtractionRun> {
  const run = await tx.ruleExtractionRun.findFirst({
    where: { id: runId, standardVersionId: versionId },
  });
  if (run === null) {
    throw new AppError(PalCertErrorCode.EXTRACTION_RUN_NOT_FOUND, {
      message: 'That extraction run does not exist.',
    });
  }
  return run;
}
