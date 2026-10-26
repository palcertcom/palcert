/**
 * The SmartFix capability registry (§13).
 *
 * One table decides what SmartFix can change, and it lives in
 * `contracts/registries/smartfix-capabilities.json` — read directly by the
 * Python mutation engine, generated into `registry.generated.ts` for this
 * package. Neither language owns a private copy, because a registry that says
 * "SmartFix can change this" on one side and "it cannot" on the other means
 * the user approved a plan the engine will not honour, or one it will exceed.
 *
 * This module is the typed reading of that table. A rule's `autofix: SAFE` is
 * a *ceiling* set by whoever authored the standard: it says the change would
 * be safe if PalCert could make it. The registry says whether PalCert can. A
 * property absent from it is never edited, however the rule is labelled,
 * because the alternative is an engine guessing at OOXML it was never taught.
 */

import { RuleScopeKind } from '../standards/rule-schema.js';
import type { RuleOperator } from '../standards/rule-schema.js';
import {
  FORBIDDEN_ELEMENT_TYPE_REASON,
  FORBIDDEN_FIX_ELEMENT_TYPES,
  SmartFixReasonCode,
} from './constants.js';
import type { FixActionType, FixTargetScope, ScriptChannel } from './generated.js';
import { SMARTFIX_CAPABILITY_REGISTRY } from './registry.generated.js';

export interface FixCapability {
  /** The catalogue property name, e.g. `fontSizeComplexScript`. */
  readonly property: string;
  /** The rule scope kinds this capability answers for. */
  readonly scopes: readonly RuleScopeKind[];
  readonly actionType: FixActionType;
  readonly targetScope: FixTargetScope;
  /**
   * Which OOXML channel the action writes, for run-level properties.
   *
   * WordprocessingML keeps Latin, complex-script and East Asian typography in
   * separate attributes. Writing `w:sz` for an Arabic paragraph changes
   * nothing a reader can see while the manifest would claim the size was
   * fixed — so the channel is part of the capability, not a detail left to
   * the mutator.
   */
  readonly scriptChannel?: ScriptChannel;
  /** The value form the action carries. */
  readonly valueKind: 'NUMBER' | 'STRING' | 'BOOLEAN';
  /** The canonical unit of a NUMBER capability. */
  readonly unit?: 'POINT' | 'MILLIMETRE' | 'LINES' | 'COUNT';
}

/** Every property SmartFix can change. */
export const FIX_CAPABILITIES: readonly FixCapability[] =
  SMARTFIX_CAPABILITY_REGISTRY.capabilities as readonly FixCapability[];

/** The registry version stamped on every plan. */
export const REGISTRY_VERSION: number = SMARTFIX_CAPABILITY_REGISTRY.registryVersion;

const BY_KEY = new Map<string, FixCapability>(
  FIX_CAPABILITIES.flatMap((capability) =>
    capability.scopes.map((scope) => [`${scope}:${capability.property}`, capability] as const),
  ),
);

/**
 * Whether SmartFix may edit an element of this type at all.
 *
 * Asked *before* any capability lookup and answered from the shared registry.
 * `undefined` is refused as firmly as a forbidden type: an ELEMENT-scoped rule
 * that names no element type would otherwise inherit whichever capability
 * matched its property, which is how a formatting fix reaches an element
 * nobody agreed it could touch. An unnamed element type is not a permission.
 */
export function elementTypeIsFixable(elementType: string | undefined): boolean {
  if (elementType === undefined) return false;
  return !FORBIDDEN_FIX_ELEMENT_TYPES.includes(elementType);
}

/**
 * The capability for a scope, property and — for ELEMENT scope — element type.
 *
 * `elementType` is required in practice for ELEMENT scope even though it is
 * optional in the signature: omitting it yields no capability, so a caller
 * that forgets it is refused rather than served a generic answer. Callers for
 * DOCUMENT scope pass nothing, as before.
 */
export function fixCapabilityFor(
  scopeKind: RuleScopeKind,
  property: string,
  elementType?: string,
): FixCapability | undefined {
  if (scopeKind === RuleScopeKind.ELEMENT && !elementTypeIsFixable(elementType)) return undefined;
  return BY_KEY.get(`${scopeKind}:${property}`);
}

/**
 * Properties PalCert deliberately refuses to edit, and why.
 *
 * These are not gaps waiting to be filled. A word count is an outcome of what
 * the author wrote, a page count is an outcome of a layout engine PalCert does
 * not run, and a document's title is metadata the author owns. Naming them
 * means the user is told *why*, rather than being told "unsupported" about a
 * property the engine simply never met.
 */
export const REFUSED_PROPERTY_REASONS = SMARTFIX_CAPABILITY_REGISTRY.refusedProperties as Readonly<
  Record<string, SmartFixReasonCode>
>;

/**
 * The reason a property is not fixable, for the UI to translate.
 *
 * The element-type refusal is checked first, because it outranks everything
 * about the property: telling somebody their reference entry's line spacing is
 * "not a supported setting" would be false — the setting is supported, the
 * element is not.
 */
export function refusalReasonFor(
  scopeKind: RuleScopeKind,
  property: string,
  elementType?: string,
): SmartFixReasonCode {
  if (scopeKind === RuleScopeKind.ELEMENT && !elementTypeIsFixable(elementType)) {
    return FORBIDDEN_ELEMENT_TYPE_REASON;
  }
  if (scopeKind === RuleScopeKind.METADATA) return SmartFixReasonCode.METADATA_NOT_SUPPORTED;
  return REFUSED_PROPERTY_REASONS[property] ?? SmartFixReasonCode.PROPERTY_NOT_SUPPORTED;
}

/**
 * Whether an operator names exactly one correct value.
 *
 * SmartFix has to know what "fixed" means before it edits anything. Anything
 * outside this set becomes `AMBIGUOUS_TARGET` and is shown to the user as
 * manual work rather than guessed at.
 */
export function operatorHasDeterministicTarget(operator: RuleOperator): boolean {
  return (SMARTFIX_CAPABILITY_REGISTRY.operatorPolicy.deterministic as readonly string[]).includes(
    operator,
  );
}

/** Whether satisfying this operator would mean writing or deleting content. */
export function operatorRequiresContentChange(operator: RuleOperator): boolean {
  return (SMARTFIX_CAPABILITY_REGISTRY.operatorPolicy.contentChange as readonly string[]).includes(
    operator,
  );
}
