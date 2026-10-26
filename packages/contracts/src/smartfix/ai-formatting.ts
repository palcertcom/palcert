/** AI chooses formatting values; only the document engine may resolve targets or verdicts. */
import type { SmartFixPlan } from './generated.js';
export type SmartFixAIPlanning = NonNullable<SmartFixPlan['aiPlanning']>;
export const SMARTFIX_AI_CONSENT_VERSION = '1';
export const SMARTFIX_AI_MAX_ROUNDS = 3;
export const SMARTFIX_AI_MAX_TARGETS = 512;

export interface AIFormattingTarget {
  readonly ruleCode: string;
  readonly kind: 'NUMBER' | 'STRING' | 'BOOLEAN';
  /** Numbers use the capability unit supplied in the context, never a guessed unit. */
  readonly value: string;
}

export interface AIFormattingProposal {
  readonly targets: readonly AIFormattingTarget[];
}

export interface AIFormattingRequest {
  readonly signal?: AbortSignal;
  readonly systemPrompt: string;
  readonly userPrompt: string;
}

export interface SmartFixAIContext {
  readonly schemaVersion: 1;
  readonly rules: readonly Record<string, unknown>[];
  readonly complete: boolean;
}

export const AI_FORMATTING_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['targets'],
  properties: {
    targets: {
      type: 'array',
      maxItems: SMARTFIX_AI_MAX_TARGETS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ruleCode', 'kind', 'value'],
        properties: {
          ruleCode: { type: 'string', minLength: 1, maxLength: 200 },
          kind: { type: 'string', enum: ['NUMBER', 'STRING', 'BOOLEAN'] },
          value: { type: 'string', minLength: 1, maxLength: 256 },
        },
      },
    },
  },
};

/** Revalidate after structured generation, including bounds stripped by provider APIs. */
export function parseAIFormattingProposal(value: unknown): AIFormattingProposal {
  const invalid = (): never => {
    throw new Error('Invalid formatting proposal');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const output = value as Record<string, unknown>;
  if (
    Object.keys(output).join() !== 'targets' ||
    !Array.isArray(output.targets) ||
    output.targets.length > SMARTFIX_AI_MAX_TARGETS
  )
    return invalid();
  const codes = new Set<string>();
  for (const entry of output.targets) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return invalid();
    const target = entry as Record<string, unknown>;
    if (
      Object.keys(target).sort().join() !== 'kind,ruleCode,value' ||
      typeof target.ruleCode !== 'string' ||
      !target.ruleCode.trim() ||
      target.ruleCode.length > 200 ||
      codes.has(target.ruleCode) ||
      typeof target.value !== 'string' ||
      !target.value.length ||
      target.value.length > 256 ||
      [...target.value].some((character) => character.charCodeAt(0) < 32) ||
      !['NUMBER', 'STRING', 'BOOLEAN'].includes(String(target.kind))
    )
      return invalid();
    if (
      target.kind === 'NUMBER' &&
      (!/^-?\d{1,12}(?:\.\d{1,12})?$/.test(target.value) || !Number.isFinite(Number(target.value)))
    )
      return invalid();
    if (target.kind === 'BOOLEAN' && !['true', 'false'].includes(target.value)) return invalid();
    codes.add(target.ruleCode);
  }
  return output as unknown as AIFormattingProposal;
}
