import type {
  DocumentFormat,
  EvaluationResponse,
  AIFormattingTarget,
  SmartFixAIContext,
} from '@palcert/contracts';

/**
 * The document engine, as PalCert's API sees it.
 *
 * A port rather than an HTTP client in the service: the analyzer is a
 * different process in a different language, and everything above this line
 * should be testable without one. The Phase 6 e2e suites run the real thing;
 * unit tests use a double.
 *
 * The contract is deliberately tiny — bytes and a digest in, artifact bytes
 * and counters out. No object key, no bucket, no database id crosses it, so a
 * compromised analyzer has nothing to reach for (§17).
 */

export interface AnalyzeDocumentRequest {
  /** Opaque to the engine. The document version id, for correlation only. */
  readonly documentId: string;
  readonly content: Buffer;
  /** The digest PalCert recorded for these bytes in Phase 5 (§5). */
  readonly expectedSha256: string;
  /**
   * Which analyzer to run (Phase 13 §10).
   *
   * Taken from `DocumentVersion.detectedFormat`, which Phase 5 established by
   * inspecting the bytes — never from a filename, a declared MIME type or
   * anything else a request could choose (§83).
   */
  readonly format: DocumentFormat;
  readonly requestId?: string;
}

export interface AnalyzeDocumentResult {
  /** The artifact exactly as the analyzer serialized it. Never re-encoded. */
  readonly artifact: Buffer;
  readonly artifactSha256: string;
  readonly analyzerName: string;
  readonly analyzerVersion: string;
  readonly factSchemaVersion: number;
  readonly analysisSchemaVersion: number;
  readonly factCount: number;
  readonly warningCount: number;
  readonly warningCodes: readonly string[];
  /**
   * Counters and classifications only: no title, no filename, no text (§71).
   *
   * Strings are admitted because a classification is one — a page's text layer
   * is `NATIVE_TEXT`, not a number — and bounded to a short length, because
   * the summary travels in a response header and reaches logs. A value long
   * enough to be document content is dropped rather than carried.
   */
  readonly summary: Record<string, number | string | boolean>;
  readonly durationMs: number;
}

/**
 * One evaluation, as the orchestrator asks for it.
 *
 * The engine is a pure function of a fact set and a list of published rule
 * definitions. No object key, no bucket, no database id, no session (§31).
 */
export interface EvaluateRulesRequest {
  /** Opaque to the engine. Correlation only; it never resolves it. */
  readonly documentId: string;
  /** The fact set exactly as the stored analysis artifact carries it. */
  readonly factSet: unknown;
  /** Rule definitions exactly as the standard snapshot published them. */
  readonly rules: readonly unknown[];
  readonly requestId?: string;
}

export interface EvaluateRulesResult {
  readonly response: EvaluationResponse;
  readonly durationMs: number;
}

/** What went wrong, in the terms the retry policy needs (§91). */
export type DocumentEngineFailureKind =
  /** The document will fail identically for ever. Do not retry. */
  | 'DOCUMENT'
  /** The engine or the network. Retrying is reasonable. */
  | 'ENGINE';

export class DocumentEngineError extends Error {
  constructor(
    readonly kind: DocumentEngineFailureKind,
    /** The analyzer's own stable code, when it gave one. */
    readonly analysisError: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'DocumentEngineError';
  }
}

export abstract class DocumentEnginePort {
  /**
   * Analyze one document with the analyzer its format calls for (§10, §11).
   *
   * One method rather than one per format: everything above this line —
   * claiming the job, verifying the digest, storing the artifact, waking the
   * checks — is identical, and duplicating it per format is how the two
   * copies start to disagree about what a failed analysis does to a payment.
   */
  abstract analyzeDocument(request: AnalyzeDocumentRequest): Promise<AnalyzeDocumentResult>;
  /**
   * Evaluate published rules against one fact set.
   *
   * PalCert has exactly one rule evaluator, and it is the Python one. A second
   * implementation in NestJS would be a second set of rounding decisions and a
   * second set of bugs for the same measurements (§34).
   */
  abstract evaluateRules(request: EvaluateRulesRequest): Promise<EvaluateRulesResult>;
  /**
   * The analyzer's own property catalogue (Phase 9, §51, §52).
   *
   * Fetched rather than mirrored in TypeScript: the Python catalogue is the
   * single source of truth for what PalCert can measure, and a second hand-kept
   * copy would drift the first time a property was added — showing an
   * institution "not measurable" for something the analyzer measures perfectly
   * well, or worse, the reverse (ADR-0029).
   */
  abstract describeDocxProperties(): Promise<readonly DocxPropertyDescriptor[]>;

  /**
   * What SmartFix would change in one document (Phase 12 §72).
   *
   * Free, and writes nothing. The user reads the result and decides before any
   * money moves, which is the whole reason planning and applying are two
   * calls rather than one.
   */
  abstract planSmartFix(request: PlanSmartFixRequest): Promise<PlanSmartFixResult>;

  /**
   * Apply one approved plan (Phase 12 §57).
   *
   * The engine applies the plan it is given and never a regenerated one, and
   * refuses outright rather than producing a half-corrected document.
   */
  abstract applySmartFix(request: ApplySmartFixRequest): Promise<ApplySmartFixResult>;

  /** Bounded probe for readiness. Must not throw. */
  abstract checkReadiness(): Promise<{ ok: boolean; message?: string }>;
}

/** One measurable DOCX property, as the analyzer describes itself. */
export interface DocxPropertyDescriptor {
  readonly name: string;
  /** Scope kinds this property is emitted under. */
  readonly scopes: readonly string[];
  readonly unit: string | null;
  /** EXACT is read from OOXML; DERIVED is computed under a definition. */
  readonly exactness: 'EXACT' | 'DERIVED';
}

/**
 * One SmartFix plan, as the orchestrator asks for it (Phase 12 §28, §57).
 *
 * The engine reads the document, decides what it could correct, and returns
 * the plan. It is told nothing about where the document lives, what it cost,
 * or who owns it — the same narrow boundary the analyzer draws, for the same
 * reason.
 */
export interface PlanSmartFixRequest {
  readonly signal?: AbortSignal;
  readonly aiTargets?: readonly AIFormattingTarget[];
  readonly includeAIContext?: boolean;
  /** Opaque to the engine. Correlation only. */
  readonly documentId: string;
  readonly content: Buffer;
  /** The digest PalCert recorded for these bytes (§58). */
  readonly expectedSha256: string;
  /** Published rule definitions, each carrying its autofix capability. */
  readonly rules: readonly unknown[];
  /** Everything the plan is bound to: document, analysis, standard, report. */
  readonly source: Record<string, unknown>;
  readonly requestId?: string;
}

export interface PlanSmartFixResult {
  readonly aiContext?: SmartFixAIContext;
  /** The plan document, parsed. */
  readonly plan: Record<string, unknown>;
  /**
   * The plan exactly as the engine serialized it.
   *
   * Kept as bytes for the same reason the analysis artifact is: the plan hash
   * is over these bytes, and re-serializing would produce a different string
   * with a different hash — destroying the property that makes "the plan the
   * user approved" a thing PalCert can prove.
   */
  readonly planBytes: Buffer;
  readonly planSha256: string;
  readonly ruleCount: number;
  readonly actionCount: number;
  /** Set when the document cannot be edited at all. */
  readonly refusal: string | null;
  readonly fixEngineName: string;
  readonly fixEngineVersion: string;
  readonly capabilityRegistryVersion: number;
  readonly durationMs: number;
}

/** One correction, as the orchestrator asks for it (§57). */
export interface ApplySmartFixRequest {
  readonly content: Buffer;
  readonly expectedSourceSha256: string;
  readonly plan: Record<string, unknown>;
  readonly planHash: string;
  readonly requestId?: string;
}

export interface ApplySmartFixResult {
  /** The corrected document. A new file; the original is untouched. */
  readonly content: Buffer;
  readonly outputSha256: string;
  /** Computed from the corrected bytes, never copied from the plan (§110). */
  readonly manifest: Record<string, unknown>;
  readonly manifestSha256: string;
  readonly entryCount: number;
  readonly durationMs: number;
}

/** The engine's refusal code, when it gave one, for the failure the user reads. */
export class SmartFixEngineError extends DocumentEngineError {
  constructor(
    kind: DocumentEngineFailureKind,
    readonly fixError: string | null,
    message: string,
  ) {
    super(kind, fixError, message);
    this.name = 'SmartFixEngineError';
  }
}
