/**
 * The SmartFix contracts (Phase 12).
 *
 * Types are generated from `contracts/schemas/smartfix.schema.json`, the same
 * file the Python mutation engine validates against. See ADR-0029 for why the
 * schema, and not either language's model, is the source of truth.
 */
export type {
  ChangeManifest,
  ChangeManifestEntry,
  FixAction,
  FixActionType,
  FixBooleanValue,
  FixEngineRequest,
  FixEngineResponse,
  FixEngineVersion,
  FixNumberValue,
  FixStringValue,
  FixTargetScope,
  FixValue,
  FixabilityStatus,
  IntegrityProofs,
  PlannedRule,
  ScriptChannel,
  SmartFixPlan,
} from './generated.js';

export * from './schema.generated.js';
export * from './constants.js';
export * from './capability.js';
export * from './validator.js';
export * from './requests.js';
export * from './registry.generated.js';
