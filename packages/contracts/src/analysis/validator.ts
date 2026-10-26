import AjvModule, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { ANALYSIS_ARTIFACT_JSON_SCHEMA } from './schema.generated.js';
import { validateCitationIntegrity } from './citation-integrity.js';
import type { CitationAnalysis } from './generated.js';

/**
 * Runtime validation of the analysis artifact envelope.
 *
 * Phase 6 shipped this shape in Python only, which left Node parsing whatever
 * dictionaries it received and trusting them. That is the drift the single
 * schema strategy exists to prevent, so both runtimes now validate the same
 * file against the same fixtures before a check reads a single fact.
 */
const Ajv2020 = ((AjvModule as unknown as { default?: typeof AjvModule }).default ??
  AjvModule) as typeof AjvModule;

export interface AnalysisContractIssue {
  readonly path: string;
  readonly message: string;
  /**
   * Set for a semantic defect, which reports a stable code of its own; the
   * structural half has only the schema's message.
   */
  readonly code?: string;
}

export interface AnalysisContractResult {
  readonly valid: boolean;
  readonly issues: readonly AnalysisContractIssue[];
}

let ajv: InstanceType<typeof Ajv2020> | undefined;
let compiled: ValidateFunction | undefined;

function validator(): ValidateFunction {
  if (compiled !== undefined) return compiled;
  ajv ??= new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
  ajv.addSchema(ANALYSIS_ARTIFACT_JSON_SCHEMA as unknown as object);
  compiled = ajv.getSchema(
    `${ANALYSIS_ARTIFACT_JSON_SCHEMA.$id}#/$defs/AnalysisArtifact`,
  ) as ValidateFunction;
  return compiled;
}

function toIssue(error: ErrorObject): AnalysisContractIssue {
  return {
    path: error.instancePath === '' ? '/' : error.instancePath,
    message: error.message ?? 'invalid',
  };
}

/**
 * The structural half only: does this satisfy the JSON Schema?
 *
 * Named explicitly because it is *not* the whole contract. It exists so the
 * contract suite can prove a fixture is structurally sound and semantically
 * broken; production code wants {@link validateAnalysisArtifact}.
 */
export function validateAnalysisArtifactSchema(value: unknown): AnalysisContractResult {
  const validate = validator();
  const valid = validate(value) as boolean;
  if (valid) return { valid: true, issues: [] };
  return { valid: false, issues: (validate.errors ?? []).map(toIssue) };
}

/**
 * Validate one artifact completely.
 *
 * Complete means both halves: the JSON Schema, and — when the artifact carries
 * citation evidence — that evidence's internal consistency. They were two
 * functions when the citation contracts landed, which meant an artifact with a
 * corrupt citation graph passed the ordinary contract unless every caller
 * remembered a second call. That is not failing closed, so the ordinary name
 * now means the whole thing.
 *
 * The structural half runs first and alone: the semantic pass assumes the
 * shape it is reading, so running it over an artifact that failed the schema
 * would report defects that are really the structural failure under another
 * name.
 */
export function validateAnalysisArtifact(value: unknown): AnalysisContractResult {
  const structural = validateAnalysisArtifactSchema(value);
  if (!structural.valid) return structural;

  const analysis = (value as { citationAnalysis?: CitationAnalysis }).citationAnalysis;
  if (analysis === undefined) return structural;

  const semantic = validateCitationIntegrity(analysis);
  if (semantic.valid) return { valid: true, issues: [] };
  return {
    valid: false,
    issues: semantic.issues.map((issue) => ({
      path: `/citationAnalysis${issue.path}`,
      message: issue.message,
      code: issue.code,
    })),
  };
}

/**
 * Validate, or throw with every problem listed.
 *
 * Used where a malformed artifact is not something to degrade around: a check
 * must fail closed rather than evaluate facts it could not verify (§34).
 */
export function assertAnalysisArtifact(value: unknown): void {
  const result = validateAnalysisArtifact(value);
  if (result.valid) return;
  const detail = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
  throw new Error(`analysis artifact does not satisfy the shared contract — ${detail}`);
}
