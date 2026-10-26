/**
 * The deterministic evaluation contracts (Phase 4).
 *
 * Types are generated from `contracts/schemas/evaluation.schema.json`, which
 * the Python engine validates against directly. See ADR-0029.
 *
 * `RuleScopeKind`, `RuleElementType` and `RulePageSelector` are deliberately
 * NOT re-exported here: they already exist in the Phase 3 standards catalogue,
 * and shadowing them would let two definitions of the same vocabulary drift.
 * `evaluation-parity.spec.ts` asserts the schema's copies match the Phase 3
 * originals exactly, which is a stronger guarantee than an alias would be.
 */
export type {
  CoverageEntry,
  CoverageStatus,
  DecimalString,
  DocumentFact,
  DocumentFactSet,
  EngineInfo,
  EvaluationCounts,
  EvaluationOutcome,
  EvaluationRequest,
  EvaluationResponse,
  EvidenceLevel,
  Extractor,
  FactProvenance,
  FactSchemaVersion,
  FactScope,
  FactValue,
  FactValueType,
  Location,
  MeasuredValue,
  ReasonCode,
  RuleEvaluationResult,
  Unit as FactUnit,
  Violation,
} from './generated.js';

export * from './schema.generated.js';
export * from './validator.js';
export * from './constants.js';
