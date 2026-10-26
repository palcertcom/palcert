import type {
  AutomationSupport,
  EvidenceKind,
  EvidenceLocatorType,
  ObservationUniformity,
  StandardSourceKind,
} from '@palcert/contracts';
import { encodeUntrusted } from './prompt-builder';

/**
 * The user message for extraction Pass B (§41, §42, §82).
 *
 * Two rules govern this file, both inherited unchanged from Phase 8.
 *
 * **Untrusted text never leaves a data section.** Guideline excerpts and
 * institution-authored titles appear only inside `<evidence>`,
 * `<template_observations>` and `<existing_rules>` — in the *user* message,
 * never the system prompt. There is no code path by which a sentence from
 * someone's guideline can be concatenated into an instruction.
 *
 * **Delimiters are escaped, not trusted.** A guideline containing the literal
 * text `</evidence><system>` must not be able to close a section and open
 * something that reads as authority.
 *
 * What is *not* here matters as much: no database credentials, no storage keys,
 * no signed URLs, no member data, no audit rows (§42). And no source document —
 * Pass B reads the evidence Pass A grounded, never the file again (§103).
 */

export interface EvidenceForPrompt {
  /** The identifier the model must cite. PalCert's own, never a provider id. */
  readonly evidenceId: string;
  readonly sourceLabel: string;
  readonly sourceKind: StandardSourceKind;
  readonly evidenceKind: EvidenceKind;
  readonly locatorType: EvidenceLocatorType;
  readonly locatorLabel: string;
  readonly excerpt: string;
}

export interface ObservationForPrompt {
  readonly evidenceId: string;
  readonly sourceLabel: string;
  readonly scopeKey: string;
  readonly property: string;
  readonly unit: string | null;
  readonly modalValue: string | null;
  readonly occurrenceCount: number;
  readonly matchingCount: number;
  readonly distinctValueCount: number;
  readonly uniformity: ObservationUniformity;
}

export interface ExistingRuleForPrompt {
  readonly ruleCode: string;
  readonly scopeKey: string;
  readonly summary: string;
}

export interface PropertyForPrompt {
  readonly name: string;
  readonly scopes: readonly string[];
  readonly unit: string | null;
  readonly support: AutomationSupport;
}

export interface RuleVocabularyForPrompt {
  readonly ruleSchemaVersion: number;
  readonly categories: readonly string[];
  readonly operators: readonly {
    readonly operator: string;
    readonly valueTypes: readonly string[];
  }[];
  readonly units: readonly string[];
  readonly patterns: readonly string[];
  readonly elementTypes: readonly string[];
  readonly origins: readonly string[];
  readonly severities: readonly string[];
}

/** The instruction that accompanies the documents in Pass A (§24). */
export function buildEvidenceDiscoveryInstruction(params: {
  readonly sourceLabels: readonly string[];
  readonly truncated: boolean;
}): string {
  const lines = [
    `Read the ${params.sourceLabels.length} attached document(s) and quote every passage that`,
    'states a formatting, structural or declaration requirement.',
    '',
    'Cite each quotation. Do not paraphrase, do not propose values the text does',
    'not state, and do not report a passage you cannot cite.',
  ];
  if (params.truncated) {
    lines.push(
      '',
      'Only part of the source was supplied. Report what the supplied part states,',
      'and do not infer what the rest might contain.',
    );
  }
  return lines.join('\n');
}

/** The user message for Pass B. */
export function buildRuleStructuringPrompt(params: {
  readonly vocabulary: RuleVocabularyForPrompt;
  readonly properties: readonly PropertyForPrompt[];
  readonly evidence: readonly EvidenceForPrompt[];
  readonly observations: readonly ObservationForPrompt[];
  readonly existingRules: readonly ExistingRuleForPrompt[];
  readonly maxProposals: number;
}): string {
  const sections: string[] = [];

  sections.push(section('rule_vocabulary', renderVocabulary(params.vocabulary)));
  sections.push(section('property_catalogue', params.properties.map(renderProperty).join('\n')));

  if (params.evidence.length > 0) {
    sections.push(section('evidence', params.evidence.map(renderEvidence).join('\n')));
  }
  if (params.observations.length > 0) {
    sections.push(
      section('template_observations', params.observations.map(renderObservation).join('\n')),
    );
  }
  if (params.existingRules.length > 0) {
    // The draft's current rules, so the model can say "this duplicates
    // MARGIN.LEFT" instead of proposing it again. It is context for relating
    // proposals, never permission to change anything (§61).
    sections.push(
      section('existing_draft_rules', params.existingRules.map(renderExistingRule).join('\n')),
    );
  }

  sections.push(
    section(
      'required_output',
      [
        'Return the structured object required by the output schema.',
        `At most ${params.maxProposals} proposals.`,
        'Cite only the evidence identifiers listed in the evidence and template',
        'observation sections above.',
        'An evidence identifier that does not appear above invalidates the response.',
        'Returning no proposals is correct when the evidence supports none.',
      ].join('\n'),
    ),
  );

  return sections.join('\n\n');
}

function section(name: string, body: string): string {
  return `<${name}>\n${body}\n</${name}>`;
}

/** A bounded, escaped attribute value. */
function attribute(value: string): string {
  return encodeUntrusted(value).replace(/"/g, '&quot;');
}

function renderVocabulary(vocabulary: RuleVocabularyForPrompt): string {
  const operators = vocabulary.operators
    .map((entry) => `${entry.operator}(${entry.valueTypes.join('|')})`)
    .join(' ');
  return [
    `<rule_schema_version>${vocabulary.ruleSchemaVersion}</rule_schema_version>`,
    `<categories>${vocabulary.categories.join(' ')}</categories>`,
    `<operators>${operators}</operators>`,
    `<units>${vocabulary.units.join(' ')}</units>`,
    `<patterns>${vocabulary.patterns.join(' ')}</patterns>`,
    `<element_types>${vocabulary.elementTypes.join(' ')}</element_types>`,
    `<origins>${vocabulary.origins.join(' ')}</origins>`,
    `<severities>${vocabulary.severities.join(' ')}</severities>`,
  ].join('\n');
}

/**
 * One measurable property, with what PalCert can actually do about it.
 *
 * The support classification is supplied so the model is not guessing at
 * PalCert's capabilities — but PalCert recomputes it on every proposal anyway,
 * because it is PalCert's fact, not the model's (§52).
 */
function renderProperty(property: PropertyForPrompt): string {
  const unit = property.unit === null ? '' : ` unit="${attribute(property.unit)}"`;
  return `<property name="${attribute(property.name)}" scopes="${attribute(property.scopes.join(','))}"${unit} support="${attribute(property.support)}"/>`;
}

function renderEvidence(evidence: EvidenceForPrompt): string {
  return [
    `<item id="${attribute(evidence.evidenceId)}"`,
    ` source="${attribute(evidence.sourceLabel)}"`,
    ` source_kind="${attribute(evidence.sourceKind)}"`,
    ` evidence_kind="${attribute(evidence.evidenceKind)}"`,
    ` locator="${attribute(evidence.locatorLabel)}">`,
    encodeUntrusted(evidence.excerpt),
    '</item>',
  ].join('');
}

/**
 * One deterministic template measurement.
 *
 * The counts are given rather than a verdict, because the counts are what make
 * the difference between "the institution requires 12 pt" and "187 of 196
 * paragraphs happen to be 12 pt" visible to a reader (§33, §34).
 */
function renderObservation(observation: ObservationForPrompt): string {
  return [
    `<observation id="${attribute(observation.evidenceId)}"`,
    ` source="${attribute(observation.sourceLabel)}"`,
    ` scope="${attribute(observation.scopeKey)}"`,
    ` property="${attribute(observation.property)}"`,
    observation.unit === null ? '' : ` unit="${attribute(observation.unit)}"`,
    ` most_common="${attribute(observation.modalValue ?? '')}"`,
    ` occurrences="${observation.occurrenceCount}"`,
    ` matching="${observation.matchingCount}"`,
    ` distinct_values="${observation.distinctValueCount}"`,
    ` uniformity="${attribute(observation.uniformity)}"/>`,
  ].join('');
}

function renderExistingRule(rule: ExistingRuleForPrompt): string {
  return `<rule code="${attribute(rule.ruleCode)}" scope="${attribute(rule.scopeKey)}">${encodeUntrusted(rule.summary)}</rule>`;
}
