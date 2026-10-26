/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: contracts/schemas/rule-proposal.schema.json
 * Regenerate: pnpm --filter @palcert/contracts run generate:evaluation
 *
 * Editing this by hand would reintroduce exactly the drift the generation step
 * exists to prevent.
 */
/**
 * The model's own handle for one proposal, used only to express relationships between entries in the same response. PalCert assigns the durable identifier.
 *
 * This interface was referenced by `PalCertRuleProposalOutput`'s JSON-Schema
 * via the `definition` "ProposalKey".
 */
export type ProposalKey = string;
/**
 * An identifier PalCert supplied with the evidence. An id PalCert never sent is a fabricated citation and invalidates the whole response (§55).
 *
 * This interface was referenced by `PalCertRuleProposalOutput`'s JSON-Schema
 * via the `definition` "EvidenceId".
 */
export type EvidenceId = string;
/**
 * A stable identifier for the rule. PalCert re-checks the naming convention, resolves conflicts and lets the reviewer change it, so this is a suggestion rather than a decision (§60).
 *
 * This interface was referenced by `PalCertRuleProposalOutput`'s JSON-Schema
 * via the `definition` "RuleCode".
 */
export type RuleCode = string;
/**
 * This interface was referenced by `PalCertRuleProposalOutput`'s JSON-Schema
 * via the `definition` "RuleCategory".
 */
export type RuleCategory =
  | 'PAGE_SETUP'
  | 'MARGINS'
  | 'TYPOGRAPHY'
  | 'SPACING'
  | 'ALIGNMENT'
  | 'PAGINATION'
  | 'HEADINGS'
  | 'TITLE_PAGE'
  | 'ABSTRACT'
  | 'KEYWORDS'
  | 'TABLE_OF_CONTENTS'
  | 'SECTION_STRUCTURE'
  | 'TABLES'
  | 'FIGURES'
  | 'CAPTIONS'
  | 'EQUATIONS'
  | 'CITATIONS'
  | 'REFERENCES'
  | 'LANGUAGE_QUALITY'
  | 'TERMINOLOGY'
  | 'RESEARCH_ETHICS'
  | 'DOCUMENT_METADATA'
  | 'FILE_TECHNICAL';
/**
 * A suggestion. PalCert validates that the mode is compatible with the scope and operator, and the reviewer may change it before accepting (§49).
 *
 * This interface was referenced by `PalCertRuleProposalOutput`'s JSON-Schema
 * via the `definition` "RuleEvaluationMode".
 */
export type RuleEvaluationMode = 'DETERMINISTIC' | 'AI_ASSISTED' | 'MANUAL';
/**
 * What the rule is measured against, in exactly the Phase 3 shapes.
 *
 * This interface was referenced by `PalCertRuleProposalOutput`'s JSON-Schema
 * via the `definition` "RuleScope".
 */
export type RuleScope =
  | {
      kind: 'DOCUMENT';
      property: PropertyKey;
    }
  | {
      kind: 'SECTION';
      sectionKey: ScopeKey;
      property: PropertyKey;
    }
  | {
      kind: 'ELEMENT';
      elementType: RuleElementType;
      level?: number;
      property: PropertyKey;
    }
  | {
      kind: 'METADATA';
      field: PropertyKey;
    }
  | {
      kind: 'PAGE';
      pages: RulePageSelector;
      property: PropertyKey;
    };
/**
 * A property from the analyzer's catalogue, supplied with the prompt. An invented property is rejected (§51).
 *
 * This interface was referenced by `PalCertRuleProposalOutput`'s JSON-Schema
 * via the `definition` "PropertyKey".
 */
export type PropertyKey = string;
/**
 * This interface was referenced by `PalCertRuleProposalOutput`'s JSON-Schema
 * via the `definition` "ScopeKey".
 */
export type ScopeKey = string;
/**
 * This interface was referenced by `PalCertRuleProposalOutput`'s JSON-Schema
 * via the `definition` "RuleElementType".
 */
export type RuleElementType =
  | 'HEADING'
  | 'PARAGRAPH'
  | 'TABLE'
  | 'FIGURE'
  | 'CAPTION'
  | 'LIST'
  | 'FOOTNOTE'
  | 'ENDNOTE'
  | 'TEXTBOX'
  | 'CITATION'
  | 'REFERENCE_ENTRY'
  | 'EQUATION'
  | 'HEADER'
  | 'FOOTER';
/**
 * This interface was referenced by `PalCertRuleProposalOutput`'s JSON-Schema
 * via the `definition` "RulePageSelector".
 */
export type RulePageSelector = 'ALL' | 'FIRST' | 'LAST' | 'ODD' | 'EVEN';
/**
 * This interface was referenced by `PalCertRuleProposalOutput`'s JSON-Schema
 * via the `definition` "RuleOperator".
 */
export type RuleOperator =
  | 'EQUALS'
  | 'NOT_EQUALS'
  | 'GREATER_THAN'
  | 'GREATER_THAN_OR_EQUAL'
  | 'LESS_THAN'
  | 'LESS_THAN_OR_EQUAL'
  | 'BETWEEN'
  | 'IN'
  | 'NOT_IN'
  | 'CONTAINS'
  | 'NOT_CONTAINS'
  | 'MATCHES_PATTERN'
  | 'EXISTS'
  | 'NOT_EXISTS';
/**
 * The operand, in exactly the Phase 3 shapes. PalCert re-checks operator/operand compatibility; a combination the schema allows but the validator refuses becomes an INVALID_PROPOSAL rather than a rule (§59).
 *
 * This interface was referenced by `PalCertRuleProposalOutput`'s JSON-Schema
 * via the `definition` "RuleExpectedValue".
 */
export type RuleExpectedValue =
  | {
      type: 'NUMBER';
      number: RuleMeasurement;
    }
  | {
      type: 'STRING';
      text: string;
    }
  | {
      type: 'BOOLEAN';
      boolean: boolean;
    }
  | {
      type: 'NUMBER_RANGE';
      min: RuleMeasurement;
      max: RuleMeasurement;
    }
  | {
      type: 'STRING_LIST';
      /**
       * @minItems 1
       * @maxItems 50
       */
      values: [string, ...string[]];
    }
  | {
      type: 'NUMBER_LIST';
      /**
       * @minItems 1
       * @maxItems 50
       */
      values: [RuleMeasurement, ...RuleMeasurement[]];
    }
  | {
      type: 'PATTERN';
      pattern: RulePatternName;
      argument?: string;
    }
  | {
      type: 'NONE';
    };
/**
 * A measurement in a rule definition. The Phase 3 rule schema uses JSON numbers here; the exact decimal strings of ADR-0027 belong to the fact and evaluation model, which is a different contract.
 *
 * This interface was referenced by `PalCertRuleProposalOutput`'s JSON-Schema
 * via the `definition` "RuleMeasurement".
 */
export type RuleMeasurement = number;
/**
 * A name from PalCert's pattern registry. The model selects a registered pattern; it never writes one. A model-authored regular expression would be executable semantics arriving from outside the system (§50).
 *
 * This interface was referenced by `PalCertRuleProposalOutput`'s JSON-Schema
 * via the `definition` "RulePatternName".
 */
export type RulePatternName =
  | 'STARTS_WITH'
  | 'ENDS_WITH'
  | 'DIGITS_ONLY'
  | 'LETTERS_ONLY'
  | 'NO_LEADING_WHITESPACE'
  | 'NO_TRAILING_WHITESPACE'
  | 'SENTENCE_CASE'
  | 'TITLE_CASE'
  | 'UPPERCASE'
  | 'ARABIC_SCRIPT'
  | 'LATIN_SCRIPT'
  | 'DOI'
  | 'ISSN'
  | 'ISBN'
  | 'EMAIL'
  | 'URL';
/**
 * This interface was referenced by `PalCertRuleProposalOutput`'s JSON-Schema
 * via the `definition` "RuleUnit".
 */
export type RuleUnit =
  | 'COUNT'
  | 'MILLIMETRE'
  | 'CENTIMETRE'
  | 'INCH'
  | 'POINT'
  | 'PIXEL'
  | 'PERCENT'
  | 'LINES'
  | 'WORDS'
  | 'CHARACTERS'
  | 'PAGES'
  | 'MEGABYTE'
  | 'DPI';
/**
 * This interface was referenced by `PalCertRuleProposalOutput`'s JSON-Schema
 * via the `definition` "RuleSeverity".
 */
export type RuleSeverity = 'CRITICAL' | 'MAJOR' | 'MINOR' | 'INFO';
/**
 * This interface was referenced by `PalCertRuleProposalOutput`'s JSON-Schema
 * via the `definition` "RuleAutofixCapability".
 */
export type RuleAutofixCapability = 'NONE' | 'SAFE' | 'ADVANCED';
/**
 * The normative source category — what kind of authority requires this. Never a record of which tool extracted it: AI is the extraction mechanism, not the authority (§124).
 *
 * This interface was referenced by `PalCertRuleProposalOutput`'s JSON-Schema
 * via the `definition` "RuleOrigin".
 */
export type RuleOrigin =
  | 'ORGANIZATION_POLICY'
  | 'NATIONAL_REGULATION'
  | 'PUBLISHER_GUIDELINE'
  | 'STYLE_GUIDE'
  | 'ACCESSIBILITY_STANDARD'
  | 'PALCERT_TEMPLATE'
  | 'OTHER';
/**
 * This interface was referenced by `PalCertRuleProposalOutput`'s JSON-Schema
 * via the `definition` "ShortText".
 */
export type ShortText = string;
/**
 * This interface was referenced by `PalCertRuleProposalOutput`'s JSON-Schema
 * via the `definition` "Prose".
 */
export type Prose = string;

/**
 * The structured output of extraction Pass B (Phase 9, §41, §43, §50). Pass A grounds evidence with provider citations; this pass turns verified evidence and deterministic template observations into proposals. It is the only shape the model may return, and it is validated again inside PalCert before anything is stored. Everything semantic is a closed enumeration drawn from the existing Rule Schema: the model selects from PalCert's vocabulary and never invents one. No regular expression, query, path or expression of any kind appears anywhere in this schema, because rules are data and never code (ADR-0022).
 */
export interface PalCertRuleProposalOutput {
  /**
   * One entry per candidate requirement. An empty list is a legitimate answer when the supplied evidence states no requirement PalCert can express; inventing entries to look thorough is the failure this schema exists to prevent.
   *
   * @minItems 0
   * @maxItems 200
   */
  proposals: RuleProposal[];
}
/**
 * This interface was referenced by `PalCertRuleProposalOutput`'s JSON-Schema
 * via the `definition` "RuleProposal".
 */
export interface RuleProposal {
  proposalKey: ProposalKey;
  /**
   * EXPLICIT_REQUIREMENT: the source states it. TEMPLATE_INFERENCE: a template does it consistently, which is not the same thing. AMBIGUOUS_REQUIREMENT: the source requires something but does not say what — say so rather than choosing a value (§47). CONFLICTING_REQUIREMENT: two sources disagree; report both and pick neither (§62). UNREPRESENTABLE_REQUIREMENT: a real requirement PalCert's rule schema cannot express; report it rather than forcing it into an unrelated property (§48).
   */
  kind:
    | 'EXPLICIT_REQUIREMENT'
    | 'TEMPLATE_INFERENCE'
    | 'AMBIGUOUS_REQUIREMENT'
    | 'CONFLICTING_REQUIREMENT'
    | 'UNREPRESENTABLE_REQUIREMENT';
  /**
   * The supplied evidence this rests on. Only ids PalCert provided; at least one for anything claiming the source states a requirement (§54, §160).
   *
   * @maxItems 20
   */
  evidenceIds:
    | []
    | [EvidenceId]
    | [EvidenceId, EvidenceId]
    | [EvidenceId, EvidenceId, EvidenceId]
    | [EvidenceId, EvidenceId, EvidenceId, EvidenceId]
    | [EvidenceId, EvidenceId, EvidenceId, EvidenceId, EvidenceId]
    | [EvidenceId, EvidenceId, EvidenceId, EvidenceId, EvidenceId, EvidenceId]
    | [EvidenceId, EvidenceId, EvidenceId, EvidenceId, EvidenceId, EvidenceId, EvidenceId]
    | [
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
      ]
    | [
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
      ]
    | [
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
      ]
    | [
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
      ]
    | [
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
      ]
    | [
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
      ]
    | [
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
      ]
    | [
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
      ]
    | [
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
      ]
    | [
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
      ]
    | [
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
      ]
    | [
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
      ]
    | [
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
        EvidenceId,
      ];
  suggestedRule?: SuggestedRule;
  /**
   * What the source requires, in plain English. A reading of the supplied evidence — never a quotation invented to look like one (§56).
   */
  interpretationEn: string;
  /**
   * The same reading in Arabic. Where the source is not Arabic this is an AI-generated translation, and PalCert labels it as one rather than implying the wording was in the document (§127).
   */
  interpretationAr: string;
  /**
   * What a person would have to decide before this could become a rule. Required in substance for AMBIGUOUS_REQUIREMENT.
   */
  ambiguityNote?: string;
  requiresClarification: boolean;
  /**
   * Other entries in this same response that bear on this one — the two halves of a conflict, or a duplicate.
   *
   * @maxItems 20
   */
  relatedProposalKeys?:
    | []
    | [ProposalKey]
    | [ProposalKey, ProposalKey]
    | [ProposalKey, ProposalKey, ProposalKey]
    | [ProposalKey, ProposalKey, ProposalKey, ProposalKey]
    | [ProposalKey, ProposalKey, ProposalKey, ProposalKey, ProposalKey]
    | [ProposalKey, ProposalKey, ProposalKey, ProposalKey, ProposalKey, ProposalKey]
    | [ProposalKey, ProposalKey, ProposalKey, ProposalKey, ProposalKey, ProposalKey, ProposalKey]
    | [
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
      ]
    | [
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
      ]
    | [
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
      ]
    | [
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
      ]
    | [
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
      ]
    | [
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
      ]
    | [
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
      ]
    | [
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
      ]
    | [
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
      ]
    | [
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
      ]
    | [
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
      ]
    | [
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
      ]
    | [
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
        ProposalKey,
      ];
}
/**
 * A candidate rule definition. It is a suggestion in the strict sense: PalCert validates it against the target draft's own Rule Schema version, and a person decides whether it becomes a rule at all (§58, §67).
 *
 * This interface was referenced by `PalCertRuleProposalOutput`'s JSON-Schema
 * via the `definition` "SuggestedRule".
 */
export interface SuggestedRule {
  ruleCode: RuleCode;
  category: RuleCategory;
  evaluationMode: RuleEvaluationMode;
  scope: RuleScope;
  operator: RuleOperator;
  expected: RuleExpectedValue;
  unit?: RuleUnit;
  tolerance?: RuleMeasurement;
  severity: RuleSeverity;
  blocking: boolean;
  autofix: RuleAutofixCapability;
  origin: RuleOrigin;
  titleEn: ShortText;
  titleAr: ShortText;
  guidanceEn?: Prose;
  guidanceAr?: Prose;
}
