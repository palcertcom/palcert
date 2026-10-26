import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  AIFailureKind,
  AIProviderError,
  AIProviderPort,
  EvidenceKind,
  EvidenceLocatorType,
  ExtractionContract,
  ObservationUniformity,
  ProposalValidationStatus,
  RuleProposalKind,
  StandardSourceKind,
  classifyUniformity,
  describeRuleSchema,
  proposalRequiresRuleDefinition,
  validateExtractionContract,
  type ExtractionDocument,
  type RuleDefinition,
} from '@palcert/contracts';
import {
  buildEvidenceDiscoveryInstruction,
  buildRuleStructuringPrompt,
  type EvidenceForPrompt,
} from '../../../infrastructure/ai/extraction-prompt-builder';
import { PromptId, promptTemplate } from '../../../infrastructure/ai/prompt-registry';
import { ProposalValidationService, type PropertySupport } from './proposal-validation.service';

/**
 * A reusable evaluation harness for rule extraction (§148).
 *
 * It answers "is this model good enough to propose rules to an institution"
 * with measurements instead of an argument, and it answers it over the
 * committed synthetic corpus rather than over anyone's real guidelines (§149).
 *
 * The numbers it produces are the ones that decide whether extraction is safe
 * to offer: how often an explicit requirement is found at all, how often what
 * comes back is a rule PalCert would accept from a human, how often the model
 * cited something PalCert never sent it, and how often two disagreeing sources
 * are reported as a disagreement instead of silently resolved.
 *
 * What it deliberately does *not* do is assert on prose. A model's wording
 * changes between revisions and says nothing about whether the extraction was
 * right (§141), so every measurement here is structural: a kind, an evidence
 * id, a validator verdict, a conflict.
 *
 * Read {@link ExtractionBenchmarkSummary.disclaimer} before quoting any of it.
 */

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

export interface GuidelineCase {
  readonly id: string;
  readonly language: string;
  readonly sourceKind: StandardSourceKind;
  readonly passage: string;
  readonly sourceLabel?: string;
  readonly expected: {
    /** `NONE` means the passage states no requirement at all. */
    readonly kind: RuleProposalKind | 'NONE';
    readonly scopeKey?: string;
    readonly representable?: boolean;
    readonly automationSupport?: string;
    readonly evaluationMode?: string;
    readonly conflictsWith?: string;
    readonly duplicateOf?: string;
    readonly clarificationNeeded?: string;
    readonly note?: string;
  };
}

export interface TemplateCase {
  readonly id: string;
  readonly description: string;
  readonly facts: readonly {
    readonly scope: string;
    readonly unit?: string;
    readonly value: string;
    readonly times: number;
  }[];
  readonly expected: {
    readonly uniformity: ObservationUniformity;
    readonly modalValue: string | null;
    /** Whether a template this consistent is worth putting to a reviewer at all. */
    readonly proposable: boolean;
    readonly note?: string;
  };
}

export interface ExtractionCorpus {
  readonly corpusVersion: number;
  readonly description: string;
  readonly guidelines: readonly GuidelineCase[];
  readonly templates: readonly TemplateCase[];
}

/**
 * One invocation's worth of corpus.
 *
 * Usually a single case. Two cases that the corpus says disagree are run
 * together, because a conflict between sources cannot be observed by looking at
 * one source (§62).
 */
export interface CaseGroup {
  readonly groupId: string;
  readonly cases: readonly GuidelineCase[];
}

// ---------------------------------------------------------------------------
// The measurements
// ---------------------------------------------------------------------------

export interface ExtractionBenchmarkResult {
  readonly groupId: string;
  readonly caseIds: readonly string[];
  readonly expectedKinds: readonly (RuleProposalKind | 'NONE')[];
  readonly actualKinds: readonly string[];
  /** Citations Pass A returned, and how many resolved to something PalCert sent. */
  readonly citationCount: number;
  readonly groundedCitationCount: number;
  readonly proposalCount: number;
  /** Proposals whose kind requires a rule definition. */
  readonly ruleBearingCount: number;
  /** ...of which PalCert's own validator accepted, at the draft's schema version. */
  readonly validRuleCount: number;
  /** True when the model cited an evidence id or a locator PalCert never supplied (§55). */
  readonly hallucinatedEvidence: boolean;
  readonly conflictExpected: boolean;
  readonly conflictDetected: boolean;
  readonly unrepresentableExpected: boolean;
  readonly unrepresentableDetected: boolean;
  readonly explicitExpected: boolean;
  readonly explicitFound: boolean;
  readonly structuredOutputFailed: boolean;
  readonly failureKind: string | null;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ExtractionBenchmarkSummary {
  readonly provider: string;
  readonly configuredModel: string;
  readonly discoveryPromptVersion: string;
  readonly structuringPromptVersion: string;
  readonly corpusVersion: number;
  readonly caseCount: number;
  readonly groupCount: number;
  /** Share of explicit-requirement cases where an explicit proposal came back. */
  readonly explicitRequirementRecall: number;
  /** Share of rule-bearing proposals PalCert's validator accepted (§58). */
  readonly proposalValidityRate: number;
  /** Share of Pass A citations that resolved to a document PalCert supplied. */
  readonly evidenceGroundingRate: number;
  /** Share of groups where the model cited something PalCert never sent (§55). */
  readonly hallucinatedEvidenceRate: number;
  /** Share of corpus conflicts reported as conflicts rather than resolved (§62). */
  readonly conflictDetectionRate: number;
  /** Share of unrepresentable requirements reported instead of dropped (§53). */
  readonly unrepresentableDetectionRate: number;
  readonly structuredOutputFailureRate: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly medianLatencyMs: number;
  /**
   * Read before quoting a number above.
   *
   * §148 is explicit that these must not be presented as validated metrics
   * unless the dataset supports the claim, and this dataset does not: it is a
   * few dozen passages written by PalCert's own authors to exercise the
   * classification boundaries. It is a regression guard and a rough comparison
   * between providers. It is not a measurement of accuracy on real
   * institutional guidelines, and nothing in a sales document should say it is.
   */
  readonly disclaimer: string;
  readonly results: readonly ExtractionBenchmarkResult[];
}

const DISCLAIMER =
  'Synthetic corpus authored by PalCert to exercise classification boundaries. ' +
  'Small, non-random and not drawn from real institutional guidelines: useful for ' +
  'regression detection and rough provider comparison, not a validated accuracy measurement.';

/** Enough of the analyzer catalogue to judge the corpus, when none is supplied. */
const DEFAULT_CATALOGUE: readonly PropertySupport[] = [
  { name: 'marginLeft', scopes: ['PAGE'], exactness: 'EXACT' },
  { name: 'marginRight', scopes: ['PAGE'], exactness: 'EXACT' },
  { name: 'fontSize', scopes: ['ELEMENT'], exactness: 'EXACT' },
  { name: 'fontFamily', scopes: ['ELEMENT'], exactness: 'EXACT' },
  { name: 'lineSpacing', scopes: ['ELEMENT'], exactness: 'EXACT' },
  { name: 'wordCount', scopes: ['SECTION', 'DOCUMENT'], exactness: 'DERIVED' },
];

export class ExtractionBenchmarkHarness {
  constructor(
    private readonly provider: AIProviderPort,
    private readonly validation: ProposalValidationService,
    private readonly catalogue: readonly PropertySupport[] = DEFAULT_CATALOGUE,
  ) {}

  /** The committed synthetic corpus. No institution's guidelines, ever (§149). */
  loadCorpus(path = defaultCorpusPath()): ExtractionCorpus {
    return JSON.parse(readFileSync(path, 'utf8')) as ExtractionCorpus;
  }

  /**
   * Group the guideline cases into invocations.
   *
   * Cases the corpus marks as disagreeing are put in one group, because a model
   * shown one of them alone has nothing to disagree with — it would be measured
   * against a question it was never asked.
   */
  groupCases(cases: readonly GuidelineCase[]): readonly CaseGroup[] {
    const byId = new Map(cases.map((entry) => [entry.id, entry]));
    const assigned = new Set<string>();
    const groups: CaseGroup[] = [];

    for (const entry of cases) {
      if (assigned.has(entry.id)) continue;
      const members = [entry];
      assigned.add(entry.id);

      const partnerId = entry.expected.conflictsWith;
      const partner = partnerId === undefined ? undefined : byId.get(partnerId);
      if (partner !== undefined && !assigned.has(partner.id)) {
        members.push(partner);
        assigned.add(partner.id);
      }
      groups.push({ groupId: entry.id, cases: members });
    }
    return groups;
  }

  async run(
    cases: readonly GuidelineCase[],
    options: { readonly ruleSchemaVersion?: number; readonly corpusVersion?: number } = {},
  ): Promise<ExtractionBenchmarkSummary> {
    const schema = describeRuleSchema();
    const ruleSchemaVersion = options.ruleSchemaVersion ?? schema.ruleSchemaVersion;
    const capabilities = this.provider.getCapabilities();
    const groups = this.groupCases(cases);

    const results: ExtractionBenchmarkResult[] = [];
    for (const group of groups) {
      results.push(await this.runGroup(group, ruleSchemaVersion));
    }

    const latencies = results.map((result) => result.latencyMs).sort((a, b) => a - b);
    const citations = sum(results, (result) => result.citationCount);
    const grounded = sum(results, (result) => result.groundedCitationCount);
    const ruleBearing = sum(results, (result) => result.ruleBearingCount);

    return {
      provider: capabilities.provider,
      configuredModel: capabilities.configuredModel,
      discoveryPromptVersion: promptTemplate(PromptId.GUIDELINE_EVIDENCE_DISCOVERY).version,
      structuringPromptVersion: promptTemplate(PromptId.GUIDELINE_RULE_STRUCTURING).version,
      corpusVersion: options.corpusVersion ?? 0,
      caseCount: cases.length,
      groupCount: groups.length,
      explicitRequirementRecall: shareOf(
        results,
        (result) => result.explicitExpected,
        (result) => result.explicitFound,
      ),
      // No rule-bearing proposal is not a failure: an ambiguous source should
      // produce none. An empty denominator reports 1, meaning "nothing invalid
      // was proposed", which is what actually happened.
      proposalValidityRate:
        ruleBearing === 0 ? 1 : sum(results, (r) => r.validRuleCount) / ruleBearing,
      evidenceGroundingRate: citations === 0 ? 0 : grounded / citations,
      hallucinatedEvidenceRate: share(results, (result) => result.hallucinatedEvidence),
      conflictDetectionRate: shareOf(
        results,
        (result) => result.conflictExpected,
        (result) => result.conflictDetected,
      ),
      unrepresentableDetectionRate: shareOf(
        results,
        (result) => result.unrepresentableExpected,
        (result) => result.unrepresentableDetected,
      ),
      structuredOutputFailureRate: share(results, (result) => result.structuredOutputFailed),
      totalInputTokens: sum(results, (result) => result.inputTokens),
      totalOutputTokens: sum(results, (result) => result.outputTokens),
      medianLatencyMs:
        latencies.length === 0 ? 0 : (latencies[Math.floor(latencies.length / 2)] ?? 0),
      disclaimer: DISCLAIMER,
      results,
    };
  }

  // -------------------------------------------------------------------------

  private async runGroup(
    group: CaseGroup,
    ruleSchemaVersion: number,
  ): Promise<ExtractionBenchmarkResult> {
    const expectations = expectationsFor(group);
    const startedAt = Date.now();

    try {
      const documents = group.cases.map(toDocument);
      const discovery = await this.provider.discoverGuidelineEvidence({
        extractionRunId: `benchmark-${group.groupId}`,
        systemPrompt: promptTemplate(PromptId.GUIDELINE_EVIDENCE_DISCOVERY).system,
        instruction: buildEvidenceDiscoveryInstruction({
          sourceLabels: group.cases.map(labelOf),
          truncated: false,
        }),
        documents,
      });

      // Grounding is decided against what PalCert actually sent, never against
      // the model's own account of what it read (§55).
      const grounded = discovery.citations.filter((citation) => isGrounded(citation, documents));
      const evidence: EvidenceForPrompt[] = grounded.map((citation, index) => ({
        evidenceId: `ev-${index + 1}`,
        sourceLabel: labelFor(citation.sourceAssetId, group),
        sourceKind: kindFor(citation.sourceAssetId, group),
        evidenceKind: EvidenceKind.EXPLICIT_TEXT,
        locatorType:
          citation.kind === 'PDF_PAGE'
            ? EvidenceLocatorType.PDF_PAGE
            : citation.kind === 'DOCX_BLOCK'
              ? EvidenceLocatorType.DOCX_NODE
              : EvidenceLocatorType.TEXT_CHAR,
        locatorLabel: locatorLabel(citation),
        excerpt: citation.citedText,
      }));

      const suppliedEvidenceIds = evidence.map((entry) => entry.evidenceId);
      const structuring = await this.propose(
        group,
        evidence,
        suppliedEvidenceIds,
        ruleSchemaVersion,
      );
      const proposals = structuring.proposals;

      const kinds = proposals.map((proposal) => proposal.kind);
      const ruleBearing = proposals.filter((proposal) =>
        proposalRequiresRuleDefinition(proposal.kind as RuleProposalKind),
      );
      const validated = ruleBearing.map((proposal) =>
        this.validation.validate(
          proposal.kind as RuleProposalKind,
          (proposal as { suggestedRule?: unknown }).suggestedRule ?? null,
          ruleSchemaVersion,
        ),
      );
      const definitions = validated
        .map((result) => result.definition)
        .filter((definition): definition is RuleDefinition => definition !== null);

      const fabricated = proposals.some((proposal) =>
        proposal.evidenceIds.some((id: string) => !suppliedEvidenceIds.includes(id)),
      );

      return {
        groupId: group.groupId,
        caseIds: group.cases.map((entry) => entry.id),
        expectedKinds: expectations.kinds,
        actualKinds: kinds,
        citationCount: discovery.citations.length,
        groundedCitationCount: grounded.length,
        proposalCount: proposals.length,
        ruleBearingCount: ruleBearing.length,
        validRuleCount: validated.filter(
          (result) => result.status === ProposalValidationStatus.VALID,
        ).length,
        hallucinatedEvidence: fabricated || grounded.length < discovery.citations.length,
        conflictExpected: expectations.conflict,
        conflictDetected:
          kinds.includes(RuleProposalKind.CONFLICTING_REQUIREMENT) ||
          this.crossSourceConflict(definitions),
        unrepresentableExpected: expectations.unrepresentable,
        unrepresentableDetected: kinds.includes(RuleProposalKind.UNREPRESENTABLE_REQUIREMENT),
        explicitExpected: expectations.explicit,
        explicitFound: kinds.includes(RuleProposalKind.EXPLICIT_REQUIREMENT),
        structuredOutputFailed: false,
        failureKind: null,
        latencyMs: Date.now() - startedAt,
        // Both passes, because both are what an extraction costs (§107).
        inputTokens: discovery.usage.inputTokens + structuring.usage.inputTokens,
        outputTokens: discovery.usage.outputTokens + structuring.usage.outputTokens,
      };
    } catch (error) {
      // A refused or malformed response is a measurement, not a crash: "how
      // often does this model return something PalCert cannot accept" is one of
      // the numbers the harness exists to produce.
      const kind = error instanceof AIProviderError ? error.kind : 'UNKNOWN_PROVIDER_ERROR';
      return {
        groupId: group.groupId,
        caseIds: group.cases.map((entry) => entry.id),
        expectedKinds: expectations.kinds,
        actualKinds: [],
        citationCount: 0,
        groundedCitationCount: 0,
        proposalCount: 0,
        ruleBearingCount: 0,
        validRuleCount: 0,
        hallucinatedEvidence: /never supplied|not supplied/i.test(
          error instanceof Error ? error.message : '',
        ),
        conflictExpected: expectations.conflict,
        conflictDetected: false,
        unrepresentableExpected: expectations.unrepresentable,
        unrepresentableDetected: false,
        explicitExpected: expectations.explicit,
        explicitFound: false,
        structuredOutputFailed: kind === AIFailureKind.OUTPUT_INVALID,
        failureKind: kind,
        latencyMs: Date.now() - startedAt,
        inputTokens: 0,
        outputTokens: 0,
      };
    }
  }

  private async propose(
    group: CaseGroup,
    evidence: readonly EvidenceForPrompt[],
    suppliedEvidenceIds: readonly string[],
    ruleSchemaVersion: number,
  ): Promise<{
    readonly proposals: readonly { kind: string; evidenceIds: readonly string[] }[];
    readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  }> {
    const schema = describeRuleSchema();
    const template = promptTemplate(PromptId.GUIDELINE_RULE_STRUCTURING);

    const response = await this.provider.extractRuleProposals({
      extractionRunId: `benchmark-${group.groupId}`,
      systemPrompt: template.system,
      userPrompt: buildRuleStructuringPrompt({
        vocabulary: {
          ruleSchemaVersion,
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
        },
        properties: this.catalogue.map((property) => ({
          name: property.name,
          scopes: property.scopes,
          unit: null,
          support: this.validation.automationSupport(
            {
              evaluationMode: 'DETERMINISTIC',
              scope: { kind: property.scopes[0] ?? 'DOCUMENT', property: property.name },
            } as unknown as RuleDefinition,
            this.catalogue,
          ),
        })),
        evidence,
        observations: [],
        existingRules: [],
        maxProposals: 50,
      }),
      suppliedEvidenceIds,
    });

    // Validated here too, exactly as production does: the benchmark must not
    // score a response the product itself would have refused (§84).
    const contract = validateExtractionContract(
      ExtractionContract.PROPOSAL_OUTPUT,
      response.output,
    );
    if (!contract.valid) {
      throw new AIProviderError(
        AIFailureKind.OUTPUT_INVALID,
        'the provider response failed PalCert validation',
      );
    }
    return {
      proposals: response.output.proposals as unknown as readonly {
        kind: string;
        evidenceIds: readonly string[];
      }[],
      usage: response.usage,
    };
  }

  private crossSourceConflict(definitions: readonly RuleDefinition[]): boolean {
    const conflicts = this.validation.findCrossSourceConflicts(
      definitions.map((definition, index) => ({
        key: `p-${index}`,
        definition,
        sourceAssetIds: [],
      })),
    );
    return conflicts.size > 0;
  }
}

// ---------------------------------------------------------------------------
// Template observations, the same corpus, no model at all
// ---------------------------------------------------------------------------

/**
 * Re-derive a template case's uniformity from its counts.
 *
 * Deliberately independent of {@link TemplateObservationEngine}: it lets the
 * corpus be checked for internal consistency without asserting the engine
 * against itself.
 */
export function uniformityOf(templateCase: TemplateCase): ObservationUniformity {
  const total = templateCase.facts.reduce((count, fact) => count + fact.times, 0);
  const modal = templateCase.facts.reduce((best, fact) => Math.max(best, fact.times), 0);
  return classifyUniformity(total, modal);
}

/** Whether a template this consistent is worth putting to a reviewer (§4, §33). */
export function isProposable(uniformity: ObservationUniformity): boolean {
  return (
    uniformity === ObservationUniformity.UNIFORM ||
    uniformity === ObservationUniformity.MOSTLY_UNIFORM
  );
}

// ---------------------------------------------------------------------------

function expectationsFor(group: CaseGroup): {
  kinds: readonly (RuleProposalKind | 'NONE')[];
  explicit: boolean;
  conflict: boolean;
  unrepresentable: boolean;
} {
  const kinds = group.cases.map((entry) => entry.expected.kind);
  return {
    kinds,
    explicit: kinds.includes(RuleProposalKind.EXPLICIT_REQUIREMENT),
    conflict: kinds.includes(RuleProposalKind.CONFLICTING_REQUIREMENT),
    unrepresentable: kinds.includes(RuleProposalKind.UNREPRESENTABLE_REQUIREMENT),
  };
}

/**
 * One case as a document.
 *
 * Always `BLOCKS`, never a synthesized PDF: the harness measures extraction,
 * and a renderer's idea of where a sentence lands on a page would add a
 * variable that has nothing to do with the model under test.
 */
function toDocument(entry: GuidelineCase): ExtractionDocument {
  return {
    kind: 'BLOCKS',
    sourceAssetId: entry.id,
    title: labelOf(entry),
    blocks: [entry.passage],
    nodeIds: [`corpus/${entry.id}/p:1`],
  };
}

function labelOf(entry: GuidelineCase): string {
  return entry.sourceLabel ?? `${entry.id}.pdf`;
}

function labelFor(sourceAssetId: string, group: CaseGroup): string {
  const entry = group.cases.find((item) => item.id === sourceAssetId);
  return entry === undefined ? 'source' : labelOf(entry);
}

function kindFor(sourceAssetId: string, group: CaseGroup): StandardSourceKind {
  const entry = group.cases.find((item) => item.id === sourceAssetId);
  return entry?.sourceKind ?? StandardSourceKind.GUIDELINE_PDF;
}

function isGrounded(
  citation: {
    kind: string;
    sourceAssetId: string;
    startBlockIndex?: number;
    endBlockIndex?: number;
  },
  documents: readonly ExtractionDocument[],
): boolean {
  const document = documents.find((entry) => entry.sourceAssetId === citation.sourceAssetId);
  if (document === undefined) return false;
  if (citation.kind !== 'DOCX_BLOCK') return true;
  const start = citation.startBlockIndex ?? -1;
  const end = citation.endBlockIndex ?? -1;
  const blockCount = document.kind === 'BLOCKS' ? document.blocks.length : 0;
  // Inclusive start, exclusive end, as the provider's own content-block
  // citations are (ADR-0063).
  return start >= 0 && end > start && end <= blockCount;
}

function locatorLabel(citation: {
  kind: string;
  startPage?: number;
  startBlockIndex?: number;
  startCharIndex?: number;
}): string {
  if (citation.kind === 'PDF_PAGE') return `page ${citation.startPage ?? 1}`;
  if (citation.kind === 'DOCX_BLOCK') return `block ${citation.startBlockIndex ?? 0}`;
  return `characters ${citation.startCharIndex ?? 0}`;
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

function share<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  if (items.length === 0) return 0;
  return items.filter(predicate).length / items.length;
}

/** A rate over the subset the question applies to, rather than over everything. */
function shareOf<T>(
  items: readonly T[],
  applies: (item: T) => boolean,
  predicate: (item: T) => boolean,
): number {
  const subset = items.filter(applies);
  if (subset.length === 0) return 0;
  return subset.filter(predicate).length / subset.length;
}

function defaultCorpusPath(): string {
  // Resolved from this file, so the harness works from any working directory.
  return resolve(
    dirname(__filename),
    '../../../../../../contracts/fixtures/extraction/guideline-corpus.json',
  );
}
