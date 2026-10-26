import AjvModule, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { SMARTFIX_JSON_SCHEMA } from './schema.generated.js';

/**
 * Runtime validation of the SmartFix contracts.
 *
 * The Python mutation engine validates the *same* schema file with
 * `jsonschema`, and the same fixtures run through both (`smartfix-parity`
 * here, `tests/smartfix/test_contracts.py` there). A plan accepted by one
 * runtime and rejected by the other fails CI, which is what stops a plan the
 * API considers well-formed from reaching an engine that will interpret it
 * differently.
 *
 * Validation here is not decoration. A plan is the list of edits PalCert will
 * make to somebody's thesis, and an unrecognised action is rejected rather
 * than ignored — `additionalProperties` is false throughout the schema for
 * exactly that reason.
 */

const Ajv2020 = ((AjvModule as unknown as { default?: typeof AjvModule }).default ??
  AjvModule) as typeof AjvModule;

export const SmartFixContract = {
  FIX_ACTION: 'FixAction',
  FIX_VALUE: 'FixValue',
  PLANNED_RULE: 'PlannedRule',
  SMART_FIX_PLAN: 'SmartFixPlan',
  CHANGE_MANIFEST_ENTRY: 'ChangeManifestEntry',
  CHANGE_MANIFEST: 'ChangeManifest',
  INTEGRITY_PROOFS: 'IntegrityProofs',
  FIX_ENGINE_REQUEST: 'FixEngineRequest',
  FIX_ENGINE_RESPONSE: 'FixEngineResponse',
} as const;

export type SmartFixContract = (typeof SmartFixContract)[keyof typeof SmartFixContract];

export interface SmartFixValidationIssue {
  /** JSON Pointer into the instance, e.g. `/actions/3/after/number`. */
  readonly path: string;
  readonly message: string;
}

export interface SmartFixValidationResult {
  readonly valid: boolean;
  readonly issues: readonly SmartFixValidationIssue[];
}

let ajv: InstanceType<typeof Ajv2020> | undefined;
const compiled = new Map<string, ValidateFunction>();

const SCHEMA_KEY = 'https://palcert.com/schemas/smartfix.schema.json';

function validatorFor(contract: SmartFixContract): ValidateFunction {
  const existing = compiled.get(contract);
  if (existing !== undefined) return existing;

  ajv ??= new Ajv2020({ allErrors: true, strict: true });
  if (ajv.getSchema(SCHEMA_KEY) === undefined) ajv.addSchema(SMARTFIX_JSON_SCHEMA, SCHEMA_KEY);

  const validate = ajv.getSchema(`${SCHEMA_KEY}#/$defs/${contract}`);
  if (validate === undefined) throw new Error(`No such SmartFix contract: ${contract}`);

  compiled.set(contract, validate);
  return validate;
}

function toIssue(error: ErrorObject): SmartFixValidationIssue {
  return {
    path: error.instancePath === '' ? '/' : error.instancePath,
    message: `${error.message ?? 'is invalid'}${
      error.keyword === 'additionalProperties'
        ? ` (${String((error.params as { additionalProperty?: string }).additionalProperty)})`
        : ''
    }`,
  };
}

/** Validate a value, collecting every problem rather than the first. */
export function validateSmartFixContract(
  contract: SmartFixContract,
  value: unknown,
): SmartFixValidationResult {
  const validate = validatorFor(contract);
  const valid = validate(value);
  const issues = valid ? [] : (validate.errors ?? []).map(toIssue);
  return { valid, issues };
}

export class SmartFixContractError extends Error {
  constructor(
    readonly contract: SmartFixContract,
    readonly issues: readonly SmartFixValidationIssue[],
  ) {
    super(
      `${contract} does not satisfy the SmartFix contract — ` +
        issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
    );
    this.name = 'SmartFixContractError';
  }
}

/** Validate, or throw with every problem listed. */
export function assertSmartFixContract(contract: SmartFixContract, value: unknown): void {
  const result = validateSmartFixContract(contract, value);
  if (!result.valid) throw new SmartFixContractError(contract, result.issues);
}
