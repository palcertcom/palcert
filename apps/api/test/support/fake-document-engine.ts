import { CAPABILITY_REGISTRY_VERSION, type RuleEvaluationResult } from '@palcert/contracts';
import { createHash } from 'node:crypto';
import {
  DocumentEngineError,
  DocumentEnginePort,
  type AnalyzeDocumentRequest,
  type AnalyzeDocumentResult,
  type EvaluateRulesRequest,
  type EvaluateRulesResult,
  SmartFixEngineError,
  type ApplySmartFixRequest,
  type ApplySmartFixResult,
  type DocxPropertyDescriptor,
  type PlanSmartFixRequest,
  type PlanSmartFixResult,
} from '../../src/infrastructure/document-engine/document-engine.port';
import {
  DOCX_ANALYZER_NAME,
  DOCX_ANALYZER_VERSION,
  PDF_ANALYZER_NAME,
  PDF_ANALYZER_VERSION,
} from '../../src/modules/analysis/services/document-analysis.service';
import { correctedDocx } from './fixtures';

/**
 * An empty citation section, which an envelope must carry at version 2.
 *
 * The double does not analyze anything, so it has no citation evidence to
 * report — and "none observed" is a shape the contract has, rather than a
 * reason to omit the section. Omitting it would make the double produce an
 * artifact the real analyzer cannot produce and the contract rejects.
 *
 * Both formats carry it now: Phase 18 moved DOCX to envelope 2 and then PDF.
 */
const NO_CITATION_EVIDENCE = {
  citationAnalysisSchemaVersion: 1,
  bibliographySources: [],
  citations: [],
  coverage: [],
  links: [],
  references: [],
  summary: {
    ambiguousCitationCount: 0,
    bibliographySourceCount: 0,
    linkedCitationCount: 0,
    nativeCitationCount: 0,
    observedCitationCount: 0,
    observedDuplicateReferenceCount: 0,
    observedReferenceCount: 0,
    observedUncitedReferenceCount: 0,
    referenceRegionObserved: false,
    truncationFlags: [],
    unresolvedCitationCount: 0,
  },
} as const;

/**
 * A document engine double for the orchestration tests.
 *
 * The real analyzer is exercised by the Python golden corpus, which is where
 * OOXML behaviour belongs. These suites are about the *orchestration* — job
 * claiming, idempotency, integrity, isolation, storage — and running a second
 * language runtime to test that would make failures ambiguous and the suite
 * slow. The double produces a real, deterministic artifact so every hash and
 * size assertion is genuine.
 */
export class FakeDocumentEngine extends DocumentEnginePort {
  /** How the next call behaves. Tests set this. */
  mode:
    | 'normal'
    | 'unavailable'
    | 'timeout'
    | 'invalid-document'
    | 'password-required'
    | 'digest-mismatch' = 'normal';
  analyzerName: string = DOCX_ANALYZER_NAME;
  /**
   * Imported rather than written out, so a version bump reaches the double.
   *
   * The handler refuses to store an artifact whose analyzer identity does not
   * match the analysis row, so a double left behind on the old version would
   * fail every orchestration test at once — and a double that hard-coded the
   * new one would pass them while the real engine disagreed. Still writable,
   * because several tests set it deliberately to exercise that refusal.
   */
  analyzerVersion: string = DOCX_ANALYZER_VERSION;
  /**
   * Extra paragraphs and the equations in them, for tests about equations.
   * Empty unless a test sets it, so every other suite sees the same model.
   */
  extraParagraphs: Record<string, unknown>[] = [];
  equations: Record<string, unknown>[] = [];
  /**
   * Extra facts for a DOCX, for tests that need a template with many
   * measurable properties (and so many template observations). Empty unless a
   * test sets it.
   */
  extraFacts: Record<string, unknown>[] = [];
  /**
   * The PDF analyzer's identity, which the handler checks against the analysis
   * row before storing anything. Imported for the same reason, so a rename
   * fails loudly rather than storing an artifact under the wrong name.
   */
  pdfAnalyzerName: string = PDF_ANALYZER_NAME;
  pdfAnalyzerVersion: string = PDF_ANALYZER_VERSION;
  factSchemaVersion = 2;
  /**
   * The envelope version, per format.
   *
   * Both are 2 now. They are still separate fields because they were not
   * always, and a test that wants to exercise one format on an older envelope
   * has to be able to say so.
   */
  analysisSchemaVersion = 2;
  pdfAnalysisSchemaVersion = 2;
  /** Every request it received, for duplicate-delivery assertions. */
  readonly calls: AnalyzeDocumentRequest[] = [];
  /** Every evaluation request it received. */
  readonly evaluationCalls: EvaluateRulesRequest[] = [];
  /** How the next evaluation behaves. */
  evaluationMode: 'normal' | 'unavailable' | 'malformed' = 'normal';
  /**
   * Results the next evaluation returns.
   *
   * Left null, the double derives one PASS per rule from the rule codes it was
   * given, so an orchestration test that does not care about outcomes still
   * gets a coherent response.
   */
  evaluationResults: RuleEvaluationResult[] | null = null;
  ready = true;

  /** How the next SmartFix call behaves. */
  smartFixMode: 'normal' | 'unavailable' | 'invalid-document' | 'refuse-apply' = 'normal';
  /** Set to make the next plan refuse the document outright. */
  smartFixRefusal: string | null = null;
  fixEngineName = 'palcert-docx-fixer';
  fixEngineVersion = '1.0.0';
  /**
   * The capability registry the double claims to be running.
   *
   * Read from the shared contract rather than pinned to a number, because the
   * real mutation engine refuses a plan stamped with anything but the current
   * registry version. A double that stamped a stale version would both produce
   * and accept a plan the real engine would reject with PLAN_ENGINE_MISMATCH,
   * and these suites would go on passing in a state production cannot reach.
   * Still writable: a test that deliberately simulates another engine sets it.
   */
  capabilityRegistryVersion: number = CAPABILITY_REGISTRY_VERSION;
  readonly planCalls: PlanSmartFixRequest[] = [];
  readonly applyCalls: ApplySmartFixRequest[] = [];

  async analyzeDocument(request: AnalyzeDocumentRequest): Promise<AnalyzeDocumentResult> {
    this.calls.push(request);

    if (this.mode === 'unavailable') {
      throw new DocumentEngineError('ENGINE', null, 'analyzer unreachable');
    }
    if (this.mode === 'timeout') {
      throw new DocumentEngineError('ENGINE', null, 'analyzer timed out');
    }
    if (this.mode === 'invalid-document') {
      throw new DocumentEngineError('DOCUMENT', 'DOCX_XML_INVALID', 'analyzer responded 422');
    }
    if (this.mode === 'password-required') {
      throw new DocumentEngineError('DOCUMENT', 'PDF_PASSWORD_REQUIRED', 'analyzer responded 415');
    }

    // Each format's artifact is stamped with its own analyzer, because the
    // handler refuses to store one under the other's identity.
    const isPdf = request.format === 'PDF';
    const analyzerName = isPdf ? this.pdfAnalyzerName : this.analyzerName;
    const analyzerVersion = isPdf ? this.pdfAnalyzerVersion : this.analyzerVersion;
    const envelopeVersion = isPdf ? this.pdfAnalysisSchemaVersion : this.analysisSchemaVersion;

    // A deterministic artifact derived from the source digest, so two calls on
    // the same document produce identical bytes exactly as the real one does.
    const artifact = Buffer.from(
      JSON.stringify({
        analysisSchemaVersion: envelopeVersion,
        analyzer: { name: analyzerName, version: analyzerVersion },
        ...(isPdf ? { format: 'PDF' } : {}),
        citationAnalysis: NO_CITATION_EVIDENCE,
        factSchemaVersion: this.factSchemaVersion,
        factSet: {
          coverage: [
            isPdf ? { kind: 'PAGE', status: 'COMPLETE' } : { kind: 'PAGE', status: 'UNAVAILABLE' },
          ],
          documentId: request.documentId,
          extractor: { name: analyzerName, version: analyzerVersion },
          facts: [
            isPdf
              ? {
                  // A PDF states its page count; a DOCX does not (§25).
                  provenance: { sourceKind: 'PDF_TEXT' },
                  scope: { kind: 'DOCUMENT', property: 'pageCount' },
                  unit: 'PAGES',
                  value: { number: '1', type: 'NUMBER' },
                }
              : {
                  provenance: { sourceKind: 'OOXML' },
                  scope: { kind: 'DOCUMENT', property: 'paragraphCount' },
                  unit: 'COUNT',
                  value: { number: '1', type: 'NUMBER' },
                },
            ...(isPdf ? [] : this.extraFacts),
          ],
          factSchemaVersion: this.factSchemaVersion,
        },
        source: { documentId: request.documentId, sha256: request.expectedSha256 },
        structuralModel: {
          // The structural model has its own version, and it stayed at 1.
          analysisSchemaVersion: 1,
          // A small, realistic outline and body. The Phase 8 context builder
          // selects paragraphs by keyword, so a structural model with none
          // would give it nothing to choose between and quietly hide whether
          // selection works at all.
          paragraphs: [
            {
              locator: {
                nodeId: 'main/body/p:1',
                path: ['main', 'body', 'p:1'],
                story: 'MAIN_DOCUMENT',
              },
              story: 'MAIN_DOCUMENT',
              headingLevel: 1,
              text: 'Declarations',
            },
            {
              locator: {
                nodeId: 'main/body/p:2',
                path: ['main', 'body', 'p:2'],
                story: 'MAIN_DOCUMENT',
              },
              story: 'MAIN_DOCUMENT',
              text: 'The authors declare no conflict of interest.',
            },
            {
              locator: {
                nodeId: 'main/body/p:3',
                path: ['main', 'body', 'p:3'],
                story: 'MAIN_DOCUMENT',
              },
              story: 'MAIN_DOCUMENT',
              text: 'يقر المؤلفون بعدم وجود تضارب في المصالح.',
            },
            ...this.extraParagraphs,
          ],
          ...(this.equations.length > 0 ? { equations: this.equations } : {}),
        },
        warnings: [],
      }),
      'utf8',
    );

    const digest = createHash('sha256').update(artifact).digest('hex');
    return {
      artifact,
      // The mismatch case simulates corruption between the analyzer and here.
      artifactSha256: this.mode === 'digest-mismatch' ? '0'.repeat(64) : digest,
      analyzerName,
      analyzerVersion,
      factSchemaVersion: this.factSchemaVersion,
      analysisSchemaVersion: envelopeVersion,
      factCount: 1,
      warningCount: 0,
      warningCodes: [],
      // Each analyzer's own summary shape. The PDF one is what the report
      // page reads to decide whether to explain a scan, so a double that
      // returned the DOCX counters would hide that the wiring works.
      summary: isPdf
        ? {
            pageCount: 1,
            textLayer: 'NATIVE_TEXT',
            tagged: false,
            imageOnlyPages: 0,
            nativeTextPages: 1,
          }
        : { factCount: 1, warningCount: 0, paragraphCount: 1, bodyWordCount: 2 },
      durationMs: 5,
    };
  }

  async evaluateRules(request: EvaluateRulesRequest): Promise<EvaluateRulesResult> {
    this.evaluationCalls.push(request);

    if (this.evaluationMode === 'unavailable') {
      throw new DocumentEngineError('ENGINE', null, 'engine unreachable');
    }
    if (this.evaluationMode === 'malformed') {
      // What the real adapter refuses: a response that does not satisfy the
      // shared contract must never become stored evidence (§35).
      throw new DocumentEngineError(
        'ENGINE',
        null,
        'the engine response failed its own contract: /results: must be array',
      );
    }

    const results =
      this.evaluationResults ??
      request.rules.map((rule) => passResultFor(rule, this.factSchemaVersion));

    return {
      response: {
        documentId: request.documentId,
        engine: {
          engineName: 'palcert-rule-engine',
          engineVersion: '1',
          ruleSchemaVersion: 2,
          factSchemaVersion: this.factSchemaVersion,
        },
        results,
      },
      durationMs: 3,
    };
  }

  /**
   * A small property catalogue, shaped like the analyzer's own.
   *
   * Enough to exercise every branch of the automation-support classification:
   * a property the analyzer measures exactly, one it derives, and — by
   * omission — one it cannot measure at all (§52).
   */
  async describeDocxProperties(): Promise<readonly DocxPropertyDescriptor[]> {
    if (!this.ready) {
      throw new DocumentEngineError('ENGINE', null, 'the analyzer capabilities were unreachable');
    }
    return [
      { name: 'marginLeft', scopes: ['PAGE'], unit: 'MILLIMETRE', exactness: 'EXACT' },
      { name: 'marginTop', scopes: ['PAGE'], unit: 'MILLIMETRE', exactness: 'EXACT' },
      { name: 'fontSize', scopes: ['ELEMENT'], unit: 'POINT', exactness: 'EXACT' },
      { name: 'fontFamily', scopes: ['ELEMENT'], unit: null, exactness: 'EXACT' },
      { name: 'lineSpacing', scopes: ['ELEMENT'], unit: 'LINES', exactness: 'DERIVED' },
      { name: 'wordCount', scopes: ['DOCUMENT'], unit: 'WORDS', exactness: 'DERIVED' },
    ];
  }

  /**
   * A plan, deterministic and shaped like the engine's.
   *
   * By default every deterministic, SAFE rule it is handed becomes one FIXABLE
   * rule with one action, and everything else is reported as manual work —
   * because a double that claimed to fix an AI-assisted rule would hide the
   * one boundary these tests exist to hold.
   */
  async planSmartFix(request: PlanSmartFixRequest): Promise<PlanSmartFixResult> {
    this.planCalls.push(request);

    if (this.smartFixMode === 'unavailable') {
      throw new SmartFixEngineError('ENGINE', null, 'fix engine unreachable');
    }
    if (this.smartFixMode === 'invalid-document') {
      throw new SmartFixEngineError(
        'DOCUMENT',
        'SMARTFIX_SOURCE_INTEGRITY_FAILED',
        'responded 422',
      );
    }

    const fixable = request.rules.filter((rule) => {
      const definition = rule as { evaluationMode?: unknown; autofix?: unknown };
      return definition?.evaluationMode === 'DETERMINISTIC' && definition?.autofix === 'SAFE';
    });
    const manual = request.rules.filter((rule) => !fixable.includes(rule));

    const actions = this.smartFixRefusal === null ? fixable : [];
    const plan = {
      planSchemaVersion: 1,
      source: request.source,
      engine: {
        fixEngineName: this.fixEngineName,
        fixEngineVersion: this.fixEngineVersion,
        capabilityRegistryVersion: this.capabilityRegistryVersion,
      },
      ...(this.smartFixRefusal === null ? {} : { refusal: { code: this.smartFixRefusal } }),
      rules: [
        ...actions.map((rule, index) => ({
          ruleCode: ruleCodeOf(rule),
          fixability: 'FIXABLE',
          actionIds: [actionId(index)],
          targetCount: 1,
          fixableTargetCount: 1,
        })),
        ...(this.smartFixRefusal === null ? manual : request.rules).map((rule) => ({
          ruleCode: ruleCodeOf(rule),
          fixability:
            this.smartFixRefusal === null
              ? 'MANUAL_ACTION_REQUIRED'
              : 'SOURCE_DOCUMENT_UNSAFE_TO_EDIT',
          ...(this.smartFixRefusal === null
            ? { reasonCode: 'SMARTFIX_RULE_NOT_DETERMINISTIC' }
            : {}),
          actionIds: [],
          targetCount: 1,
          fixableTargetCount: 0,
        })),
      ],
      actions: actions.map((rule, index) => ({
        actionId: actionId(index),
        ruleCode: ruleCodeOf(rule),
        actionType: 'SET_RUN_FONT_SIZE',
        targetScope: 'RUN_PROPERTIES',
        nodeId: `main/body/p:${index + 1}/r:1`,
        scriptChannel: 'LATIN',
        before: { kind: 'NUMBER', number: '11', unit: 'POINT' },
        after: { kind: 'NUMBER', number: '12', unit: 'POINT' },
      })),
    };

    // Canonical bytes, the way the real engine serializes: sorted keys and no
    // whitespace, so the hash depends on the content and nothing else.
    const planBytes = Buffer.from(canonicalJson(plan), 'utf8');
    return {
      plan: JSON.parse(planBytes.toString('utf8')) as Record<string, unknown>,
      planBytes,
      planSha256: createHash('sha256').update(planBytes).digest('hex'),
      ruleCount: plan.rules.length,
      actionCount: plan.actions.length,
      refusal: this.smartFixRefusal,
      fixEngineName: this.fixEngineName,
      fixEngineVersion: this.fixEngineVersion,
      capabilityRegistryVersion: this.capabilityRegistryVersion,
      durationMs: 4,
    };
  }

  async applySmartFix(request: ApplySmartFixRequest): Promise<ApplySmartFixResult> {
    this.applyCalls.push(request);

    if (this.smartFixMode === 'unavailable') {
      throw new SmartFixEngineError('ENGINE', null, 'fix engine unreachable');
    }
    if (this.smartFixMode === 'refuse-apply') {
      throw new SmartFixEngineError('DOCUMENT', 'SMARTFIX_SOURCE_CHANGED', 'responded 422');
    }

    // A real, different, valid package: the corrected bytes go through
    // PalCert's own secure ingestion next, and a double that produced
    // something unopenable would hide whether that works (§87).
    const content = correctedDocx(request.planHash);
    const outputSha256 = createHash('sha256').update(content).digest('hex');
    const sourceSha256 = createHash('sha256').update(request.content).digest('hex');
    const actions = (request.plan.actions ?? []) as { actionId: string; ruleCode: string }[];

    const manifest = {
      manifestSchemaVersion: 1,
      engine: { fixEngineName: this.fixEngineName, fixEngineVersion: this.fixEngineVersion },
      planHash: request.planHash,
      sourceSha256,
      outputSha256,
      changedParts: ['word/document.xml'],
      entries: actions.map((action) => ({
        actionId: action.actionId,
        ruleCode: action.ruleCode,
        actionType: 'SET_RUN_FONT_SIZE',
        nodeId: 'main/body/p:1/r:1',
        scriptChannel: 'LATIN',
        before: { kind: 'NUMBER', number: '11', unit: 'POINT' },
        after: { kind: 'NUMBER', number: '12', unit: 'POINT' },
        partName: 'word/document.xml',
      })),
      // The proofs hold: the double changes formatting and nothing else,
      // exactly as the real engine must.
      integrity: proofsFor(sourceSha256),
    };
    const manifestBytes = Buffer.from(canonicalJson(manifest), 'utf8');

    return {
      content,
      outputSha256,
      manifest: JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>,
      manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
      entryCount: manifest.entries.length,
      durationMs: 6,
    };
  }

  async checkReadiness(): Promise<{ ok: boolean; message?: string }> {
    return this.ready ? { ok: true } : { ok: false, message: 'unreachable' };
  }

  reset(): void {
    this.mode = 'normal';
    this.evaluationMode = 'normal';
    this.evaluationResults = null;
    this.analyzerVersion = DOCX_ANALYZER_VERSION;
    this.extraParagraphs = [];
    this.equations = [];
    this.extraFacts = [];
    this.ready = true;
    this.calls.length = 0;
    this.evaluationCalls.length = 0;
    this.smartFixMode = 'normal';
    this.smartFixRefusal = null;
    this.fixEngineVersion = '1.0.0';
    this.capabilityRegistryVersion = CAPABILITY_REGISTRY_VERSION;
    this.planCalls.length = 0;
    this.applyCalls.length = 0;
  }
}

function ruleCodeOf(rule: unknown): string {
  const code = (rule as { ruleCode?: unknown })?.ruleCode;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

function actionId(index: number): string {
  return `a-${String(index + 1).padStart(4, '0')}`;
}

/** Sorted keys, no whitespace: the same canonicalization the engine uses. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return inner;
    const entries = Object.entries(inner as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return Object.fromEntries(entries);
  });
}

/**
 * Four matching digests, derived from the source.
 *
 * They match because the double corrects formatting and nothing else — which
 * is the property the real proofs exist to establish, and the one the database
 * refuses a manifest without.
 */
function proofsFor(sourceSha256: string): Record<string, string> {
  const of = (label: string): string =>
    createHash('sha256').update(`${label}:${sourceSha256}`).digest('hex');
  return {
    sourceVisibleTextHash: of('text'),
    outputVisibleTextHash: of('text'),
    sourceMediaSetHash: of('media'),
    outputMediaSetHash: of('media'),
    sourceFieldInstructionHash: of('fields'),
    outputFieldInstructionHash: of('fields'),
    sourceRelationshipHash: of('rels'),
    outputRelationshipHash: of('rels'),
  };
}

/**
 * One result for one rule definition.
 *
 * Deterministic rules pass; AI-assisted and manual ones resolve to
 * INDETERMINATE with review required, exactly as the real Python engine does.
 * A double that passed everything would hide the whole Phase 7/8 boundary:
 * that a semantic requirement is *unresolved* until a person or a later phase
 * addresses it.
 */
function passResultFor(rule: unknown, factSchemaVersion: number): RuleEvaluationResult {
  const definition = rule as { ruleCode?: unknown; evaluationMode?: unknown; blocking?: unknown };
  const code = definition?.ruleCode;
  const mode =
    definition?.evaluationMode === 'AI_ASSISTED' || definition?.evaluationMode === 'MANUAL'
      ? (definition.evaluationMode as 'AI_ASSISTED' | 'MANUAL')
      : ('DETERMINISTIC' as const);
  const unresolved = mode !== 'DETERMINISTIC';

  return {
    ruleCode: typeof code === 'string' ? code : 'UNKNOWN',
    outcome: unresolved ? 'INDETERMINATE' : 'PASS',
    reasonCode: unresolved
      ? mode === 'AI_ASSISTED'
        ? 'AI_REVIEW_REQUIRED'
        : 'MANUAL_REVIEW_REQUIRED'
      : 'SATISFIED',
    evidenceLevel: unresolved ? 'NONE' : 'DETERMINISTIC',
    requiresReview: unresolved,
    blocking: definition?.blocking === true,
    severity: 'MAJOR',
    evaluationMode: mode,
    counts: {
      matchedFacts: unresolved ? 0 : 1,
      evaluatedFacts: unresolved ? 0 : 1,
      passedFacts: unresolved ? 0 : 1,
      failedFacts: 0,
      indeterminateFacts: 0,
    },
    violations: [],
    totalViolationCount: 0,
    truncated: false,
    engine: {
      engineName: 'palcert-rule-engine',
      engineVersion: '1',
      ruleSchemaVersion: 2,
      factSchemaVersion,
    },
  };
}

/**
 * One failing result for one rule, for tests that need a NON_COMPLIANT report.
 *
 * A failing document is a successfully delivered service, and Phase 11 charges
 * for it exactly as it charges for a compliant one. Proving that needs a real
 * failure to come out of the engine.
 */
export function failResultFor(
  ruleCode: string,
  factSchemaVersion = 1,
  blocking = true,
): RuleEvaluationResult {
  return {
    ruleCode,
    outcome: 'FAIL',
    reasonCode: 'VALUE_MISMATCH',
    evidenceLevel: 'DETERMINISTIC',
    requiresReview: false,
    blocking,
    severity: 'CRITICAL',
    evaluationMode: 'DETERMINISTIC',
    counts: {
      matchedFacts: 1,
      evaluatedFacts: 1,
      passedFacts: 0,
      failedFacts: 1,
      indeterminateFacts: 0,
    },
    violations: [
      {
        reasonCode: 'VALUE_MISMATCH',
        location: {
          locationSchemaVersion: 1,
          nodeId: 'p-1',
          elementType: 'PARAGRAPH',
          ordinal: 1,
        },
        expected: { value: '30', unit: 'MILLIMETRE' },
        actual: { value: '20', unit: 'MILLIMETRE' },
      },
    ],
    totalViolationCount: 1,
    truncated: false,
    engine: {
      engineName: 'palcert-rule-engine',
      engineVersion: '1',
      ruleSchemaVersion: 2,
      factSchemaVersion,
    },
  };
}
