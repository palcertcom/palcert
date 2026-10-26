/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: contracts/schemas/smartfix.schema.json
 * Regenerate: pnpm --filter @palcert/contracts run generate:evaluation
 *
 * Editing this by hand would reintroduce exactly the drift the generation step
 * exists to prevent.
 */
/**
 * An exact decimal carried as a string. A JSON number would be read back as a binary float, and a font size that drifts is a formatting change nobody asked for.
 *
 * This interface was referenced by `PalCertSmartFixContracts`'s JSON-Schema
 * via the `definition` "DecimalString".
 */
export type DecimalString = string;
/**
 * This interface was referenced by `PalCertSmartFixContracts`'s JSON-Schema
 * via the `definition` "Sha256Hex".
 */
export type Sha256Hex = string;
/**
 * A Phase 6 structural locator, such as main/body/p:17/r:2. A locator, never a selector: nothing evaluates it as XPath and nothing accepts one from a client to address a document.
 *
 * This interface was referenced by `PalCertSmartFixContracts`'s JSON-Schema
 * via the `definition` "NodeId".
 */
export type NodeId = string;
/**
 * The mutation engine's own semantic version, deliberately separate from the application version, the git SHA and the DOCX analyzer version. A behaviour-changing transformation requires a decision about this number.
 *
 * This interface was referenced by `PalCertSmartFixContracts`'s JSON-Schema
 * via the `definition` "FixEngineVersion".
 */
export type FixEngineVersion = string;
/**
 * Which layer of the document an action edits.
 *
 * This interface was referenced by `PalCertSmartFixContracts`'s JSON-Schema
 * via the `definition` "FixTargetScope".
 */
export type FixTargetScope = 'SECTION_PROPERTIES' | 'PARAGRAPH_PROPERTIES' | 'RUN_PROPERTIES';
/**
 * Which OOXML script channel a run-level action writes. WordprocessingML keeps Latin, complex-script and East Asian typography in separate attributes and elements, and writing the Latin channel for Arabic text changes nothing a reader can see while claiming the fix was applied. LATIN covers w:rFonts/@w:ascii and @w:hAnsi, w:sz, w:b and w:i; COMPLEX_SCRIPT covers @w:cs, w:szCs, w:bCs and w:iCs.
 *
 * This interface was referenced by `PalCertSmartFixContracts`'s JSON-Schema
 * via the `definition` "ScriptChannel".
 */
export type ScriptChannel = 'LATIN' | 'COMPLEX_SCRIPT' | 'EAST_ASIAN';
/**
 * The closed vocabulary of transformations this engine can perform. Every one is a formatting property change on an existing element: nothing here creates, deletes, moves or rewrites content, because that is where academic meaning lives.
 *
 * This interface was referenced by `PalCertSmartFixContracts`'s JSON-Schema
 * via the `definition` "FixActionType".
 */
export type FixActionType =
  | 'SET_RUN_FONT_FAMILY'
  | 'SET_RUN_FONT_SIZE'
  | 'SET_RUN_BOLD'
  | 'SET_RUN_ITALIC'
  | 'SET_RUN_UNDERLINE'
  | 'SET_PARAGRAPH_ALIGNMENT'
  | 'SET_PARAGRAPH_LINE_SPACING'
  | 'SET_PARAGRAPH_SPACING_BEFORE'
  | 'SET_PARAGRAPH_SPACING_AFTER'
  | 'SET_PARAGRAPH_INDENT_START'
  | 'SET_PARAGRAPH_INDENT_END'
  | 'SET_PARAGRAPH_FIRST_LINE_INDENT'
  | 'SET_PARAGRAPH_HANGING_INDENT'
  | 'SET_SECTION_MARGIN_TOP'
  | 'SET_SECTION_MARGIN_BOTTOM'
  | 'SET_SECTION_MARGIN_LEFT'
  | 'SET_SECTION_MARGIN_RIGHT'
  | 'SET_SECTION_HEADER_DISTANCE'
  | 'SET_SECTION_FOOTER_DISTANCE';
/**
 * A value an action sets or expects, as a closed three-way union. Written as alternatives rather than as one object with optional fields so that a numeric target can never be compared against a string by accident: a NUMBER value has a number and nothing else, and both runtimes reject the mixture.
 *
 * This interface was referenced by `PalCertSmartFixContracts`'s JSON-Schema
 * via the `definition` "FixValue".
 */
export type FixValue = FixNumberValue | FixStringValue | FixBooleanValue;
/**
 * Why a failing rule can or cannot be corrected automatically.
 *
 * This interface was referenced by `PalCertSmartFixContracts`'s JSON-Schema
 * via the `definition` "FixabilityStatus".
 */
export type FixabilityStatus =
  | 'FIXABLE'
  | 'PARTIALLY_FIXABLE'
  | 'NOT_SUPPORTED'
  | 'MANUAL_ACTION_REQUIRED'
  | 'INSUFFICIENT_LOCATION_EVIDENCE'
  | 'AMBIGUOUS_TARGET'
  | 'SOURCE_DOCUMENT_UNSAFE_TO_EDIT';

/**
 * The authoritative wire contract for deterministic DOCX correction, shared by the TypeScript API and the Python document engine. TypeScript types are GENERATED from this file (packages/contracts/src/smartfix/generated.ts); Python validates against it directly. Every action vocabulary here is CLOSED: additionalProperties is false and an unknown action type is rejected rather than ignored, because an action PalCert does not understand must never be executed against somebody's thesis.
 */
export interface PalCertSmartFixContracts {
  [k: string]: unknown;
}
export interface FixNumberValue {
  kind: 'NUMBER';
  number: DecimalString;
  /**
   * The PalCert canonical unit of the value.
   */
  unit?: 'POINT' | 'MILLIMETRE' | 'CENTIMETRE' | 'INCH' | 'COUNT' | 'PERCENT' | 'LINES';
}
export interface FixStringValue {
  kind: 'STRING';
  text: string;
}
export interface FixBooleanValue {
  kind: 'BOOLEAN';
  flag: boolean;
}
/**
 * One deterministic property change on one element. There is no executable DSL here and there never will be: no XPath, no regular expression, no XML fragment and no script, from a user, an organization, a rule or a model. `before` is the effective value the planner observed; the mutator re-checks it and refuses rather than editing a document that has changed underneath the plan.
 *
 * This interface was referenced by `PalCertSmartFixContracts`'s JSON-Schema
 * via the `definition` "FixAction".
 */
export interface FixAction {
  /**
   * Stable within a plan, so a manifest entry can name the action it came from.
   */
  actionId: string;
  /**
   * The standard rule that requires this change.
   */
  ruleCode: string;
  actionType: FixActionType;
  targetScope: FixTargetScope;
  nodeId: NodeId;
  /**
   * @maxItems 32
   */
  structuralPath?: string[];
  /**
   * Required for SECTION_PROPERTIES actions.
   */
  sectionIndex?: number;
  scriptChannel?: ScriptChannel;
  before?: FixValue;
  after: FixValue;
}
/**
 * One failing rule, and what SmartFix can do about it.
 *
 * This interface was referenced by `PalCertSmartFixContracts`'s JSON-Schema
 * via the `definition` "PlannedRule".
 */
export interface PlannedRule {
  ruleCode: string;
  fixability: FixabilityStatus;
  /**
   * A stable code explaining a non-FIXABLE status, for the UI to translate.
   */
  reasonCode?: string;
  /**
   * @maxItems 100000
   */
  actionIds: string[];
  /**
   * How many elements must change for the rule to pass.
   */
  targetCount: number;
  /**
   * How many of them SmartFix can change safely.
   */
  fixableTargetCount: number;
  autofix?: 'NONE' | 'SAFE' | 'ADVANCED';
  evaluationMode?: 'DETERMINISTIC' | 'AI_ASSISTED' | 'MANUAL';
}
/**
 * Exactly what PalCert intends to change, bound to exactly the artifacts it was computed from. A plan is free, immutable and hashed; execution uses the approved plan and never a regenerated one.
 *
 * This interface was referenced by `PalCertSmartFixContracts`'s JSON-Schema
 * via the `definition` "SmartFixPlan".
 */
export interface SmartFixPlan {
  planSchemaVersion: number;
  source: {
    checkId?: string;
    checkRunId?: string;
    documentVersionId: string;
    documentSha256: Sha256Hex;
    analysisArtifactSha256: Sha256Hex;
    standardVersionId: string;
    standardContentHash: string;
    reportHash: Sha256Hex;
    ruleSchemaVersion: number;
    factSchemaVersion: number;
  };
  engine: {
    fixEngineName: string;
    fixEngineVersion: FixEngineVersion;
    capabilityRegistryVersion: number;
  };
  /**
   * Set when the source document cannot be edited at all — tracked changes, document protection or a digital signature. The plan then carries no actions, and says why in a code the UI can translate.
   */
  refusal?: {
    code:
      | 'SMARTFIX_TRACKED_CHANGES_UNSUPPORTED'
      | 'SMARTFIX_DOCUMENT_PROTECTED'
      | 'SMARTFIX_SIGNED_DOCUMENT_UNSUPPORTED'
      | 'SMARTFIX_SOURCE_FORMAT_UNSUPPORTED';
  };
  /**
   * @maxItems 5000
   */
  rules: PlannedRule[];
  /**
   * @maxItems 100000
   */
  actions: FixAction[];
}
/**
 * One change that was actually applied, verified against the corrected document. Deliberately carries no paragraph text: a formatting change is described by where it happened and what the value was, and storing the sentence would be storing the thesis.
 *
 * This interface was referenced by `PalCertSmartFixContracts`'s JSON-Schema
 * via the `definition` "ChangeManifestEntry".
 */
export interface ChangeManifestEntry {
  actionId: string;
  ruleCode: string;
  actionType: FixActionType;
  nodeId: NodeId;
  scriptChannel?: ScriptChannel;
  sectionIndex?: number;
  before: FixValue;
  after: FixValue;
  /**
   * The package part the change was written to.
   */
  partName?: string;
}
/**
 * Machine proofs that the transformation changed formatting and nothing else. These are safety evidence, not user-facing content: each is a digest over a canonical projection of the package, computed identically before and after.
 *
 * This interface was referenced by `PalCertSmartFixContracts`'s JSON-Schema
 * via the `definition` "IntegrityProofs".
 */
export interface IntegrityProofs {
  sourceVisibleTextHash: Sha256Hex;
  outputVisibleTextHash: Sha256Hex;
  sourceMediaSetHash: Sha256Hex;
  outputMediaSetHash: Sha256Hex;
  sourceFieldInstructionHash: Sha256Hex;
  outputFieldInstructionHash: Sha256Hex;
  sourceRelationshipHash: Sha256Hex;
  outputRelationshipHash: Sha256Hex;
}
/**
 * What SmartFix actually changed, with the proofs that it changed nothing else. Produced by the mutation engine from the corrected package, never copied from the plan: a planned action is an intention, and only the output is evidence.
 *
 * This interface was referenced by `PalCertSmartFixContracts`'s JSON-Schema
 * via the `definition` "ChangeManifest".
 */
export interface ChangeManifest {
  manifestSchemaVersion: number;
  engine: {
    fixEngineName: string;
    fixEngineVersion: FixEngineVersion;
  };
  planHash: Sha256Hex;
  sourceSha256: Sha256Hex;
  outputSha256: Sha256Hex;
  /**
   * @maxItems 100000
   */
  entries: ChangeManifestEntry[];
  /**
   * Package parts the mutation rewrote. Everything else is byte-identical.
   *
   * @maxItems 500
   */
  changedParts: string[];
  integrity: IntegrityProofs;
}
/**
 * What the Node worker sends the document engine. No storage credential, no bucket, no object key and no database identifier crosses this boundary — the bytes travel as the request body and this is the metadata. `planHash` is recomputed by the engine over the plan it was handed; a mismatch refuses the mutation instead of applying a plan nobody approved.
 *
 * This interface was referenced by `PalCertSmartFixContracts`'s JSON-Schema
 * via the `definition` "FixEngineRequest".
 */
export interface FixEngineRequest {
  expectedSourceSha256: Sha256Hex;
  plan: SmartFixPlan;
  planHash: Sha256Hex;
}
/**
 * This interface was referenced by `PalCertSmartFixContracts`'s JSON-Schema
 * via the `definition` "FixEngineResponse".
 */
export interface FixEngineResponse {
  outputSha256: Sha256Hex;
  outputSizeBytes: number;
  manifest: ChangeManifest;
  manifestHash: Sha256Hex;
}
