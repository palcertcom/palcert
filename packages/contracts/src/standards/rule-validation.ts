import {
  isAuthoritativeSupport,
  propertySupportEntry,
  supportFor,
} from '../analysis/property-support.js';
import { DOCUMENT_FORMATS } from '../documents/document.js';
import {
  OPERATOR_VALUE_COMPATIBILITY,
  PATTERNS_REQUIRING_ARGUMENT,
  RULE_CATEGORIES,
  RULE_ELEMENT_TYPES,
  RULE_EVALUATION_MODES,
  RULE_OPERATORS,
  RULE_ORIGINS,
  RULE_PAGE_SELECTORS,
  RULE_PATTERN_NAMES,
  RULE_PROPERTY_KEY_PATTERN,
  RULE_SCOPE_KEY_PATTERN,
  RULE_SEVERITIES,
  RULE_UNITS,
  BLOCKING_ANY_MODE_FROM_SCHEMA_VERSION,
  RULE_SCHEMA_VERSION,
  RuleAutofixCapability,
  RuleEvaluationMode,
  RuleValueType,
  isOperatorValueCompatible,
  isSupportedRuleSchemaVersion,
  isValidRuleCode,
  operatorSupportsTolerance,
  unitRequiredFor,
  type RuleDefinition,
  type RuleExpectedValue,
  type RuleScope,
} from './rule-schema.js';

/**
 * Rule validation.
 *
 * Deliberately a pure function in the shared package rather than a set of
 * decorators on an API DTO, for three reasons:
 *
 *  - the rule builder runs exactly the same checks in the browser, so the UI
 *    can never offer a combination the API rejects;
 *  - publication re-validates every rule in a draft, including rules written
 *    before a validation rule was tightened;
 *  - the checks are cross-field (operator x value type x unit x tolerance),
 *    which per-property decorators express badly.
 *
 * Every failure names a `path` so the UI can put the message next to the field
 * that caused it, which is the difference between a usable builder and a form
 * that just says "invalid".
 */
export interface RuleValidationIssue {
  /** Dotted path into the rule payload, e.g. `expected.min`. */
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface RuleValidationResult {
  readonly valid: boolean;
  readonly issues: readonly RuleValidationIssue[];
}

/**
 * Which rule-schema version's rules apply.
 *
 * Validation is version-aware because the invariants genuinely changed: a
 * blocking AI-assisted rule is invalid under v1 and valid under v2. Validating
 * historical v1 content under v2 rules would silently bless something that was
 * never permitted when it was written, so the caller says which it means.
 * Omitting it validates against the current version.
 */
export interface RuleValidationOptions {
  readonly schemaVersion?: number;
}

export const RULE_TITLE_MAX_LENGTH = 200;
export const RULE_DESCRIPTION_MAX_LENGTH = 2000;
export const RULE_GUIDANCE_MAX_LENGTH = 4000;
export const RULE_STRING_VALUE_MAX_LENGTH = 500;
export const RULE_LIST_MAX_ITEMS = 200;

const RULE_VALUE_TYPES_SET = new Set<string>(Object.values(RuleValueType));

/**
 * Reject anything that looks like markup in author-supplied text.
 *
 * Rule text is rendered in the web app, in generated reports and (later) in
 * PDFs. Escaping at every one of those sinks is a step someone eventually
 * forgets, so the value never becomes dangerous in the first place: markup is
 * refused at the boundary with a message the author can act on, rather than
 * silently stripped -- silent stripping changes what the author wrote without
 * telling them.
 */
const MARKUP_PATTERN = /<[/!a-zA-Z]/;

/**
 * C0/C1 control characters (tab, newline and carriage return excepted) plus the
 * Unicode bidirectional overrides.
 *
 * The bidi characters matter as much as the controls: they can make rendered
 * text read differently from the stored text, which in a rule people are
 * expected to comply with is a correctness problem, not a cosmetic one.
 *
 * `no-control-regex` is disabled for this one line: matching control
 * characters is the entire purpose of the pattern, so the rule is flagging
 * exactly the behaviour that is wanted.
 */
/* eslint-disable no-control-regex -- matching control characters is the point */
const CONTROL_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
/* eslint-enable no-control-regex */

export function containsMarkup(value: string): boolean {
  return MARKUP_PATTERN.test(value);
}

export function containsControlCharacters(value: string): boolean {
  return CONTROL_PATTERN.test(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function checkText(
  issues: RuleValidationIssue[],
  path: string,
  value: string | null | undefined,
  options: { required: boolean; maxLength: number },
): void {
  if (value === null || value === undefined || value === '') {
    if (options.required) {
      issues.push({ path, code: 'REQUIRED', message: `${path} is required.` });
    }
    return;
  }
  if (typeof value !== 'string') {
    issues.push({ path, code: 'INVALID', message: `${path} must be text.` });
    return;
  }
  if (value.trim() === '') {
    if (options.required) {
      issues.push({ path, code: 'REQUIRED', message: `${path} is required.` });
    }
    return;
  }
  if (value.length > options.maxLength) {
    issues.push({
      path,
      code: 'TOO_LONG',
      message: `${path} must be at most ${options.maxLength} characters.`,
    });
  }
  if (containsMarkup(value)) {
    issues.push({
      path,
      code: 'MARKUP_NOT_ALLOWED',
      message: `${path} must be plain text. Remove any HTML or angle brackets.`,
    });
  }
  if (containsControlCharacters(value)) {
    issues.push({
      path,
      code: 'CONTROL_CHARACTERS',
      message: `${path} contains characters that are not allowed.`,
    });
  }
}

function validateScope(issues: RuleValidationIssue[], scope: RuleScope | undefined): void {
  if (scope === null || scope === undefined || typeof scope !== 'object') {
    issues.push({ path: 'scope', code: 'REQUIRED', message: 'scope is required.' });
    return;
  }

  const property = (candidate: unknown, path: string): void => {
    if (typeof candidate !== 'string' || !RULE_PROPERTY_KEY_PATTERN.test(candidate)) {
      issues.push({
        path,
        code: 'INVALID',
        message: `${path} must be a lowerCamelCase identifier.`,
      });
    }
  };

  switch (scope.kind) {
    case 'DOCUMENT':
      property(scope.property, 'scope.property');
      return;
    case 'SECTION':
      if (typeof scope.sectionKey !== 'string' || !RULE_SCOPE_KEY_PATTERN.test(scope.sectionKey)) {
        issues.push({
          path: 'scope.sectionKey',
          code: 'INVALID',
          message: 'scope.sectionKey must be an UPPER_SNAKE_CASE key.',
        });
      }
      property(scope.property, 'scope.property');
      return;
    case 'ELEMENT':
      if (!RULE_ELEMENT_TYPES.includes(scope.elementType)) {
        issues.push({
          path: 'scope.elementType',
          code: 'INVALID',
          message: 'scope.elementType is not a known element type.',
        });
      }
      if (scope.level !== undefined) {
        if (scope.elementType !== 'HEADING') {
          issues.push({
            path: 'scope.level',
            code: 'NOT_APPLICABLE',
            message: 'scope.level applies only to headings.',
          });
        } else if (!Number.isInteger(scope.level) || scope.level < 1 || scope.level > 9) {
          issues.push({
            path: 'scope.level',
            code: 'INVALID',
            message: 'scope.level must be a heading level between 1 and 9.',
          });
        }
      }
      property(scope.property, 'scope.property');
      return;
    case 'METADATA':
      property(scope.field, 'scope.field');
      return;
    case 'PAGE':
      if (!RULE_PAGE_SELECTORS.includes(scope.pages)) {
        issues.push({
          path: 'scope.pages',
          code: 'INVALID',
          message: 'scope.pages is not a known page selector.',
        });
      }
      property(scope.property, 'scope.property');
      return;
    default:
      issues.push({
        path: 'scope.kind',
        code: 'INVALID',
        message: 'scope.kind is not a known scope kind.',
      });
  }
}

function validateExpected(
  issues: RuleValidationIssue[],
  expected: RuleExpectedValue | undefined,
): void {
  if (expected === null || expected === undefined || typeof expected !== 'object') {
    issues.push({ path: 'expected', code: 'REQUIRED', message: 'expected is required.' });
    return;
  }

  switch (expected.type) {
    case 'NUMBER':
      if (!isFiniteNumber(expected.number)) {
        issues.push({
          path: 'expected.number',
          code: 'INVALID',
          message: 'expected.number must be a finite number.',
        });
      }
      return;
    case 'STRING':
      checkText(issues, 'expected.text', expected.text, {
        required: true,
        maxLength: RULE_STRING_VALUE_MAX_LENGTH,
      });
      return;
    case 'BOOLEAN':
      if (typeof expected.boolean !== 'boolean') {
        issues.push({
          path: 'expected.boolean',
          code: 'INVALID',
          message: 'expected.boolean must be true or false.',
        });
      }
      return;
    case 'NUMBER_RANGE':
      if (!isFiniteNumber(expected.min) || !isFiniteNumber(expected.max)) {
        issues.push({
          path: 'expected',
          code: 'INVALID',
          message: 'A range needs a finite min and max.',
        });
        return;
      }
      if (expected.min > expected.max) {
        issues.push({
          path: 'expected.min',
          code: 'INVALID_RANGE',
          message: 'expected.min must not be greater than expected.max.',
        });
      }
      return;
    case 'STRING_LIST': {
      if (!Array.isArray(expected.values) || expected.values.length === 0) {
        issues.push({
          path: 'expected.values',
          code: 'REQUIRED',
          message: 'Provide at least one value.',
        });
        return;
      }
      if (expected.values.length > RULE_LIST_MAX_ITEMS) {
        issues.push({
          path: 'expected.values',
          code: 'TOO_LONG',
          message: `At most ${RULE_LIST_MAX_ITEMS} values are allowed.`,
        });
      }
      expected.values.forEach((value, index) =>
        checkText(issues, `expected.values.${index}`, value, {
          required: true,
          maxLength: RULE_STRING_VALUE_MAX_LENGTH,
        }),
      );
      if (new Set(expected.values).size !== expected.values.length) {
        issues.push({
          path: 'expected.values',
          code: 'DUPLICATE',
          message: 'Values must be unique.',
        });
      }
      return;
    }
    case 'NUMBER_LIST':
      if (!Array.isArray(expected.values) || expected.values.length === 0) {
        issues.push({
          path: 'expected.values',
          code: 'REQUIRED',
          message: 'Provide at least one value.',
        });
        return;
      }
      if (expected.values.length > RULE_LIST_MAX_ITEMS) {
        issues.push({
          path: 'expected.values',
          code: 'TOO_LONG',
          message: `At most ${RULE_LIST_MAX_ITEMS} values are allowed.`,
        });
      }
      if (!expected.values.every(isFiniteNumber)) {
        issues.push({
          path: 'expected.values',
          code: 'INVALID',
          message: 'Every value must be a finite number.',
        });
      }
      return;
    case 'PATTERN':
      if (!RULE_PATTERN_NAMES.includes(expected.pattern)) {
        issues.push({
          path: 'expected.pattern',
          code: 'INVALID',
          message: 'expected.pattern must be one of the PalCert pattern names.',
        });
        return;
      }
      if (PATTERNS_REQUIRING_ARGUMENT.includes(expected.pattern)) {
        checkText(issues, 'expected.argument', expected.argument, {
          required: true,
          maxLength: RULE_STRING_VALUE_MAX_LENGTH,
        });
      } else if (expected.argument !== undefined && expected.argument !== null) {
        issues.push({
          path: 'expected.argument',
          code: 'NOT_APPLICABLE',
          message: 'This pattern does not take an argument.',
        });
      }
      return;
    case 'NONE':
      return;
    default:
      issues.push({
        path: 'expected.type',
        code: 'INVALID',
        message: 'expected.type is not a known value type.',
      });
  }
}

/**
 * Validate one rule completely.
 *
 * `ruleCode` uniqueness is deliberately *not* checked here: it is a property of
 * the set, not of the rule, and is enforced by version-level validation and by
 * a database unique index.
 */
/** The property a rule measures, whatever scope kind it uses. */
function propertyOf(rule: Partial<RuleDefinition>): string | null {
  const scope = rule.scope as { property?: unknown } | undefined;
  return typeof scope?.property === 'string' ? scope.property : null;
}

/**
 * Is this a property no format can answer authoritatively?
 *
 * "Advisory in at least one format and authoritative in none" — not merely
 * "advisory somewhere", because a property that is EXACT for DOCX and ADVISORY
 * for PDF would still be answerable, and refusing a blocking rule about it
 * would refuse a legitimate standard.
 *
 * An unknown property answers false: it is UNSUPPORTED everywhere, which the
 * evaluator already turns into INDETERMINATE, and a standard may legitimately
 * reference a property no analyzer implements yet.
 */
function isAdvisoryOnlyProperty(property: string | null): boolean {
  if (property === null || propertySupportEntry(property) === null) return false;
  const levels = DOCUMENT_FORMATS.map((format) => supportFor(format, property));
  return levels.includes('ADVISORY') && !levels.some(isAuthoritativeSupport);
}

export function validateRuleDefinition(
  rule: Partial<RuleDefinition>,
  options: RuleValidationOptions = {},
): RuleValidationResult {
  const issues: RuleValidationIssue[] = [];
  const schemaVersion = options.schemaVersion ?? RULE_SCHEMA_VERSION;

  if (!isSupportedRuleSchemaVersion(schemaVersion)) {
    // Refused outright rather than validated on a guess: applying the rules of
    // a version we do understand to one we do not is how a wrong verdict ends
    // up presented confidently.
    return {
      valid: false,
      issues: [
        {
          path: 'ruleSchemaVersion',
          code: 'RULE_SCHEMA_UNSUPPORTED',
          message: `Rule schema version ${schemaVersion} is not supported by this release.`,
        },
      ],
    };
  }

  if (typeof rule.ruleCode !== 'string' || !isValidRuleCode(rule.ruleCode)) {
    issues.push({
      path: 'ruleCode',
      code: 'INVALID',
      message: 'ruleCode must be UPPERCASE.DOT.SEPARATED, e.g. MARGIN.TOP.MIN.',
    });
  }
  if (rule.category === undefined || !RULE_CATEGORIES.includes(rule.category)) {
    issues.push({
      path: 'category',
      code: 'INVALID',
      message: 'category is not a known category.',
    });
  }
  if (rule.evaluationMode === undefined || !RULE_EVALUATION_MODES.includes(rule.evaluationMode)) {
    issues.push({
      path: 'evaluationMode',
      code: 'INVALID',
      message: 'evaluationMode is not a known mode.',
    });
  }
  if (rule.severity === undefined || !RULE_SEVERITIES.includes(rule.severity)) {
    issues.push({
      path: 'severity',
      code: 'INVALID',
      message: 'severity is not a known severity.',
    });
  }
  if (rule.origin === undefined || !RULE_ORIGINS.includes(rule.origin)) {
    issues.push({ path: 'origin', code: 'INVALID', message: 'origin is not a known origin.' });
  }
  if (typeof rule.blocking !== 'boolean') {
    issues.push({ path: 'blocking', code: 'REQUIRED', message: 'blocking is required.' });
  }
  if (rule.autofix === undefined || !Object.values(RuleAutofixCapability).includes(rule.autofix)) {
    issues.push({
      path: 'autofix',
      code: 'INVALID',
      message: 'autofix is not a known capability.',
    });
  }

  validateScope(issues, rule.scope);
  validateExpected(issues, rule.expected);

  const operator = rule.operator;
  const operatorKnown = operator !== undefined && RULE_OPERATORS.includes(operator);
  if (!operatorKnown) {
    issues.push({
      path: 'operator',
      code: 'INVALID',
      message: 'operator is not a known operator.',
    });
  }

  const valueType = rule.expected?.type as RuleValueType | undefined;

  if (operatorKnown && valueType !== undefined && RULE_VALUE_TYPES_SET.has(valueType)) {
    if (!isOperatorValueCompatible(operator, valueType)) {
      issues.push({
        path: 'expected.type',
        code: 'OPERATOR_INCOMPATIBLE',
        message:
          `Operator ${operator} does not accept a ${valueType} value. ` +
          `Accepted: ${OPERATOR_VALUE_COMPATIBILITY[operator].join(', ')}.`,
      });
    }

    if (unitRequiredFor(valueType)) {
      if (rule.unit === null || rule.unit === undefined) {
        issues.push({
          path: 'unit',
          code: 'REQUIRED',
          message: 'A numeric rule must state its unit. Use COUNT for a plain count.',
        });
      } else if (!RULE_UNITS.includes(rule.unit)) {
        issues.push({ path: 'unit', code: 'INVALID', message: 'unit is not a known unit.' });
      }
    } else if (rule.unit !== null && rule.unit !== undefined) {
      issues.push({
        path: 'unit',
        code: 'NOT_APPLICABLE',
        message: 'A unit is only meaningful for a numeric value.',
      });
    }

    if (rule.tolerance !== null && rule.tolerance !== undefined) {
      if (!operatorSupportsTolerance(operator, valueType)) {
        issues.push({
          path: 'tolerance',
          code: 'NOT_APPLICABLE',
          message: `A tolerance is not meaningful for ${operator} with a ${valueType} value.`,
        });
      } else if (!isFiniteNumber(rule.tolerance) || rule.tolerance < 0) {
        issues.push({
          path: 'tolerance',
          code: 'INVALID',
          message: 'tolerance must be a non-negative number.',
        });
      }
    }
  }

  // --- cross-cutting safety invariants -------------------------------------
  //
  // Rule schema v1 required a blocking rule to be DETERMINISTIC. v2 relaxes
  // that (ADR-0030): a journal may legitimately make an ethics declaration
  // blocking even though judging it needs a person. The safety property moves
  // rather than disappearing — an unresolved non-deterministic blocking rule
  // prevents a *final* compliance decision, which the engine signals with
  // INDETERMINATE + requiresReview and Phase 7 enforces.
  //
  // The v1 rule is still applied when validating v1 content, so historical
  // rules are judged by the rules they were written under.
  if (
    schemaVersion < BLOCKING_ANY_MODE_FROM_SCHEMA_VERSION &&
    rule.blocking === true &&
    rule.evaluationMode !== RuleEvaluationMode.DETERMINISTIC
  ) {
    issues.push({
      path: 'blocking',
      code: 'NOT_APPLICABLE',
      message: 'Under rule schema version 1, only a DETERMINISTIC rule may be blocking.',
    });
  }
  // Phase 18, Checkpoint 16. A rule reading a property that no format can
  // answer authoritatively can never produce a PASS or a FAIL — the evaluator
  // returns INDETERMINATE on any fact whose provenance is HEURISTIC — so
  // `blocking: true` on one is a configuration that cannot do what its author
  // believes it does.
  //
  // Refused here rather than ignored at aggregation. Both were available and
  // the choice matters: silently ignoring it would leave a standard's author
  // looking at a rule marked blocking, believing a certificate depends on it,
  // with nothing anywhere telling them otherwise. Refusing it says so once, at
  // the moment they write it, in the place the message can be acted on.
  //
  // Determination ignores it as well, because historical content and callers
  // that bypass validation both exist — but that is a backstop, not the
  // contract.
  if (rule.blocking === true && isAdvisoryOnlyProperty(propertyOf(rule))) {
    issues.push({
      path: 'blocking',
      code: 'NOT_APPLICABLE',
      message:
        'A rule about an observed (advisory) property cannot be blocking: ' +
        'advisory evidence is reported and never decides compliance.',
    });
  }
  if (
    rule.evaluationMode === RuleEvaluationMode.MANUAL &&
    rule.autofix !== undefined &&
    rule.autofix !== RuleAutofixCapability.NONE
  ) {
    issues.push({
      path: 'autofix',
      code: 'NOT_APPLICABLE',
      message: 'A MANUAL rule cannot be fixed automatically.',
    });
  }

  checkText(issues, 'titleEn', rule.titleEn, { required: true, maxLength: RULE_TITLE_MAX_LENGTH });
  checkText(issues, 'titleAr', rule.titleAr, { required: true, maxLength: RULE_TITLE_MAX_LENGTH });
  checkText(issues, 'descriptionEn', rule.descriptionEn, {
    required: false,
    maxLength: RULE_DESCRIPTION_MAX_LENGTH,
  });
  checkText(issues, 'descriptionAr', rule.descriptionAr, {
    required: false,
    maxLength: RULE_DESCRIPTION_MAX_LENGTH,
  });
  checkText(issues, 'guidanceEn', rule.guidanceEn, {
    required: false,
    maxLength: RULE_GUIDANCE_MAX_LENGTH,
  });
  checkText(issues, 'guidanceAr', rule.guidanceAr, {
    required: false,
    maxLength: RULE_GUIDANCE_MAX_LENGTH,
  });
  checkText(issues, 'originReference', rule.originReference, {
    required: false,
    maxLength: RULE_DESCRIPTION_MAX_LENGTH,
  });

  return { valid: issues.length === 0, issues };
}
