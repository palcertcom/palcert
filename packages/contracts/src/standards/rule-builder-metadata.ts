import {
  BLOCKING_ANY_MODE_FROM_SCHEMA_VERSION,
  OPERATOR_VALUE_COMPATIBILITY,
  PATTERNS_REQUIRING_ARGUMENT,
  RULE_AUTOFIX_CAPABILITIES,
  RULE_CATEGORIES,
  RULE_ELEMENT_TYPES,
  RULE_EVALUATION_MODES,
  RULE_OPERATORS,
  RULE_ORIGINS,
  RULE_PAGE_SELECTORS,
  RULE_PATTERN_NAMES,
  RULE_SCHEMA_VERSION,
  RULE_SCOPE_KINDS,
  RULE_SEVERITIES,
  RULE_UNITS,
  RULE_VALUE_TYPES,
  SUPPORTED_RULE_SCHEMA_VERSIONS,
  TOLERANCE_COMPATIBLE_OPERATORS,
  type RuleOperator,
  type RuleValueType,
} from './rule-schema.js';

/**
 * The machine-readable description of the rule schema.
 *
 * Served by `GET /standards/rule-schema` and consumed by the rule builder, so
 * the UI's dropdowns and its conditional-field logic are *derived* from the
 * same catalogue the API validates against. A hand-copied list in the frontend
 * would drift the first time an operator is added, and the drift would show up
 * as users being unable to save rules the form let them build.
 *
 * It is deliberately organization-agnostic reference data: it describes the
 * platform, not a tenant, so it carries no tenant context and leaks nothing.
 */
export interface RuleOperatorDescriptor {
  readonly operator: RuleOperator;
  /** Value shapes this operator accepts. */
  readonly valueTypes: readonly RuleValueType[];
  /** True when the operator takes no operand at all. */
  readonly unary: boolean;
  readonly supportsTolerance: boolean;
}

export interface RuleSchemaDescriptor {
  /** The version new drafts are written under. */
  readonly ruleSchemaVersion: number;
  /**
   * Every version this release can validate, oldest first.
   *
   * The builder needs the whole list, not just the current one: it edits
   * drafts written under older versions and must apply *their* invariants, or
   * it would offer a control the API then refuses.
   */
  readonly supportedRuleSchemaVersions: readonly number[];
  /**
   * The first version under which a rule may be blocking in any evaluation
   * mode. Below it, only a DETERMINISTIC rule may be blocking.
   */
  readonly blockingAnyModeFromSchemaVersion: number;
  readonly categories: readonly string[];
  readonly evaluationModes: readonly string[];
  readonly severities: readonly string[];
  readonly autofixCapabilities: readonly string[];
  readonly origins: readonly string[];
  readonly units: readonly string[];
  readonly valueTypes: readonly string[];
  readonly scopeKinds: readonly string[];
  readonly elementTypes: readonly string[];
  readonly pageSelectors: readonly string[];
  readonly patterns: readonly { readonly name: string; readonly requiresArgument: boolean }[];
  readonly operators: readonly RuleOperatorDescriptor[];
  /** Value types that require a unit. */
  readonly unitRequiredFor: readonly string[];
}

export function describeRuleSchema(): RuleSchemaDescriptor {
  return {
    ruleSchemaVersion: RULE_SCHEMA_VERSION,
    supportedRuleSchemaVersions: SUPPORTED_RULE_SCHEMA_VERSIONS,
    blockingAnyModeFromSchemaVersion: BLOCKING_ANY_MODE_FROM_SCHEMA_VERSION,
    categories: RULE_CATEGORIES,
    evaluationModes: RULE_EVALUATION_MODES,
    severities: RULE_SEVERITIES,
    autofixCapabilities: RULE_AUTOFIX_CAPABILITIES,
    origins: RULE_ORIGINS,
    units: RULE_UNITS,
    valueTypes: RULE_VALUE_TYPES,
    scopeKinds: RULE_SCOPE_KINDS,
    elementTypes: RULE_ELEMENT_TYPES,
    pageSelectors: RULE_PAGE_SELECTORS,
    patterns: RULE_PATTERN_NAMES.map((name) => ({
      name,
      requiresArgument: PATTERNS_REQUIRING_ARGUMENT.includes(name),
    })),
    operators: RULE_OPERATORS.map((operator) => {
      const valueTypes = OPERATOR_VALUE_COMPATIBILITY[operator];
      return {
        operator,
        valueTypes,
        unary: valueTypes.length === 1 && valueTypes[0] === 'NONE',
        supportsTolerance: TOLERANCE_COMPATIBLE_OPERATORS.includes(operator),
      };
    }),
    unitRequiredFor: ['NUMBER', 'NUMBER_RANGE', 'NUMBER_LIST'],
  };
}
