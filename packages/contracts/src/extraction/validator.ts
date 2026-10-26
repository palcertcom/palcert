import AjvModule, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { RULE_PROPOSAL_JSON_SCHEMA } from './proposal-schema.generated.js';

const Ajv2020 = ((AjvModule as unknown as { default?: typeof AjvModule }).default ??
  AjvModule) as typeof AjvModule;

/**
 * PalCert's own validation of extraction output (§84).
 *
 * The provider's structured-output mode is one safety layer and a useful one.
 * It is not a guarantee PalCert may rely on: it is enforced by someone else's
 * service, for a schema PalCert supplied over the network, on a response that
 * has crossed a trust boundary and will be shown to an institution as a
 * candidate rule. So it is validated again here, before anything is persisted —
 * and then the rule definition inside it is validated a third time, against the
 * target draft's own Rule Schema version, by the ordinary Phase 3 validator
 * (§58).
 */

export interface ExtractionContractIssue {
  readonly path: string;
  readonly message: string;
}

export interface ExtractionContractResult {
  readonly valid: boolean;
  readonly issues: readonly ExtractionContractIssue[];
}

export const ExtractionContract = {
  PROPOSAL_OUTPUT: 'PalCertRuleProposalOutput',
  PROPOSAL: 'RuleProposal',
  SUGGESTED_RULE: 'SuggestedRule',
} as const;

export type ExtractionContract = (typeof ExtractionContract)[keyof typeof ExtractionContract];

let ajv: InstanceType<typeof Ajv2020> | undefined;
const validators = new Map<ExtractionContract, ValidateFunction>();

function validatorFor(contract: ExtractionContract): ValidateFunction {
  const existing = validators.get(contract);
  if (existing !== undefined) return existing;

  if (ajv === undefined) {
    ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
    ajv.addSchema(RULE_PROPOSAL_JSON_SCHEMA as unknown as object);
  }

  const base = RULE_PROPOSAL_JSON_SCHEMA.$id;
  const pointer =
    contract === ExtractionContract.PROPOSAL_OUTPUT ? base : `${base}#/$defs/${contract}`;
  const compiled = ajv.getSchema(pointer) as ValidateFunction;
  validators.set(contract, compiled);
  return compiled;
}

export function validateExtractionContract(
  contract: ExtractionContract,
  value: unknown,
): ExtractionContractResult {
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

export function assertExtractionContract(contract: ExtractionContract, value: unknown): void {
  const result = validateExtractionContract(contract, value);
  if (result.valid) return;
  const detail = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
  throw new Error(`${contract} does not satisfy the extraction contract — ${detail}`);
}
