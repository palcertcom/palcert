import AjvModule, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { CHECK_REPORT_JSON_SCHEMA } from './report-schema.generated.js';

/**
 * Runtime validation of the check report.
 *
 * A report is hashed and stored for ever, so it is validated *before* it is
 * canonicalized: an invalid report that has already been hashed and persisted
 * is a permanent record of a mistake (§35, §46).
 */
const Ajv2020 = ((AjvModule as unknown as { default?: typeof AjvModule }).default ??
  AjvModule) as typeof AjvModule;

export interface ReportContractIssue {
  readonly path: string;
  readonly message: string;
}

export interface ReportContractResult {
  readonly valid: boolean;
  readonly issues: readonly ReportContractIssue[];
}

let ajv: InstanceType<typeof Ajv2020> | undefined;
let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (compiled !== undefined) return compiled;
  ajv ??= new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
  ajv.addSchema(CHECK_REPORT_JSON_SCHEMA as unknown as object);
  compiled = ajv.getSchema(
    `${CHECK_REPORT_JSON_SCHEMA.$id}#/$defs/CheckReport`,
  ) as ValidateFunction;
  return compiled;
}

function toIssue(error: ErrorObject): ReportContractIssue {
  return {
    path: error.instancePath === '' ? '/' : error.instancePath,
    message: error.message ?? 'invalid',
  };
}

export function validateCheckReport(value: unknown): ReportContractResult {
  const validate = validator();
  const valid = validate(value) as boolean;
  if (valid) return { valid: true, issues: [] };
  return { valid: false, issues: (validate.errors ?? []).map(toIssue) };
}

export function assertCheckReport(value: unknown): void {
  const result = validateCheckReport(value);
  if (result.valid) return;
  const detail = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
  throw new Error(`check report does not satisfy the shared contract — ${detail}`);
}
