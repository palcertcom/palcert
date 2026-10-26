/**
 * Runtime constants for the SmartFix contracts (Phase 12).
 *
 * The generated types describe the *shape* of a plan; these describe the
 * *policy* — which versions exist, which operators yield a deterministic
 * target, and why a failing rule was left alone. Both runtimes need the same
 * answers, so `smartfix-parity.spec.ts` asserts every value here against the
 * JSON Schema and against the Python mirror.
 */

import type { RuleOperator } from '../standards/rule-schema.js';
import { SMARTFIX_CAPABILITY_REGISTRY } from './registry.generated.js';

/**
 * The mutation engine's own version.
 *
 * Deliberately separate from the application version, the git SHA and the
 * DOCX analyzer version: a change to how a document is *transformed* is a
 * different kind of event from a change to how it is *read*, and a stored
 * manifest has to say which transformer produced it. Bump it whenever the
 * bytes this engine writes for the same plan would differ.
 */
export const SMARTFIX_ENGINE_NAME: string = SMARTFIX_CAPABILITY_REGISTRY.engine.name;
export const SMARTFIX_ENGINE_VERSION: string = SMARTFIX_CAPABILITY_REGISTRY.engine.version;

/**
 * The capability registry's version.
 *
 * A plan records it so that a plan approved yesterday is never executed under
 * a registry that has since learned to change more of the user's document
 * than they were shown.
 */
export const CAPABILITY_REGISTRY_VERSION: number = SMARTFIX_CAPABILITY_REGISTRY.registryVersion;

/** The plan and manifest schema versions this release writes. */
export const SMARTFIX_PLAN_SCHEMA_VERSION: number = SMARTFIX_CAPABILITY_REGISTRY.planSchemaVersion;
export const SMARTFIX_MANIFEST_SCHEMA_VERSION: number =
  SMARTFIX_CAPABILITY_REGISTRY.manifestSchemaVersion;

/**
 * Operators that name exactly one correct value, and those that do not.
 *
 * SmartFix has to know what "fixed" means before it edits anything. `EQUALS`
 * names one value; `GREATER_THAN_OR_EQUAL` names a boundary reachable without
 * overshooting. `IN` names a set and `MATCHES_PATTERN` names a language —
 * choosing a member of either would be PalCert deciding what the author's
 * document should say, which is precisely the line this phase does not cross.
 * Those become AMBIGUOUS_TARGET and are shown to the user as manual work.
 *
 * `GREATER_THAN` and `LESS_THAN` are excluded on purpose even though they look
 * numeric: their nearest satisfying value depends on a step size nobody
 * declared, so "just past the boundary" would be an invention.
 */
export const DETERMINISTIC_TARGET_OPERATORS = SMARTFIX_CAPABILITY_REGISTRY.operatorPolicy
  .deterministic as readonly RuleOperator[];

export const AMBIGUOUS_TARGET_OPERATORS = SMARTFIX_CAPABILITY_REGISTRY.operatorPolicy
  .ambiguous as readonly RuleOperator[];

/**
 * Operators SmartFix never acts on at all.
 *
 * `EXISTS` fails because something the standard requires is missing, and the
 * only way to satisfy it is to write content. `NOT_EXISTS` fails because
 * something is present, and the only way to satisfy it is to delete content.
 * Either one would change what the document says.
 */
export const CONTENT_CHANGE_OPERATORS = SMARTFIX_CAPABILITY_REGISTRY.operatorPolicy
  .contentChange as readonly RuleOperator[];

/** Why a failing rule was not planned, or was planned only in part. */
export const SmartFixReasonCode = {
  /** The rule's property is outside the capability registry. */
  PROPERTY_NOT_SUPPORTED: 'SMARTFIX_PROPERTY_NOT_SUPPORTED',
  /** The rule's scope kind is not one SmartFix can address structurally. */
  SCOPE_NOT_SUPPORTED: 'SMARTFIX_SCOPE_NOT_SUPPORTED',
  /** The operator does not name a single correct value. */
  OPERATOR_AMBIGUOUS: 'SMARTFIX_OPERATOR_AMBIGUOUS',
  /** Satisfying the rule would mean writing or deleting content. */
  CONTENT_CHANGE_REQUIRED: 'SMARTFIX_CONTENT_CHANGE_REQUIRED',
  /** The rule is AI-assisted or manual; only deterministic rules are fixed. */
  RULE_NOT_DETERMINISTIC: 'SMARTFIX_RULE_NOT_DETERMINISTIC',
  /** The rule's declared autofix capability is NONE or ADVANCED. */
  AUTOFIX_NOT_SAFE: 'SMARTFIX_AUTOFIX_NOT_SAFE',
  /** A count of words, pages, tables or figures is an outcome, not a setting. */
  COUNT_NOT_EDITABLE: 'SMARTFIX_COUNT_NOT_EDITABLE',
  /** Pagination is produced by a layout engine PalCert does not run. */
  PAGINATION_NOT_EDITABLE: 'SMARTFIX_PAGINATION_NOT_EDITABLE',
  /** The violations do not identify which elements to change. */
  LOCATION_EVIDENCE_MISSING: 'SMARTFIX_LOCATION_EVIDENCE_MISSING',
  /** The expected value cannot be expressed as a document property value. */
  EXPECTED_VALUE_UNUSABLE: 'SMARTFIX_EXPECTED_VALUE_UNUSABLE',
  /**
   * The correct value cannot be written into OOXML exactly.
   *
   * WordprocessingML stores page geometry in twips, so a margin in
   * millimetres almost never lands on a whole one. Where the nearest
   * representable value would still fail the rule, SmartFix leaves the
   * document alone rather than making a change that looks like a fix and
   * fails the recheck.
   */
  TARGET_NOT_REPRESENTABLE: 'SMARTFIX_TARGET_NOT_REPRESENTABLE',
  /** Document metadata is not corrected in this phase. */
  METADATA_NOT_SUPPORTED: 'SMARTFIX_METADATA_NOT_SUPPORTED',
  /**
   * The rule names an element type SmartFix must not edit — or names none.
   *
   * Capability matching asks "which scope kind, which property", never "which
   * element type", so a `lineSpacing` capability answers for any element a
   * rule points at. That is right for a paragraph and wrong for a citation.
   * A rule that names no element type at all is refused by the same code,
   * because an unnamed element type is not a permission.
   */
  ELEMENT_TYPE_NOT_EDITABLE: 'SMARTFIX_ELEMENT_TYPE_NOT_EDITABLE',
} as const;

export type SmartFixReasonCode = (typeof SmartFixReasonCode)[keyof typeof SmartFixReasonCode];

/**
 * Every reason code, read from the shared registry.
 *
 * The named constants above are for writing code against; this is the
 * vocabulary the UI has to have a translation for, and it is the registry's
 * to declare so the Python planner cannot emit a thirteenth code the UI would
 * show the user untranslated.
 */
export const SMARTFIX_REASON_CODES = SMARTFIX_CAPABILITY_REGISTRY.reasonCodes
  .values as readonly SmartFixReasonCode[];

/**
 * Element types SmartFix never edits, whatever the rule says.
 *
 * Read from the shared registry rather than retyped, so the API's preview and
 * the Python planner cannot disagree about what the user was promised. The
 * list is a *separate axis* from the capability table: a property being
 * supported says nothing about the element it would be applied to.
 */
export const FORBIDDEN_FIX_ELEMENT_TYPES = SMARTFIX_CAPABILITY_REGISTRY.elementTypePolicy
  .forbidden as readonly string[];

/** The reason code a forbidden or unnamed element type is refused with. */
export const FORBIDDEN_ELEMENT_TYPE_REASON = SMARTFIX_CAPABILITY_REGISTRY.elementTypePolicy
  .reasonCode as SmartFixReasonCode;

/**
 * Why the source document cannot be edited at all.
 *
 * A refusal is a property of the *document*, not of any one rule, so it is
 * recorded once on the plan and the plan carries no actions.
 */
export const SmartFixRefusalCode = {
  /** Editing a document under revision marks would corrupt the review. */
  TRACKED_CHANGES: 'SMARTFIX_TRACKED_CHANGES_UNSUPPORTED',
  /** The author asked Word to forbid editing; PalCert honours that. */
  PROTECTED: 'SMARTFIX_DOCUMENT_PROTECTED',
  /** Any edit would invalidate the signature, which is the signature working. */
  SIGNED: 'SMARTFIX_SIGNED_DOCUMENT_UNSUPPORTED',
  /** Only DOCX is corrected in this phase. */
  FORMAT: 'SMARTFIX_SOURCE_FORMAT_UNSUPPORTED',
} as const;

export type SmartFixRefusalCode = (typeof SmartFixRefusalCode)[keyof typeof SmartFixRefusalCode];

export const SMARTFIX_REFUSAL_CODES: readonly SmartFixRefusalCode[] =
  Object.values(SmartFixRefusalCode);
