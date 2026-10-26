/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: contracts/schemas/evaluation.schema.json
 * Regenerate: pnpm --filter @palcert/contracts run generate:evaluation
 *
 * Editing this by hand would reintroduce exactly the drift the generation step
 * exists to prevent.
 */

/** The rule proposal JSON Schema, embedded verbatim from the source of truth. */
export const RULE_PROPOSAL_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://palcert.ps/schemas/rule-proposal.schema.json',
  title: 'PalCertRuleProposalOutput',
  description:
    "The structured output of extraction Pass B (Phase 9, §41, §43, §50). Pass A grounds evidence with provider citations; this pass turns verified evidence and deterministic template observations into proposals. It is the only shape the model may return, and it is validated again inside PalCert before anything is stored. Everything semantic is a closed enumeration drawn from the existing Rule Schema: the model selects from PalCert's vocabulary and never invents one. No regular expression, query, path or expression of any kind appears anywhere in this schema, because rules are data and never code (ADR-0022).",
  type: 'object',
  additionalProperties: false,
  required: ['proposals'],
  properties: {
    proposals: {
      description:
        'One entry per candidate requirement. An empty list is a legitimate answer when the supplied evidence states no requirement PalCert can express; inventing entries to look thorough is the failure this schema exists to prevent.',
      type: 'array',
      minItems: 0,
      maxItems: 200,
      items: {
        $ref: '#/$defs/RuleProposal',
      },
    },
  },
  $defs: {
    ProposalKey: {
      description:
        "The model's own handle for one proposal, used only to express relationships between entries in the same response. PalCert assigns the durable identifier.",
      type: 'string',
      pattern: '^[A-Za-z0-9._:-]{1,64}$',
    },
    EvidenceId: {
      description:
        'An identifier PalCert supplied with the evidence. An id PalCert never sent is a fabricated citation and invalidates the whole response (§55).',
      type: 'string',
      minLength: 1,
      maxLength: 64,
    },
    RuleCode: {
      description:
        'A stable identifier for the rule. PalCert re-checks the naming convention, resolves conflicts and lets the reviewer change it, so this is a suggestion rather than a decision (§60).',
      type: 'string',
      pattern: '^[A-Z][A-Z0-9]*(\\.[A-Z0-9]+)*$',
      maxLength: 100,
    },
    ShortText: {
      type: 'string',
      minLength: 1,
      maxLength: 300,
    },
    Prose: {
      type: 'string',
      minLength: 1,
      maxLength: 2000,
    },
    RuleCategory: {
      enum: [
        'PAGE_SETUP',
        'MARGINS',
        'TYPOGRAPHY',
        'SPACING',
        'ALIGNMENT',
        'PAGINATION',
        'HEADINGS',
        'TITLE_PAGE',
        'ABSTRACT',
        'KEYWORDS',
        'TABLE_OF_CONTENTS',
        'SECTION_STRUCTURE',
        'TABLES',
        'FIGURES',
        'CAPTIONS',
        'EQUATIONS',
        'CITATIONS',
        'REFERENCES',
        'LANGUAGE_QUALITY',
        'TERMINOLOGY',
        'RESEARCH_ETHICS',
        'DOCUMENT_METADATA',
        'FILE_TECHNICAL',
      ],
    },
    RuleEvaluationMode: {
      description:
        'A suggestion. PalCert validates that the mode is compatible with the scope and operator, and the reviewer may change it before accepting (§49).',
      enum: ['DETERMINISTIC', 'AI_ASSISTED', 'MANUAL'],
    },
    RuleSeverity: {
      enum: ['CRITICAL', 'MAJOR', 'MINOR', 'INFO'],
    },
    RuleAutofixCapability: {
      enum: ['NONE', 'SAFE', 'ADVANCED'],
    },
    RuleOrigin: {
      description:
        'The normative source category — what kind of authority requires this. Never a record of which tool extracted it: AI is the extraction mechanism, not the authority (§124).',
      enum: [
        'ORGANIZATION_POLICY',
        'NATIONAL_REGULATION',
        'PUBLISHER_GUIDELINE',
        'STYLE_GUIDE',
        'ACCESSIBILITY_STANDARD',
        'PALCERT_TEMPLATE',
        'OTHER',
      ],
    },
    RuleUnit: {
      enum: [
        'COUNT',
        'MILLIMETRE',
        'CENTIMETRE',
        'INCH',
        'POINT',
        'PIXEL',
        'PERCENT',
        'LINES',
        'WORDS',
        'CHARACTERS',
        'PAGES',
        'MEGABYTE',
        'DPI',
      ],
    },
    RuleOperator: {
      enum: [
        'EQUALS',
        'NOT_EQUALS',
        'GREATER_THAN',
        'GREATER_THAN_OR_EQUAL',
        'LESS_THAN',
        'LESS_THAN_OR_EQUAL',
        'BETWEEN',
        'IN',
        'NOT_IN',
        'CONTAINS',
        'NOT_CONTAINS',
        'MATCHES_PATTERN',
        'EXISTS',
        'NOT_EXISTS',
      ],
    },
    RuleElementType: {
      enum: [
        'HEADING',
        'PARAGRAPH',
        'TABLE',
        'FIGURE',
        'CAPTION',
        'LIST',
        'FOOTNOTE',
        'ENDNOTE',
        'TEXTBOX',
        'CITATION',
        'REFERENCE_ENTRY',
        'EQUATION',
        'HEADER',
        'FOOTER',
      ],
    },
    RulePageSelector: {
      enum: ['ALL', 'FIRST', 'LAST', 'ODD', 'EVEN'],
    },
    RulePatternName: {
      description:
        "A name from PalCert's pattern registry. The model selects a registered pattern; it never writes one. A model-authored regular expression would be executable semantics arriving from outside the system (§50).",
      enum: [
        'STARTS_WITH',
        'ENDS_WITH',
        'DIGITS_ONLY',
        'LETTERS_ONLY',
        'NO_LEADING_WHITESPACE',
        'NO_TRAILING_WHITESPACE',
        'SENTENCE_CASE',
        'TITLE_CASE',
        'UPPERCASE',
        'ARABIC_SCRIPT',
        'LATIN_SCRIPT',
        'DOI',
        'ISSN',
        'ISBN',
        'EMAIL',
        'URL',
      ],
    },
    ScopeKey: {
      type: 'string',
      pattern: '^[A-Z][A-Z0-9_]{0,63}$',
    },
    PropertyKey: {
      description:
        "A property from the analyzer's catalogue, supplied with the prompt. An invented property is rejected (§51).",
      type: 'string',
      pattern: '^[a-z][a-zA-Z0-9]{0,63}$',
    },
    RuleScope: {
      description: 'What the rule is measured against, in exactly the Phase 3 shapes.',
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'property'],
          properties: {
            kind: {
              const: 'DOCUMENT',
            },
            property: {
              $ref: '#/$defs/PropertyKey',
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'sectionKey', 'property'],
          properties: {
            kind: {
              const: 'SECTION',
            },
            sectionKey: {
              $ref: '#/$defs/ScopeKey',
            },
            property: {
              $ref: '#/$defs/PropertyKey',
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'elementType', 'property'],
          properties: {
            kind: {
              const: 'ELEMENT',
            },
            elementType: {
              $ref: '#/$defs/RuleElementType',
            },
            level: {
              type: 'integer',
              minimum: 1,
              maximum: 9,
            },
            property: {
              $ref: '#/$defs/PropertyKey',
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'field'],
          properties: {
            kind: {
              const: 'METADATA',
            },
            field: {
              $ref: '#/$defs/PropertyKey',
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'pages', 'property'],
          properties: {
            kind: {
              const: 'PAGE',
            },
            pages: {
              $ref: '#/$defs/RulePageSelector',
            },
            property: {
              $ref: '#/$defs/PropertyKey',
            },
          },
        },
      ],
    },
    RuleExpectedValue: {
      description:
        'The operand, in exactly the Phase 3 shapes. PalCert re-checks operator/operand compatibility; a combination the schema allows but the validator refuses becomes an INVALID_PROPOSAL rather than a rule (§59).',
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'number'],
          properties: {
            type: {
              const: 'NUMBER',
            },
            number: {
              $ref: '#/$defs/RuleMeasurement',
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'text'],
          properties: {
            type: {
              const: 'STRING',
            },
            text: {
              type: 'string',
              minLength: 1,
              maxLength: 500,
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'boolean'],
          properties: {
            type: {
              const: 'BOOLEAN',
            },
            boolean: {
              type: 'boolean',
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'min', 'max'],
          properties: {
            type: {
              const: 'NUMBER_RANGE',
            },
            min: {
              $ref: '#/$defs/RuleMeasurement',
            },
            max: {
              $ref: '#/$defs/RuleMeasurement',
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'values'],
          properties: {
            type: {
              const: 'STRING_LIST',
            },
            values: {
              type: 'array',
              minItems: 1,
              maxItems: 50,
              items: {
                type: 'string',
                minLength: 1,
                maxLength: 200,
              },
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'values'],
          properties: {
            type: {
              const: 'NUMBER_LIST',
            },
            values: {
              type: 'array',
              minItems: 1,
              maxItems: 50,
              items: {
                $ref: '#/$defs/RuleMeasurement',
              },
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'pattern'],
          properties: {
            type: {
              const: 'PATTERN',
            },
            pattern: {
              $ref: '#/$defs/RulePatternName',
            },
            argument: {
              type: 'string',
              minLength: 1,
              maxLength: 200,
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['type'],
          properties: {
            type: {
              const: 'NONE',
            },
          },
        },
      ],
    },
    SuggestedRule: {
      description:
        "A candidate rule definition. It is a suggestion in the strict sense: PalCert validates it against the target draft's own Rule Schema version, and a person decides whether it becomes a rule at all (§58, §67).",
      type: 'object',
      additionalProperties: false,
      required: [
        'ruleCode',
        'category',
        'evaluationMode',
        'scope',
        'operator',
        'expected',
        'severity',
        'blocking',
        'autofix',
        'origin',
        'titleEn',
        'titleAr',
      ],
      properties: {
        ruleCode: {
          $ref: '#/$defs/RuleCode',
        },
        category: {
          $ref: '#/$defs/RuleCategory',
        },
        evaluationMode: {
          $ref: '#/$defs/RuleEvaluationMode',
        },
        scope: {
          $ref: '#/$defs/RuleScope',
        },
        operator: {
          $ref: '#/$defs/RuleOperator',
        },
        expected: {
          $ref: '#/$defs/RuleExpectedValue',
        },
        unit: {
          $ref: '#/$defs/RuleUnit',
        },
        tolerance: {
          $ref: '#/$defs/RuleMeasurement',
        },
        severity: {
          $ref: '#/$defs/RuleSeverity',
        },
        blocking: {
          type: 'boolean',
        },
        autofix: {
          $ref: '#/$defs/RuleAutofixCapability',
        },
        origin: {
          $ref: '#/$defs/RuleOrigin',
        },
        titleEn: {
          $ref: '#/$defs/ShortText',
        },
        titleAr: {
          $ref: '#/$defs/ShortText',
        },
        guidanceEn: {
          $ref: '#/$defs/Prose',
        },
        guidanceAr: {
          $ref: '#/$defs/Prose',
        },
      },
    },
    RuleProposal: {
      type: 'object',
      additionalProperties: false,
      required: [
        'proposalKey',
        'kind',
        'evidenceIds',
        'interpretationEn',
        'interpretationAr',
        'requiresClarification',
      ],
      properties: {
        proposalKey: {
          $ref: '#/$defs/ProposalKey',
        },
        kind: {
          description:
            "EXPLICIT_REQUIREMENT: the source states it. TEMPLATE_INFERENCE: a template does it consistently, which is not the same thing. AMBIGUOUS_REQUIREMENT: the source requires something but does not say what — say so rather than choosing a value (§47). CONFLICTING_REQUIREMENT: two sources disagree; report both and pick neither (§62). UNREPRESENTABLE_REQUIREMENT: a real requirement PalCert's rule schema cannot express; report it rather than forcing it into an unrelated property (§48).",
          enum: [
            'EXPLICIT_REQUIREMENT',
            'TEMPLATE_INFERENCE',
            'AMBIGUOUS_REQUIREMENT',
            'CONFLICTING_REQUIREMENT',
            'UNREPRESENTABLE_REQUIREMENT',
          ],
        },
        evidenceIds: {
          description:
            'The supplied evidence this rests on. Only ids PalCert provided; at least one for anything claiming the source states a requirement (§54, §160).',
          type: 'array',
          maxItems: 20,
          items: {
            $ref: '#/$defs/EvidenceId',
          },
        },
        suggestedRule: {
          $ref: '#/$defs/SuggestedRule',
        },
        interpretationEn: {
          description:
            'What the source requires, in plain English. A reading of the supplied evidence — never a quotation invented to look like one (§56).',
          $ref: '#/$defs/Prose',
        },
        interpretationAr: {
          description:
            'The same reading in Arabic. Where the source is not Arabic this is an AI-generated translation, and PalCert labels it as one rather than implying the wording was in the document (§127).',
          $ref: '#/$defs/Prose',
        },
        ambiguityNote: {
          description:
            'What a person would have to decide before this could become a rule. Required in substance for AMBIGUOUS_REQUIREMENT.',
          $ref: '#/$defs/Prose',
        },
        requiresClarification: {
          type: 'boolean',
        },
        relatedProposalKeys: {
          description:
            'Other entries in this same response that bear on this one — the two halves of a conflict, or a duplicate.',
          type: 'array',
          maxItems: 20,
          items: {
            $ref: '#/$defs/ProposalKey',
          },
        },
      },
    },
    RuleMeasurement: {
      description:
        'A measurement in a rule definition. The Phase 3 rule schema uses JSON numbers here; the exact decimal strings of ADR-0027 belong to the fact and evaluation model, which is a different contract.',
      type: 'number',
    },
  },
} as const;
