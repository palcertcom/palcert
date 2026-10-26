import type {
  RuleAutofixCapability,
  RuleCategory,
  RuleDefinition,
  RuleEvaluationMode,
  RuleExpectedValue,
  RuleOperator,
  RuleOrigin,
  RuleScope,
  RuleSeverity,
  RuleUnit,
  RuleView,
} from '@palcert/contracts';

/**
 * The stored shape of a rule.
 *
 * Declared here rather than imported from the generated Prisma client so the
 * mapping functions can be unit-tested against plain objects, and so a schema
 * change that drops a field shows up as a type error in one place.
 */
export interface StandardRuleRow {
  id: string;
  ruleCode: string;
  category: string;
  evaluationMode: string;
  scope: unknown;
  operator: string;
  expectedValue: unknown;
  unit: string | null;
  /** Prisma returns a Decimal for the numeric column. */
  tolerance: { toNumber: () => number } | number | null;
  severity: string;
  blocking: boolean;
  autofix: string;
  origin: string;
  originReference: string | null;
  titleEn: string;
  titleAr: string;
  descriptionEn: string | null;
  descriptionAr: string | null;
  guidanceEn: string | null;
  guidanceAr: string | null;
  displayOrder: number;
  ruleSchemaVersion: number;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Convert a Decimal (or a plain number, in tests) to a JavaScript number.
 *
 * The column is `numeric(12,4)` so that a stored tolerance is exact rather than
 * a binary-float approximation. It becomes a number at the boundary because
 * that is what the rule contract — and the hash — are defined over.
 */
export function toleranceToNumber(
  value: { toNumber: () => number } | number | null,
): number | null {
  if (value === null) return null;
  return typeof value === 'number' ? value : value.toNumber();
}

/**
 * Project a stored row onto the semantic tuple the canonicalizer hashes.
 *
 * Everything the hash must not see — the id, the timestamps, the schema
 * version, the tenant — is simply absent from `RuleDefinition`, so this
 * function cannot leak it into a snapshot by accident.
 */
export function toRuleDefinition(row: StandardRuleRow): RuleDefinition {
  return {
    ruleCode: row.ruleCode,
    category: row.category as RuleCategory,
    evaluationMode: row.evaluationMode as RuleEvaluationMode,
    scope: row.scope as RuleScope,
    operator: row.operator as RuleOperator,
    expected: row.expectedValue as RuleExpectedValue,
    unit: row.unit as RuleUnit | null,
    tolerance: toleranceToNumber(row.tolerance),
    severity: row.severity as RuleSeverity,
    blocking: row.blocking,
    autofix: row.autofix as RuleAutofixCapability,
    origin: row.origin as RuleOrigin,
    originReference: row.originReference,
    displayOrder: row.displayOrder,
    titleEn: row.titleEn,
    titleAr: row.titleAr,
    descriptionEn: row.descriptionEn,
    descriptionAr: row.descriptionAr,
    guidanceEn: row.guidanceEn,
    guidanceAr: row.guidanceAr,
  };
}

/** Project a stored row onto the API response shape. */
export function toRuleView(row: StandardRuleRow): RuleView {
  return {
    ...toRuleDefinition(row),
    id: row.id,
    ruleSchemaVersion: row.ruleSchemaVersion,
    createdAt: (row.createdAt ?? new Date(0)).toISOString(),
    updatedAt: (row.updatedAt ?? new Date(0)).toISOString(),
  };
}
