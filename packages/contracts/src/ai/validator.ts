import AjvModule, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { AI_ASSESSMENT_JSON_SCHEMA } from './assessment-schema.generated.js';
import { AI_CONTEXT_JSON_SCHEMA } from './context-schema.generated.js';

const Ajv2020 = ((AjvModule as unknown as { default?: typeof AjvModule }).default ??
  AjvModule) as typeof AjvModule;

/**
 * PalCert's own validation of AI input and output (§34).
 *
 * A provider's structured-output mode is one safety layer, and a useful one.
 * It is not a guarantee PalCert may rely on: it is enforced by someone else's
 * service, for a schema PalCert supplied over the network, on a response that
 * has crossed a trust boundary. So everything is validated again here, before
 * a single field is persisted.
 */

export interface AIContractIssue {
  readonly path: string;
  readonly message: string;
}

export interface AIContractResult {
  readonly valid: boolean;
  readonly issues: readonly AIContractIssue[];
}

export const AIContract = {
  CONTEXT_BUNDLE: 'AIContextBundle',
  RULE_ASSESSMENT_RESPONSE: 'AIRuleAssessmentResponse',
  REPORT_SUPPLEMENT_RESPONSE: 'AIReportSupplementResponse',
  REVIEW_DIGEST: 'AIReviewDigest',
} as const;

export type AIContract = (typeof AIContract)[keyof typeof AIContract];

let ajv: InstanceType<typeof Ajv2020> | undefined;
const validators = new Map<AIContract, ValidateFunction>();

function validatorFor(contract: AIContract): ValidateFunction {
  const existing = validators.get(contract);
  if (existing !== undefined) return existing;

  if (ajv === undefined) {
    ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
    ajv.addSchema(AI_CONTEXT_JSON_SCHEMA as unknown as object);
    ajv.addSchema(AI_ASSESSMENT_JSON_SCHEMA as unknown as object);
  }

  const base =
    contract === AIContract.CONTEXT_BUNDLE
      ? AI_CONTEXT_JSON_SCHEMA.$id
      : AI_ASSESSMENT_JSON_SCHEMA.$id;
  const compiled = ajv.getSchema(`${base}#/$defs/${contract}`) as ValidateFunction;
  validators.set(contract, compiled);
  return compiled;
}

export function validateAIContract(contract: AIContract, value: unknown): AIContractResult {
  const validate = validatorFor(contract);
  const valid = validate(value) as boolean;
  if (valid) return { valid: true, issues: [] };

  return {
    valid: false,
    issues: (validate.errors ?? []).map((error: ErrorObject) => ({
      path: error.instancePath === '' ? '/' : error.instancePath,
      message: error.message ?? 'is invalid',
    })),
  };
}

export function assertAIContract(contract: AIContract, value: unknown): void {
  const result = validateAIContract(contract, value);
  if (result.valid) return;
  const detail = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
  throw new Error(`${contract} does not satisfy the AI contract — ${detail}`);
}
