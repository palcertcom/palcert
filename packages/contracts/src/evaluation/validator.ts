import AjvModule, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { FACT_SCHEMA_VERSION_ELEMENT_TYPES } from './constants.js';
import { EVALUATION_JSON_SCHEMA } from './schema.generated.js';

/**
 * Runtime validation of the shared evaluation contracts.
 *
 * The Python engine validates the *same* schema file with `jsonschema`, and the
 * same fixtures are run through both. A fixture accepted by one runtime and
 * rejected by the other fails CI — which is the whole point of having one
 * schema rather than two hand-written models.
 *
 * The schema constant is generated from `contracts/schemas/evaluation.schema.json`
 * rather than hand-copied, and CI fails if the two diverge — so embedding it
 * does not create a second source of truth.
 */

// Ajv ships a CommonJS default export; under this package's CommonJS build the
// interop shape differs from the ESM one, so resolve it explicitly rather than
// relying on whichever the bundler happens to produce.
const Ajv2020 = ((AjvModule as unknown as { default?: typeof AjvModule }).default ??
  AjvModule) as typeof AjvModule;

/** The contract definitions a caller may validate against. */
export const EvaluationContract = {
  DOCUMENT_FACT_SET: 'DocumentFactSet',
  DOCUMENT_FACT: 'DocumentFact',
  FACT_SCOPE: 'FactScope',
  FACT_VALUE: 'FactValue',
  LOCATION: 'Location',
  COVERAGE_ENTRY: 'CoverageEntry',
  VIOLATION: 'Violation',
  RULE_EVALUATION_RESULT: 'RuleEvaluationResult',
  EVALUATION_REQUEST: 'EvaluationRequest',
  EVALUATION_RESPONSE: 'EvaluationResponse',
} as const;

export type EvaluationContract = (typeof EvaluationContract)[keyof typeof EvaluationContract];

export interface ContractValidationIssue {
  /** JSON Pointer into the instance, e.g. `/facts/3/value/number`. */
  readonly path: string;
  readonly message: string;
}

export interface ContractValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ContractValidationIssue[];
}

let ajv: InstanceType<typeof Ajv2020> | undefined;
const compiled = new Map<string, ValidateFunction>();

function validatorFor(contract: EvaluationContract): ValidateFunction {
  const existing = compiled.get(contract);
  if (existing !== undefined) return existing;

  ajv ??= new Ajv2020({
    // Report every problem, not only the first: a fixture with three mistakes
    // should take one round trip to fix, not three.
    allErrors: true,
    strict: true,
  });

  const key = 'https://palcert.com/schemas/evaluation.schema.json';
  if (ajv.getSchema(key) === undefined) ajv.addSchema(EVALUATION_JSON_SCHEMA, key);

  const validate = ajv.getSchema(`${key}#/$defs/${contract}`);
  if (validate === undefined) {
    throw new Error(`No such evaluation contract: ${contract}`);
  }

  compiled.set(contract, validate);
  return validate;
}

function toIssue(error: ErrorObject): ContractValidationIssue {
  return {
    path: error.instancePath === '' ? '/' : error.instancePath,
    message: `${error.message ?? 'is invalid'}${
      error.params !== undefined && Object.keys(error.params).length > 0
        ? ` (${JSON.stringify(error.params)})`
        : ''
    }`,
  };
}

/**
 * Element types a *fact set* may use are decided by the version it declares,
 * which JSON Schema cannot express without conditionals in two runtimes. Rules
 * are unrestricted: a rule naming an element type the extractor never emits
 * simply selects nothing, which is already a meaningful answer.
 */
function factSchemaVocabularyIssues(value: unknown): ContractValidationIssue[] {
  const set = value as { factSchemaVersion?: unknown; facts?: unknown };
  const version = set?.factSchemaVersion;
  if (typeof version !== 'number') return [];

  const allowed = FACT_SCHEMA_VERSION_ELEMENT_TYPES[version];
  if (allowed === undefined || !Array.isArray(set.facts)) return [];

  const issues: ContractValidationIssue[] = [];
  set.facts.forEach((fact, index) => {
    const elementType = (fact as { scope?: { elementType?: unknown } })?.scope?.elementType;
    if (typeof elementType !== 'string' || allowed.includes(elementType)) return;
    issues.push({
      path: `/facts/${index}/scope/elementType`,
      message: `element type ${elementType} was introduced after fact schema version ${version}`,
    });
  });
  return issues;
}

/** Validate a value against one of the shared contracts. */
export function validateEvaluationContract(
  contract: EvaluationContract,
  value: unknown,
): ContractValidationResult {
  const validate = validatorFor(contract);
  const valid = validate(value) as boolean;

  const issues = valid ? [] : (validate.errors ?? []).map(toIssue);
  const vocabulary =
    contract === EvaluationContract.DOCUMENT_FACT_SET ? factSchemaVocabularyIssues(value) : [];

  const all = [...issues, ...vocabulary];
  return { valid: all.length === 0, issues: all };
}

/**
 * Validate, or throw with every problem listed.
 *
 * Used at service boundaries, where a malformed fact set is a programming or
 * integration error rather than something to degrade gracefully around.
 */
export function assertEvaluationContract(contract: EvaluationContract, value: unknown): void {
  const result = validateEvaluationContract(contract, value);
  if (result.valid) return;

  const detail = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
  throw new Error(`${contract} does not satisfy the evaluation contract — ${detail}`);
}
