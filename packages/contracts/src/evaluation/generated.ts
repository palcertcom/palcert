/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: contracts/schemas/evaluation.schema.json
 * Regenerate: pnpm --filter @palcert/contracts run generate:evaluation
 *
 * Editing this by hand would reintroduce exactly the drift the generation step
 * exists to prevent.
 */
/**
 * An exact decimal number carried as a string. Numbers cross this boundary as strings rather than JSON numbers because JSON numbers are read back as binary floats, and 0.1 + 0.2 is not 0.3 in a measurement that decides whether a thesis complies. Parsed with Decimal in Python and compared as an exact rational.
 *
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "DecimalString".
 */
export type DecimalString = string;
/**
 * 1: the Phase 4 vocabulary. 2: adds the ENDNOTE and TEXTBOX element types, which WordprocessingML stories require and which version 1 cannot express without misfiling note or text-box content as ordinary body paragraphs. Nothing else differs, and a version 1 fact set remains valid for ever.
 *
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "FactSchemaVersion".
 */
export type FactSchemaVersion = number;
/**
 * A PalCert canonical unit. Identical to the Phase 3 RuleUnit vocabulary; a second, incompatible unit list would be the fastest route to a wrong measurement.
 *
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "Unit".
 */
export type Unit =
  | 'COUNT'
  | 'MILLIMETRE'
  | 'CENTIMETRE'
  | 'INCH'
  | 'POINT'
  | 'PIXEL'
  | 'PERCENT'
  | 'LINES'
  | 'WORDS'
  | 'CHARACTERS'
  | 'PAGES'
  | 'MEGABYTE'
  | 'DPI';
/**
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "RuleScopeKind".
 */
export type RuleScopeKind = 'DOCUMENT' | 'SECTION' | 'ELEMENT' | 'METADATA' | 'PAGE';
/**
 * ENDNOTE and TEXTBOX were introduced with fact schema version 2 (Phase 6). They are valid in a rule scope at any version, but a DocumentFactSet declaring factSchemaVersion 1 may not use them: see FactSchemaVersion and the version-aware check in both validators.
 *
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "RuleElementType".
 */
export type RuleElementType =
  | 'HEADING'
  | 'PARAGRAPH'
  | 'TABLE'
  | 'FIGURE'
  | 'CAPTION'
  | 'LIST'
  | 'FOOTNOTE'
  | 'ENDNOTE'
  | 'TEXTBOX'
  | 'CITATION'
  | 'REFERENCE_ENTRY'
  | 'EQUATION'
  | 'HEADER'
  | 'FOOTER';
/**
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "RulePageSelector".
 */
export type RulePageSelector = 'ALL' | 'FIRST' | 'LAST' | 'ODD' | 'EVEN';
/**
 * Where an observation was made. Deliberately the same shape as the Phase 3 RuleScope, so selecting facts for a rule is structural matching on identifying fields — never string-parsing a ruleCode such as BODY.FONT.SIZE.
 *
 * Expressed as fully-specified oneOf branches rather than if/then: each variant is closed, so a DOCUMENT scope carrying an elementType is rejected rather than quietly ignored, and both the TypeScript and Python validators interpret it identically.
 *
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "FactScope".
 */
export type FactScope =
  | {
      kind: 'DOCUMENT';
      property: string;
    }
  | {
      kind: 'SECTION';
      sectionKey: string;
      property: string;
    }
  | {
      kind: 'ELEMENT';
      elementType: RuleElementType;
      level?: number;
      property: string;
    }
  | {
      kind: 'METADATA';
      field: string;
    }
  | {
      kind: 'PAGE';
      pages: RulePageSelector;
      property: string;
    };
/**
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "FactValueType".
 */
export type FactValueType =
  'STRING' | 'NUMBER' | 'BOOLEAN' | 'ENUM' | 'STRING_LIST' | 'NUMBER_LIST' | 'STRUCTURED';
/**
 * An observed value, discriminated on `type`. Numbers are decimal strings (see DecimalString). STRUCTURED exists so an extractor can record a composite observation without inventing a new fact type, but no Phase 4 operator consumes it — it is carried, not interpreted.
 *
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "FactValue".
 */
export type FactValue =
  | {
      type: 'STRING';
      text: string;
    }
  | {
      type: 'NUMBER';
      number: DecimalString;
    }
  | {
      type: 'BOOLEAN';
      boolean: boolean;
    }
  | {
      type: 'ENUM';
      enumValue: string;
    }
  | {
      type: 'STRING_LIST';
      /**
       * @maxItems 1000
       */
      values: string[];
    }
  | {
      type: 'NUMBER_LIST';
      /**
       * @maxItems 1000
       */
      numbers: DecimalString[];
    }
  | {
      type: 'STRUCTURED';
      /**
       * Extractor-specific composite observation. Deliberately open: no Phase 4 operator interprets it.
       */
      structured: {};
    };
/**
 * How much the extractor could see of one fact domain. This is the distinction between "there are no figures" and "we could not tell whether there are figures", which changes the correct verdict.
 *
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "CoverageStatus".
 */
export type CoverageStatus = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
/**
 * PASS/FAIL are deterministic verdicts. NOT_APPLICABLE means the rule legitimately does not apply. INDETERMINATE means the evidence or the evaluator cannot decide — never a disguised PASS. ERROR means the engine itself failed, and is never a disguised FAIL.
 *
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "EvaluationOutcome".
 */
export type EvaluationOutcome = 'PASS' | 'FAIL' | 'NOT_APPLICABLE' | 'INDETERMINATE' | 'ERROR';
/**
 * What kind of evidence produced this result. Present from Phase 4 so a later AI phase can add AI_PROVISIONAL without redesigning the result: AI output must never silently become authoritative certification evidence.
 *
 * ADVISORY (Phase 18, Checkpoint 15) is the same refusal for heuristic evidence. A rule whose facts were inferred rather than read carries it, and such a rule is always INDETERMINATE: the observation is reported, and it never becomes the PASS or FAIL an exact rule produces. DETERMINISTIC therefore keeps its original meaning exactly — every fact behind the verdict was read from the document rather than recognized in it.
 *
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "EvidenceLevel".
 */
export type EvidenceLevel =
  'NONE' | 'DETERMINISTIC' | 'ADVISORY' | 'AI_PROVISIONAL' | 'HUMAN_CONFIRMED';
/**
 * Stable, machine-readable reason. Downstream code must never parse English message text.
 *
 * ADVISORY_EVIDENCE_ONLY says the rule matched facts PalCert inferred rather than read. It is a statement about the evidence class, not about the document: it never means the document is wrong, and it never means the document is right.
 *
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "ReasonCode".
 */
export type ReasonCode =
  | 'SATISFIED'
  | 'VALUE_MISMATCH'
  | 'OUTSIDE_TOLERANCE'
  | 'BELOW_MINIMUM'
  | 'ABOVE_MAXIMUM'
  | 'OUTSIDE_RANGE'
  | 'REQUIRED_VALUE_MISSING'
  | 'FORBIDDEN_VALUE_PRESENT'
  | 'PATTERN_MISMATCH'
  | 'NOT_IN_ALLOWED_SET'
  | 'IN_FORBIDDEN_SET'
  | 'NO_COMPLETE_EVIDENCE'
  | 'NO_MATCHING_FACTS'
  | 'SCOPE_NOT_PRESENT'
  | 'UNIT_INCOMPATIBLE'
  | 'UNIT_MISSING'
  | 'VALUE_TYPE_INCOMPATIBLE'
  | 'EVALUATOR_NOT_SUPPORTED'
  | 'AI_REVIEW_REQUIRED'
  | 'MANUAL_REVIEW_REQUIRED'
  | 'FACT_SCHEMA_UNSUPPORTED'
  | 'RULE_SCHEMA_UNSUPPORTED'
  | 'RESOURCE_LIMIT_EXCEEDED'
  | 'ADVISORY_EVIDENCE_ONLY'
  | 'INTERNAL_ERROR';

/**
 * The authoritative wire contract shared by the TypeScript API and the Python document engine. TypeScript types are GENERATED from this file (packages/contracts/src/evaluation/generated.ts); Python validates against it directly. Neither language hand-maintains a parallel definition, so the two cannot drift silently.
 */
export interface PalCertDeterministicEvaluationContracts {
  [k: string]: unknown;
}
/**
 * Where in the document something was observed. `nodeId` is the only required locator: page number is frequently unknown during structural DOCX extraction, and requiring it would force every extractor to invent one.
 *
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "Location".
 */
export interface Location {
  locationSchemaVersion: number;
  nodeId: string;
  /**
   * 1-based page number, when the extractor knows it. Absent means unknown, never page zero.
   */
  page?: number;
  sectionKey?: string;
  elementType?: RuleElementType;
  /**
   * 1-based position among siblings of the same kind, for stable ordering and for report text such as "the 3rd table".
   */
  ordinal?: number;
  /**
   * Structural path from the document root, e.g. ["body", "p:17", "r:2"]. Independent of pagination.
   *
   * @maxItems 32
   */
  path?: string[];
}
/**
 * How the observation was obtained. `confidence` is deliberately optional and must be omitted for exact extraction: inventing 1.0 for an OOXML attribute read would make a meaningless number look like a measured one.
 *
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "FactProvenance".
 */
export interface FactProvenance {
  sourceKind: 'OOXML' | 'PDF_TEXT' | 'PDF_LAYOUT' | 'HEURISTIC' | 'SYNTHETIC';
  confidence?: DecimalString;
  note?: string;
}
/**
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "DocumentFact".
 */
export interface DocumentFact {
  scope: FactScope;
  value: FactValue;
  unit?: Unit;
  location?: Location;
  provenance?: FactProvenance;
}
/**
 * Coverage for a family of facts. The selector is matched most-specific-first: an entry naming kind+elementType+property beats one naming only kind.
 *
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "CoverageEntry".
 */
export interface CoverageEntry {
  kind: RuleScopeKind;
  elementType?: RuleElementType;
  sectionKey?: string;
  property?: string;
  field?: string;
  status: CoverageStatus;
  note?: string;
}
/**
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "Extractor".
 */
export interface Extractor {
  name: string;
  version: string;
}
/**
 * Everything a document parser hands the rule engine. The engine consumes only this — never python-docx objects, OOXML nodes, PDF parser handles or filesystem paths — which is what keeps it a pure, testable library.
 *
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "DocumentFactSet".
 */
export interface DocumentFactSet {
  factSchemaVersion: FactSchemaVersion;
  /**
   * Opaque to the engine. A synthetic string in tests; a PalCert document id in production. The engine never resolves it against a database.
   */
  documentId: string;
  extractor: Extractor;
  /**
   * @maxItems 500
   */
  coverage: CoverageEntry[];
  /**
   * @maxItems 100000
   */
  facts: DocumentFact[];
}
/**
 * A value as evidence, with the unit it was expressed in. Both the raw value and the normalized comparison value are carried so a report can show what the author wrote AND what was compared.
 *
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "MeasuredValue".
 */
export interface MeasuredValue {
  value: string;
  unit?: Unit;
  normalizedValue?: DecimalString;
  normalizedUnit?: Unit;
}
/**
 * Machine-readable evidence for one failing observation. Deliberately carries no natural-language prose: report and AI layers turn this into an explanation later.
 *
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "Violation".
 */
export interface Violation {
  reasonCode: ReasonCode;
  location?: Location;
  expected?: MeasuredValue;
  actual: MeasuredValue;
  tolerance?: DecimalString;
}
/**
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "EvaluationCounts".
 */
export interface EvaluationCounts {
  matchedFacts: number;
  evaluatedFacts: number;
  passedFacts: number;
  failedFacts: number;
  indeterminateFacts: number;
}
/**
 * Recorded on every result for auditability. `engineVersion` is an explicit evaluation-engine version, deliberately not the application git commit: the engine's behaviour must be identifiable independently of unrelated deployments.
 *
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "EngineInfo".
 */
export interface EngineInfo {
  engineName: string;
  engineVersion: string;
  ruleSchemaVersion: number;
  factSchemaVersion: FactSchemaVersion;
}
/**
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "RuleEvaluationResult".
 */
export interface RuleEvaluationResult {
  ruleCode: string;
  outcome: EvaluationOutcome;
  reasonCode: ReasonCode;
  evidenceLevel: EvidenceLevel;
  /**
   * True when a human or a later AI phase must resolve this rule before a final compliance decision. Phase 4 sets it for every AI_ASSISTED and MANUAL rule.
   */
  requiresReview: boolean;
  blocking: boolean;
  severity: 'INFO' | 'MINOR' | 'MAJOR' | 'CRITICAL';
  evaluationMode: 'DETERMINISTIC' | 'AI_ASSISTED' | 'MANUAL';
  operator?: string;
  counts: EvaluationCounts;
  /**
   * @maxItems 1000
   */
  violations: Violation[];
  /**
   * The true number of violations, which may exceed the number returned when truncated.
   */
  totalViolationCount: number;
  truncated: boolean;
  engine: EngineInfo;
}
/**
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "EvaluationRequest".
 */
export interface EvaluationRequest {
  factSet: DocumentFactSet;
  /**
   * Phase 3 rule definitions, exactly as published. The engine does not reshape them.
   *
   * @maxItems 1000
   */
  rules: {}[];
}
/**
 * This interface was referenced by `PalCertDeterministicEvaluationContracts`'s JSON-Schema
 * via the `definition` "EvaluationResponse".
 */
export interface EvaluationResponse {
  documentId: string;
  engine: EngineInfo;
  /**
   * @maxItems 1000
   */
  results: RuleEvaluationResult[];
}
