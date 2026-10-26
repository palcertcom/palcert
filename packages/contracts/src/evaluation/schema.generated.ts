/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: contracts/schemas/evaluation.schema.json
 * Regenerate: pnpm --filter @palcert/contracts run generate:evaluation
 *
 * Editing this by hand would reintroduce exactly the drift the generation step
 * exists to prevent.
 */

/** The evaluation JSON Schema, embedded verbatim from the source of truth. */
export const EVALUATION_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://palcert.com/schemas/evaluation.schema.json',
  title: 'PalCert deterministic evaluation contracts',
  description:
    'The authoritative wire contract shared by the TypeScript API and the Python document engine. TypeScript types are GENERATED from this file (packages/contracts/src/evaluation/generated.ts); Python validates against it directly. Neither language hand-maintains a parallel definition, so the two cannot drift silently.',
  $defs: {
    DecimalString: {
      title: 'DecimalString',
      description:
        'An exact decimal number carried as a string. Numbers cross this boundary as strings rather than JSON numbers because JSON numbers are read back as binary floats, and 0.1 + 0.2 is not 0.3 in a measurement that decides whether a thesis complies. Parsed with Decimal in Python and compared as an exact rational.',
      type: 'string',
      pattern: '^-?(0|[1-9][0-9]{0,17})(\\.[0-9]{1,12})?$',
    },
    FactSchemaVersion: {
      title: 'FactSchemaVersion',
      description:
        '1: the Phase 4 vocabulary. 2: adds the ENDNOTE and TEXTBOX element types, which WordprocessingML stories require and which version 1 cannot express without misfiling note or text-box content as ordinary body paragraphs. Nothing else differs, and a version 1 fact set remains valid for ever.',
      type: 'integer',
      minimum: 1,
      maximum: 1000,
    },
    Unit: {
      title: 'Unit',
      description:
        'A PalCert canonical unit. Identical to the Phase 3 RuleUnit vocabulary; a second, incompatible unit list would be the fastest route to a wrong measurement.',
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
    RuleScopeKind: {
      title: 'RuleScopeKind',
      enum: ['DOCUMENT', 'SECTION', 'ELEMENT', 'METADATA', 'PAGE'],
    },
    RuleElementType: {
      title: 'RuleElementType',
      description:
        'ENDNOTE and TEXTBOX were introduced with fact schema version 2 (Phase 6). They are valid in a rule scope at any version, but a DocumentFactSet declaring factSchemaVersion 1 may not use them: see FactSchemaVersion and the version-aware check in both validators.',
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
      title: 'RulePageSelector',
      enum: ['ALL', 'FIRST', 'LAST', 'ODD', 'EVEN'],
    },
    FactScope: {
      title: 'FactScope',
      description:
        'Where an observation was made. Deliberately the same shape as the Phase 3 RuleScope, so selecting facts for a rule is structural matching on identifying fields — never string-parsing a ruleCode such as BODY.FONT.SIZE.\n\nExpressed as fully-specified oneOf branches rather than if/then: each variant is closed, so a DOCUMENT scope carrying an elementType is rejected rather than quietly ignored, and both the TypeScript and Python validators interpret it identically.',
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
              type: 'string',
              pattern: '^[a-z][a-zA-Z0-9]{0,63}$',
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
              type: 'string',
              pattern: '^[A-Z][A-Z0-9_]{0,63}$',
            },
            property: {
              type: 'string',
              pattern: '^[a-z][a-zA-Z0-9]{0,63}$',
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
              type: 'string',
              pattern: '^[a-z][a-zA-Z0-9]{0,63}$',
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
              type: 'string',
              pattern: '^[a-z][a-zA-Z0-9]{0,63}$',
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
              type: 'string',
              pattern: '^[a-z][a-zA-Z0-9]{0,63}$',
            },
          },
        },
      ],
    },
    Location: {
      title: 'Location',
      description:
        'Where in the document something was observed. `nodeId` is the only required locator: page number is frequently unknown during structural DOCX extraction, and requiring it would force every extractor to invent one.',
      type: 'object',
      additionalProperties: false,
      required: ['locationSchemaVersion', 'nodeId'],
      properties: {
        locationSchemaVersion: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
        },
        nodeId: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
        },
        page: {
          description:
            '1-based page number, when the extractor knows it. Absent means unknown, never page zero.',
          type: 'integer',
          minimum: 1,
          maximum: 100000,
        },
        sectionKey: {
          type: 'string',
          pattern: '^[A-Z][A-Z0-9_]{0,63}$',
        },
        elementType: {
          $ref: '#/$defs/RuleElementType',
        },
        ordinal: {
          description:
            '1-based position among siblings of the same kind, for stable ordering and for report text such as "the 3rd table".',
          type: 'integer',
          minimum: 1,
          maximum: 1000000,
        },
        path: {
          description:
            'Structural path from the document root, e.g. ["body", "p:17", "r:2"]. Independent of pagination.',
          type: 'array',
          maxItems: 32,
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 100,
          },
        },
      },
    },
    FactValueType: {
      title: 'FactValueType',
      enum: ['STRING', 'NUMBER', 'BOOLEAN', 'ENUM', 'STRING_LIST', 'NUMBER_LIST', 'STRUCTURED'],
    },
    FactValue: {
      title: 'FactValue',
      description:
        'An observed value, discriminated on `type`. Numbers are decimal strings (see DecimalString). STRUCTURED exists so an extractor can record a composite observation without inventing a new fact type, but no Phase 4 operator consumes it — it is carried, not interpreted.',
      oneOf: [
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
              maxLength: 10000,
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'number'],
          properties: {
            type: {
              const: 'NUMBER',
            },
            number: {
              $ref: '#/$defs/DecimalString',
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
          required: ['type', 'enumValue'],
          properties: {
            type: {
              const: 'ENUM',
            },
            enumValue: {
              type: 'string',
              maxLength: 200,
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
              maxItems: 1000,
              items: {
                type: 'string',
                maxLength: 10000,
              },
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'numbers'],
          properties: {
            type: {
              const: 'NUMBER_LIST',
            },
            numbers: {
              type: 'array',
              maxItems: 1000,
              items: {
                $ref: '#/$defs/DecimalString',
              },
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'structured'],
          properties: {
            type: {
              const: 'STRUCTURED',
            },
            structured: {
              type: 'object',
              description:
                'Extractor-specific composite observation. Deliberately open: no Phase 4 operator interprets it.',
            },
          },
        },
      ],
    },
    FactProvenance: {
      title: 'FactProvenance',
      description:
        'How the observation was obtained. `confidence` is deliberately optional and must be omitted for exact extraction: inventing 1.0 for an OOXML attribute read would make a meaningless number look like a measured one.',
      type: 'object',
      additionalProperties: false,
      required: ['sourceKind'],
      properties: {
        sourceKind: {
          enum: ['OOXML', 'PDF_TEXT', 'PDF_LAYOUT', 'HEURISTIC', 'SYNTHETIC'],
        },
        confidence: {
          $ref: '#/$defs/DecimalString',
        },
        note: {
          type: 'string',
          maxLength: 500,
        },
      },
    },
    DocumentFact: {
      title: 'DocumentFact',
      type: 'object',
      additionalProperties: false,
      required: ['scope', 'value'],
      properties: {
        scope: {
          $ref: '#/$defs/FactScope',
        },
        value: {
          $ref: '#/$defs/FactValue',
        },
        unit: {
          $ref: '#/$defs/Unit',
        },
        location: {
          $ref: '#/$defs/Location',
        },
        provenance: {
          $ref: '#/$defs/FactProvenance',
        },
      },
    },
    CoverageStatus: {
      title: 'CoverageStatus',
      description:
        'How much the extractor could see of one fact domain. This is the distinction between "there are no figures" and "we could not tell whether there are figures", which changes the correct verdict.',
      enum: ['COMPLETE', 'PARTIAL', 'UNAVAILABLE'],
    },
    CoverageEntry: {
      title: 'CoverageEntry',
      description:
        'Coverage for a family of facts. The selector is matched most-specific-first: an entry naming kind+elementType+property beats one naming only kind.',
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'status'],
      properties: {
        kind: {
          $ref: '#/$defs/RuleScopeKind',
        },
        elementType: {
          $ref: '#/$defs/RuleElementType',
        },
        sectionKey: {
          type: 'string',
          pattern: '^[A-Z][A-Z0-9_]{0,63}$',
        },
        property: {
          type: 'string',
          pattern: '^[a-z][a-zA-Z0-9]{0,63}$',
        },
        field: {
          type: 'string',
          pattern: '^[a-z][a-zA-Z0-9]{0,63}$',
        },
        status: {
          $ref: '#/$defs/CoverageStatus',
        },
        note: {
          type: 'string',
          maxLength: 500,
        },
      },
    },
    Extractor: {
      title: 'Extractor',
      type: 'object',
      additionalProperties: false,
      required: ['name', 'version'],
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
        },
        version: {
          type: 'string',
          minLength: 1,
          maxLength: 50,
        },
      },
    },
    DocumentFactSet: {
      title: 'DocumentFactSet',
      description:
        'Everything a document parser hands the rule engine. The engine consumes only this — never python-docx objects, OOXML nodes, PDF parser handles or filesystem paths — which is what keeps it a pure, testable library.',
      type: 'object',
      additionalProperties: false,
      required: ['factSchemaVersion', 'documentId', 'extractor', 'coverage', 'facts'],
      properties: {
        factSchemaVersion: {
          $ref: '#/$defs/FactSchemaVersion',
        },
        documentId: {
          description:
            'Opaque to the engine. A synthetic string in tests; a PalCert document id in production. The engine never resolves it against a database.',
          type: 'string',
          minLength: 1,
          maxLength: 200,
        },
        extractor: {
          $ref: '#/$defs/Extractor',
        },
        coverage: {
          type: 'array',
          maxItems: 500,
          items: {
            $ref: '#/$defs/CoverageEntry',
          },
        },
        facts: {
          type: 'array',
          maxItems: 100000,
          items: {
            $ref: '#/$defs/DocumentFact',
          },
        },
      },
    },
    EvaluationOutcome: {
      title: 'EvaluationOutcome',
      description:
        'PASS/FAIL are deterministic verdicts. NOT_APPLICABLE means the rule legitimately does not apply. INDETERMINATE means the evidence or the evaluator cannot decide — never a disguised PASS. ERROR means the engine itself failed, and is never a disguised FAIL.',
      enum: ['PASS', 'FAIL', 'NOT_APPLICABLE', 'INDETERMINATE', 'ERROR'],
    },
    EvidenceLevel: {
      title: 'EvidenceLevel',
      description:
        'What kind of evidence produced this result. Present from Phase 4 so a later AI phase can add AI_PROVISIONAL without redesigning the result: AI output must never silently become authoritative certification evidence.\n\nADVISORY (Phase 18, Checkpoint 15) is the same refusal for heuristic evidence. A rule whose facts were inferred rather than read carries it, and such a rule is always INDETERMINATE: the observation is reported, and it never becomes the PASS or FAIL an exact rule produces. DETERMINISTIC therefore keeps its original meaning exactly — every fact behind the verdict was read from the document rather than recognized in it.',
      enum: ['NONE', 'DETERMINISTIC', 'ADVISORY', 'AI_PROVISIONAL', 'HUMAN_CONFIRMED'],
    },
    ReasonCode: {
      title: 'ReasonCode',
      description:
        'Stable, machine-readable reason. Downstream code must never parse English message text.\n\nADVISORY_EVIDENCE_ONLY says the rule matched facts PalCert inferred rather than read. It is a statement about the evidence class, not about the document: it never means the document is wrong, and it never means the document is right.',
      enum: [
        'SATISFIED',
        'VALUE_MISMATCH',
        'OUTSIDE_TOLERANCE',
        'BELOW_MINIMUM',
        'ABOVE_MAXIMUM',
        'OUTSIDE_RANGE',
        'REQUIRED_VALUE_MISSING',
        'FORBIDDEN_VALUE_PRESENT',
        'PATTERN_MISMATCH',
        'NOT_IN_ALLOWED_SET',
        'IN_FORBIDDEN_SET',
        'NO_COMPLETE_EVIDENCE',
        'NO_MATCHING_FACTS',
        'SCOPE_NOT_PRESENT',
        'UNIT_INCOMPATIBLE',
        'UNIT_MISSING',
        'VALUE_TYPE_INCOMPATIBLE',
        'EVALUATOR_NOT_SUPPORTED',
        'AI_REVIEW_REQUIRED',
        'MANUAL_REVIEW_REQUIRED',
        'FACT_SCHEMA_UNSUPPORTED',
        'RULE_SCHEMA_UNSUPPORTED',
        'RESOURCE_LIMIT_EXCEEDED',
        'ADVISORY_EVIDENCE_ONLY',
        'INTERNAL_ERROR',
      ],
    },
    MeasuredValue: {
      title: 'MeasuredValue',
      description:
        'A value as evidence, with the unit it was expressed in. Both the raw value and the normalized comparison value are carried so a report can show what the author wrote AND what was compared.',
      type: 'object',
      additionalProperties: false,
      required: ['value'],
      properties: {
        value: {
          type: 'string',
          maxLength: 10000,
        },
        unit: {
          $ref: '#/$defs/Unit',
        },
        normalizedValue: {
          $ref: '#/$defs/DecimalString',
        },
        normalizedUnit: {
          $ref: '#/$defs/Unit',
        },
      },
    },
    Violation: {
      title: 'Violation',
      description:
        'Machine-readable evidence for one failing observation. Deliberately carries no natural-language prose: report and AI layers turn this into an explanation later.',
      type: 'object',
      additionalProperties: false,
      required: ['reasonCode', 'actual'],
      properties: {
        reasonCode: {
          $ref: '#/$defs/ReasonCode',
        },
        location: {
          $ref: '#/$defs/Location',
        },
        expected: {
          $ref: '#/$defs/MeasuredValue',
        },
        actual: {
          $ref: '#/$defs/MeasuredValue',
        },
        tolerance: {
          $ref: '#/$defs/DecimalString',
        },
      },
    },
    EvaluationCounts: {
      title: 'EvaluationCounts',
      type: 'object',
      additionalProperties: false,
      required: [
        'matchedFacts',
        'evaluatedFacts',
        'passedFacts',
        'failedFacts',
        'indeterminateFacts',
      ],
      properties: {
        matchedFacts: {
          type: 'integer',
          minimum: 0,
        },
        evaluatedFacts: {
          type: 'integer',
          minimum: 0,
        },
        passedFacts: {
          type: 'integer',
          minimum: 0,
        },
        failedFacts: {
          type: 'integer',
          minimum: 0,
        },
        indeterminateFacts: {
          type: 'integer',
          minimum: 0,
        },
      },
    },
    EngineInfo: {
      title: 'EngineInfo',
      description:
        "Recorded on every result for auditability. `engineVersion` is an explicit evaluation-engine version, deliberately not the application git commit: the engine's behaviour must be identifiable independently of unrelated deployments.",
      type: 'object',
      additionalProperties: false,
      required: ['engineName', 'engineVersion', 'ruleSchemaVersion', 'factSchemaVersion'],
      properties: {
        engineName: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
        },
        engineVersion: {
          type: 'string',
          minLength: 1,
          maxLength: 50,
        },
        ruleSchemaVersion: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
        },
        factSchemaVersion: {
          $ref: '#/$defs/FactSchemaVersion',
        },
      },
    },
    RuleEvaluationResult: {
      title: 'RuleEvaluationResult',
      type: 'object',
      additionalProperties: false,
      required: [
        'ruleCode',
        'outcome',
        'reasonCode',
        'evidenceLevel',
        'requiresReview',
        'blocking',
        'severity',
        'evaluationMode',
        'counts',
        'violations',
        'totalViolationCount',
        'truncated',
        'engine',
      ],
      properties: {
        ruleCode: {
          type: 'string',
          minLength: 1,
          maxLength: 120,
        },
        outcome: {
          $ref: '#/$defs/EvaluationOutcome',
        },
        reasonCode: {
          $ref: '#/$defs/ReasonCode',
        },
        evidenceLevel: {
          $ref: '#/$defs/EvidenceLevel',
        },
        requiresReview: {
          description:
            'True when a human or a later AI phase must resolve this rule before a final compliance decision. Phase 4 sets it for every AI_ASSISTED and MANUAL rule.',
          type: 'boolean',
        },
        blocking: {
          type: 'boolean',
        },
        severity: {
          enum: ['INFO', 'MINOR', 'MAJOR', 'CRITICAL'],
        },
        evaluationMode: {
          enum: ['DETERMINISTIC', 'AI_ASSISTED', 'MANUAL'],
        },
        operator: {
          type: 'string',
          maxLength: 50,
        },
        counts: {
          $ref: '#/$defs/EvaluationCounts',
        },
        violations: {
          type: 'array',
          maxItems: 1000,
          items: {
            $ref: '#/$defs/Violation',
          },
        },
        totalViolationCount: {
          description:
            'The true number of violations, which may exceed the number returned when truncated.',
          type: 'integer',
          minimum: 0,
        },
        truncated: {
          type: 'boolean',
        },
        engine: {
          $ref: '#/$defs/EngineInfo',
        },
      },
    },
    EvaluationRequest: {
      title: 'EvaluationRequest',
      type: 'object',
      additionalProperties: false,
      required: ['factSet', 'rules'],
      properties: {
        factSet: {
          $ref: '#/$defs/DocumentFactSet',
        },
        rules: {
          description:
            'Phase 3 rule definitions, exactly as published. The engine does not reshape them.',
          type: 'array',
          maxItems: 1000,
          items: {
            type: 'object',
          },
        },
      },
    },
    EvaluationResponse: {
      title: 'EvaluationResponse',
      type: 'object',
      additionalProperties: false,
      required: ['documentId', 'engine', 'results'],
      properties: {
        documentId: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
        },
        engine: {
          $ref: '#/$defs/EngineInfo',
        },
        results: {
          type: 'array',
          maxItems: 1000,
          items: {
            $ref: '#/$defs/RuleEvaluationResult',
          },
        },
      },
    },
  },
} as const;
