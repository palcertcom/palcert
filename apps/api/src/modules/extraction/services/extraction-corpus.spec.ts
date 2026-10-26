import {
  ExtractionBenchmarkHarness,
  isProposable,
  uniformityOf,
  type GuidelineCase,
  type TemplateCase,
} from './extraction-benchmark.service';
import { ProposalValidationService, type PropertySupport } from './proposal-validation.service';
import { TemplateObservationEngine, scopeKey } from './template-observation.service';
import { FakeAIProvider } from '../../../infrastructure/ai/fake-ai-provider';
import {
  AutomationSupport,
  ObservationUniformity,
  ProposalValidationStatus,
  RuleProposalKind,
  type DocumentFactSet,
  type FactScope,
  type RuleDefinition,
  type RuleScope,
} from '@palcert/contracts';

/**
 * The Phase 9 golden corpus (§139, §140, §141, §148).
 *
 * Two halves, deliberately measured differently.
 *
 * The **template** half runs through no model at all. PalCert already knows
 * exactly what a DOCX does, so every assertion here is arithmetic over the
 * analyzer's own counts — which is the whole argument for not asking a model
 * what formatting a document uses (§31, §32).
 *
 * The **guideline** half runs through the deterministic double, because §141 is
 * explicit that a corpus suite must assert classification and grounding rather
 * than prose. What is proved here is the harness and the pipeline around the
 * model: that every case is measured, that PalCert's own validator judges what
 * comes back, that a fabricated evidence id is caught, and that the metrics a
 * future model comparison depends on are actually computed. The same code run
 * against a real provider produces the numbers a model upgrade is judged by,
 * and that run is opt-in and never part of CI (§149).
 */

const engine = new TemplateObservationEngine();
const validation = new ProposalValidationService();

/** The properties the Phase 6 analyzer reports, as the corpus needs them. */
const CATALOGUE: readonly PropertySupport[] = [
  { name: 'marginLeft', scopes: ['PAGE'], exactness: 'EXACT' },
  { name: 'fontSize', scopes: ['ELEMENT'], exactness: 'EXACT' },
  { name: 'fontFamily', scopes: ['ELEMENT'], exactness: 'EXACT' },
  { name: 'lineSpacing', scopes: ['ELEMENT'], exactness: 'EXACT' },
  { name: 'wordCount', scopes: ['SECTION'], exactness: 'EXACT' },
];

const provider = new FakeAIProvider();
const harness = new ExtractionBenchmarkHarness(provider, validation, CATALOGUE);
const corpus = harness.loadCorpus();

describe('the extraction corpus itself', () => {
  it('covers every classification Phase 9 must get right', () => {
    const kinds = new Set(corpus.guidelines.map((entry) => entry.expected.kind));
    expect(kinds).toEqual(
      new Set([
        RuleProposalKind.EXPLICIT_REQUIREMENT,
        RuleProposalKind.AMBIGUOUS_REQUIREMENT,
        RuleProposalKind.CONFLICTING_REQUIREMENT,
        RuleProposalKind.UNREPRESENTABLE_REQUIREMENT,
        'NONE',
      ]),
    );

    const uniformities = new Set(corpus.templates.map((entry) => entry.expected.uniformity));
    expect(uniformities).toEqual(
      new Set([
        ObservationUniformity.UNIFORM,
        ObservationUniformity.MOSTLY_UNIFORM,
        ObservationUniformity.MIXED,
        ObservationUniformity.INSUFFICIENT_SAMPLE,
      ]),
    );
  });

  it('covers Arabic and mixed-language sources, not only English', () => {
    // A Palestinian university writes its guidelines in Arabic. A corpus that
    // only proved English extraction would prove the wrong product (§125).
    const languages = new Set(corpus.guidelines.map((entry) => entry.language));
    expect(languages).toContain('ar');
    expect(languages).toContain('mixed');
    expect(corpus.guidelines.some((entry) => /[؀-ۿ]/.test(entry.passage))).toBe(true);
  });

  it('contains no institution’s real guidelines', () => {
    // A committed corpus is copied, shared and read by anyone with the repo —
    // the opposite of what an unpublished standard needs (§149).
    expect(corpus.description).toMatch(/invented for this file/i);
    const serialized = JSON.stringify(corpus);
    expect(serialized).not.toMatch(/confidential|do not distribute|internal use only/i);
  });

  it('states every template case’s expectation consistently with its own counts', () => {
    // The corpus is data, and data drifts. Re-deriving the expectation from the
    // counts means a bad edit fails here rather than quietly weakening a test.
    for (const templateCase of corpus.templates) {
      expect([templateCase.id, uniformityOf(templateCase)]).toEqual([
        templateCase.id,
        templateCase.expected.uniformity,
      ]);
      expect([templateCase.id, isProposable(templateCase.expected.uniformity)]).toEqual([
        templateCase.id,
        templateCase.expected.proposable,
      ]);
    }
  });
});

describe('the template corpus, measured deterministically', () => {
  for (const templateCase of corpus.templates) {
    it(`classifies ${templateCase.id}: ${templateCase.description}`, () => {
      const [observation] = engine.observe({
        factSet: factSetFor(templateCase),
        sourceAssetId: '11111111-1111-4111-8111-111111111111',
        sourceSha256: 'a'.repeat(64),
        maxObservations: 10,
      });

      expect(observation).toBeDefined();
      expect(observation?.uniformity).toBe(templateCase.expected.uniformity);
      expect(observation?.modalValue).toBe(templateCase.expected.modalValue);
      expect(observation?.occurrenceCount).toBe(
        templateCase.facts.reduce((total, fact) => total + fact.times, 0),
      );
      expect(observation?.distinctValueCount).toBe(templateCase.facts.length);
      // The counts behind the verdict are always reported, because a reviewer
      // deciding whether a template *is* policy needs them (§33, §34).
      expect(observation?.distribution.length).toBeGreaterThan(0);
    });
  }

  it('never proposes a requirement from a template that has not settled', () => {
    // §4: observed formatting is never an institutional requirement, and a
    // MIXED or single-sample observation is not even evidence of a habit.
    const notProposable = corpus.templates.filter((entry) => !entry.expected.proposable);
    expect(notProposable.length).toBeGreaterThan(0);
    for (const templateCase of notProposable) {
      const [observation] = engine.observe({
        factSet: factSetFor(templateCase),
        sourceAssetId: '11111111-1111-4111-8111-111111111111',
        sourceSha256: 'a'.repeat(64),
        maxObservations: 10,
      });
      expect(isProposable(observation!.uniformity)).toBe(false);
    }
  });

  it('reports a single caption as too small a sample, not as a rule', () => {
    // The §4 example, stated as its own test because it is the one a reader is
    // most likely to get wrong: one caption in 10 pt says nothing at all.
    const single = corpus.templates.find((entry) => entry.id === 'one-caption-only');
    expect(single?.expected.uniformity).toBe(ObservationUniformity.INSUFFICIENT_SAMPLE);
    expect(single?.expected.proposable).toBe(false);
  });

  it('keeps the modal value a measurement, never a decision', () => {
    // §33: 187 of 196 paragraphs at 12 pt is reported as 187 of 196. Turning it
    // into "the body font is 12 pt" is the institution's call, not PalCert's.
    const mostly = corpus.templates.find((entry) => entry.id === 'mostly-uniform-body-font')!;
    const [observation] = engine.observe({
      factSet: factSetFor(mostly),
      sourceAssetId: '11111111-1111-4111-8111-111111111111',
      sourceSha256: 'a'.repeat(64),
      maxObservations: 10,
    });
    expect(observation?.matchingCount).toBe(187);
    expect(observation?.occurrenceCount).toBe(196);
    expect(observation?.uniformity).toBe(ObservationUniformity.MOSTLY_UNIFORM);
    expect(JSON.stringify(observation)).not.toMatch(/confidence/i);
  });
});

describe('the guideline corpus, classified without a model', () => {
  const representable = corpus.guidelines.filter(
    (entry) => entry.expected.representable === true && entry.expected.scopeKey !== undefined,
  );

  it('covers every representable scope the corpus claims', () => {
    expect(representable.length).toBeGreaterThan(0);
  });

  for (const guideline of representable) {
    it(`validates and classifies ${guideline.id}`, () => {
      const definition = definitionFor(guideline);

      // The Phase 3 validator, at the draft's schema version, with no allowance
      // made for the fact that extraction produced it (§58).
      const result = validation.validate(
        RuleProposalKind.EXPLICIT_REQUIREMENT,
        definition,
        RULE_SCHEMA_VERSION,
      );
      expect([guideline.id, result.status]).toEqual([guideline.id, ProposalValidationStatus.VALID]);

      expect(scopeKeyOfDefinition(definition)).toBe(guideline.expected.scopeKey);
      expect([guideline.id, validation.automationSupport(result.definition, CATALOGUE)]).toEqual([
        guideline.id,
        guideline.expected.automationSupport,
      ]);
    });
  }

  it('reports a requirement PalCert cannot measure instead of dropping it', () => {
    // §53: "APA 7th edition" is a real requirement. PalCert cannot check it
    // today, and says so rather than forcing it into an unrelated property.
    const referenceStyle = corpus.guidelines.find(
      (entry) => entry.id === 'journal-reference-style',
    )!;
    const support = validation.automationSupport(definitionFor(referenceStyle), CATALOGUE);
    expect(support).toBe(AutomationSupport.NOT_CURRENTLY_MEASURABLE);
  });

  it('carries no rule for an ambiguous, conflicting or unrepresentable case', () => {
    // §44, §47, §48: these kinds exist precisely so PalCert can report a
    // requirement without inventing a value for it. A database CHECK enforces
    // the same thing; this asserts the service agrees.
    for (const kind of [
      RuleProposalKind.AMBIGUOUS_REQUIREMENT,
      RuleProposalKind.CONFLICTING_REQUIREMENT,
      RuleProposalKind.UNREPRESENTABLE_REQUIREMENT,
    ]) {
      const result = validation.validate(kind, null, RULE_SCHEMA_VERSION);
      expect(result.status).toBe(ProposalValidationStatus.NOT_APPLICABLE);
      expect(result.definition).toBeNull();
    }
  });

  it('treats two sources stating the same value as corroboration, not conflict', () => {
    // §91: `duplicate-margin` repeats `en-margin-explicit` from another
    // document. Both locations are kept; neither becomes a disagreement.
    const first = corpus.guidelines.find((entry) => entry.id === 'en-margin-explicit')!;
    const second = corpus.guidelines.find((entry) => entry.id === 'duplicate-margin')!;
    expect(second.expected.duplicateOf).toBe(first.id);

    const conflicts = validation.findCrossSourceConflicts([
      { key: 'a', definition: definitionFor(first), sourceAssetIds: ['s1'] },
      { key: 'b', definition: definitionFor(second), sourceAssetIds: ['s2'] },
    ]);
    expect(conflicts.size).toBe(0);
  });

  it('reports two sources stating different values as a conflict, and picks neither', () => {
    // §62, §63: 12 pt and 11 pt for the same scope. PalCert does not decide,
    // and neither side is marked the winner.
    const left = corpus.guidelines.find((entry) => entry.id === 'conflict-font-size-a')!;
    const right = corpus.guidelines.find((entry) => entry.id === 'conflict-font-size-b')!;
    expect(left.expected.scopeKey).toBe(right.expected.scopeKey);

    const conflicts = validation.findCrossSourceConflicts([
      { key: 'a', definition: fontSizeRule('CONFLICT.A', 12), sourceAssetIds: ['faculty'] },
      { key: 'b', definition: fontSizeRule('CONFLICT.B', 11), sourceAssetIds: ['department'] },
    ]);
    // Both sides are flagged. Flagging only one would be a decision.
    expect([...conflicts.keys()].sort()).toEqual(['a', 'b']);
    expect(conflicts.get('a')).toEqual(['b']);
    expect(conflicts.get('b')).toEqual(['a']);
  });
});

describe('the extraction benchmark harness', () => {
  beforeEach(() => provider.reset());

  it('runs the disagreeing sources together, because one source cannot disagree', () => {
    const groups = harness.groupCases(corpus.guidelines);
    const pair = groups.find((group) => group.cases.length > 1);
    expect(pair?.cases.map((entry) => entry.id).sort()).toEqual([
      'conflict-font-size-a',
      'conflict-font-size-b',
    ]);
    // Every case is measured exactly once, whatever the grouping.
    const measured = groups.flatMap((group) => group.cases.map((entry) => entry.id));
    expect(measured.sort()).toEqual(corpus.guidelines.map((entry) => entry.id).sort());
  });

  it('measures every case and computes every metric', async () => {
    const summary = await harness.run(corpus.guidelines, { corpusVersion: corpus.corpusVersion });

    expect(summary.caseCount).toBe(corpus.guidelines.length);
    expect(summary.results).toHaveLength(summary.groupCount);
    expect(summary.provider).toBe('fake');
    expect(summary.corpusVersion).toBe(corpus.corpusVersion);
    // A prompt change must be visible in a benchmark run, or two runs are not
    // comparable (§107, §148).
    expect(summary.discoveryPromptVersion).toBe('1');
    expect(summary.structuringPromptVersion).toBe('1');

    // Both passes cost tokens, and a benchmark that reported zero would hide
    // half of what extraction costs (§107, §148).
    expect(summary.totalInputTokens).toBeGreaterThan(0);
    expect(summary.totalOutputTokens).toBeGreaterThan(0);

    for (const rate of [
      summary.explicitRequirementRecall,
      summary.proposalValidityRate,
      summary.evidenceGroundingRate,
      summary.hallucinatedEvidenceRate,
      summary.structuredOutputFailureRate,
    ]) {
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(1);
    }
  });

  it('says plainly that its numbers are not a validated accuracy measurement', async () => {
    // §148 in as many words: do not call these scientifically validated metrics
    // unless the dataset supports that claim. This one does not.
    const summary = await harness.run(corpus.guidelines.slice(0, 2));
    expect(summary.disclaimer).toMatch(/not a validated accuracy measurement/i);
    expect(summary.disclaimer).toMatch(/synthetic/i);
  });

  it('scores a well-behaved provider as fully grounded', async () => {
    const summary = await harness.run(corpus.guidelines);

    // The double cites only blocks PalCert supplied and only evidence ids
    // PalCert issued — which is exactly what the metric is measuring.
    expect(summary.evidenceGroundingRate).toBe(1);
    expect(summary.hallucinatedEvidenceRate).toBe(0);
    expect(summary.proposalValidityRate).toBe(1);
    expect(summary.explicitRequirementRecall).toBe(1);
  });

  it('counts a fabricated evidence id as hallucinated, not as a proposal', async () => {
    // §55: the failure this metric exists for. A model that cites something
    // PalCert never sent has invented its grounding, and a run that scored it
    // as a successful extraction would be measuring the wrong thing.
    provider.mode = 'unknown-evidence';
    const summary = await harness.run(corpus.guidelines.slice(0, 3));
    expect(summary.hallucinatedEvidenceRate).toBe(1);
  });

  it('counts an out-of-range citation as ungrounded', async () => {
    // A block index past the end of what PalCert sent cannot be mapped to a
    // node id, so it is not evidence — however plausible the quotation reads.
    provider.mode = 'unknown-block';
    const summary = await harness.run(corpus.guidelines.slice(0, 3));
    expect(summary.evidenceGroundingRate).toBe(0);
    expect(summary.hallucinatedEvidenceRate).toBe(1);
  });

  it('counts a response PalCert refuses as a structured-output failure', async () => {
    provider.mode = 'malformed';
    const summary = await harness.run(corpus.guidelines.slice(0, 3));
    expect(summary.structuredOutputFailureRate).toBe(1);
    expect(summary.results.every((result) => result.failureKind === 'OUTPUT_INVALID')).toBe(true);
    // Nothing was scored as extracted, because nothing was accepted.
    expect(summary.results.every((result) => result.proposalCount === 0)).toBe(true);
  });

  it('counts a rule PalCert’s own validator rejects as an invalid proposal', async () => {
    // §58, §59: schema-valid output that the rule validator refuses. The model
    // is not given a bypass, and the benchmark does not give it one either.
    provider.proposeInvalidRule = true;
    const summary = await harness.run(corpus.guidelines.slice(0, 3));
    expect(summary.proposalValidityRate).toBe(0);
  });

  it('detects a conflict when the provider reports one', async () => {
    provider.proposalKinds = ['CONFLICTING_REQUIREMENT'];
    const summary = await harness.run(corpus.guidelines);
    expect(summary.conflictDetectionRate).toBe(1);
  });

  it('detects an unrepresentable requirement when the provider reports one', async () => {
    provider.proposalKinds = ['UNREPRESENTABLE_REQUIREMENT'];
    const summary = await harness.run(corpus.guidelines);
    expect(summary.unrepresentableDetectionRate).toBe(1);
  });

  it('never lets the injection case turn into an instruction', async () => {
    // §81: the corpus contains a passage telling PalCert to publish the
    // standard and accept every proposal. It reaches the harness as a document
    // block, comes back as a quotation, and changes nothing — there is no code
    // path here that could publish or accept anything.
    const injection = corpus.guidelines.find((entry) => entry.id === 'prompt-injection')!;
    expect(injection.passage).toMatch(/publish this standard automatically/i);

    await harness.run([injection]);
    const [call] = provider.proposalCalls;
    expect(call?.userPrompt).toContain('<evidence>');
    expect(call?.userPrompt).not.toContain('<system>');
    // The instruction survives as data a reviewer can read, and the genuine
    // requirement beside it is still extracted.
    expect(call?.userPrompt).toMatch(/Ignore all previous PalCert instructions/);
  });
});

// ---------------------------------------------------------------------------

const RULE_SCHEMA_VERSION = 2;

/** Every fact a template case describes, expanded to individual observations. */
function factSetFor(templateCase: TemplateCase): DocumentFactSet {
  const facts = templateCase.facts.flatMap((fact) =>
    Array.from({ length: fact.times }, () => ({
      scope: parseFactScope(fact.scope),
      value: numeric(fact.value)
        ? { type: 'NUMBER' as const, number: fact.value }
        : { type: 'STRING' as const, text: fact.value },
      ...(fact.unit === undefined ? {} : { unit: fact.unit }),
    })),
  );
  return {
    factSchemaVersion: 2,
    documentId: templateCase.id,
    extractor: { name: 'corpus', version: '1' } as DocumentFactSet['extractor'],
    coverage: [],
    facts: facts as DocumentFactSet['facts'],
  };
}

/**
 * A scope key back into a scope.
 *
 * The corpus states scope keys because that is what a reviewer reads in the UI;
 * the engine consumes scopes. Parsing here keeps the fixture readable without
 * letting the test assert against a key it built itself — every case round-trips
 * through {@link scopeKey}.
 */
function parseFactScope(key: string): FactScope {
  const [kind, selector, property] = key.split(':');
  switch (kind) {
    case 'PAGE':
      return { kind: 'PAGE', pages: selector as 'ALL', property: property! };
    case 'SECTION':
      return { kind: 'SECTION', sectionKey: selector!, property: property! };
    case 'ELEMENT': {
      const [elementType, level] = (selector ?? '').split('#');
      return {
        kind: 'ELEMENT',
        elementType: elementType as 'PARAGRAPH',
        ...(level === undefined ? {} : { level: Number(level) }),
        property: property!,
      };
    }
    case 'METADATA':
      return { kind: 'METADATA', field: property! };
    default:
      return { kind: 'DOCUMENT', property: property! };
  }
}

/**
 * A minimal valid rule for the scope a guideline case names.
 *
 * The corpus states a scope key and what PalCert should be able to do with it;
 * this turns that into the rule a correct extraction would have proposed. The
 * shape is chosen per property rather than generically, because "margin equals
 * 30 millimetres" and "abstract at most 300 words" are not interchangeable and
 * a test that pretended they were would prove nothing about either.
 */
const PROPERTY_RULES: Readonly<Record<string, Partial<Record<string, unknown>>>> = {
  marginLeft: {
    category: 'MARGINS',
    operator: 'EQUALS',
    expected: { type: 'NUMBER', number: 30 },
    unit: 'MILLIMETRE',
  },
  fontSize: {
    category: 'TYPOGRAPHY',
    operator: 'EQUALS',
    expected: { type: 'NUMBER', number: 12 },
    unit: 'POINT',
  },
  wordCount: {
    category: 'ABSTRACT',
    operator: 'LESS_THAN_OR_EQUAL',
    expected: { type: 'NUMBER', number: 300 },
    unit: 'WORDS',
  },
  referenceStyle: {
    category: 'REFERENCES',
    operator: 'EQUALS',
    expected: { type: 'STRING', text: 'APA 7' },
  },
  aiUseDeclaration: {
    category: 'RESEARCH_ETHICS',
    operator: 'EXISTS',
    expected: { type: 'NONE' },
  },
};

function definitionFor(guideline: GuidelineCase): RuleDefinition {
  const scope = parseRuleScope(guideline.expected.scopeKey!);
  const property = 'property' in scope ? scope.property : 'unknown';
  const shape = PROPERTY_RULES[property];
  expect(shape).toBeDefined();

  return {
    ruleCode: guideline.id.toUpperCase().replace(/-/g, '.'),
    evaluationMode: guideline.expected.evaluationMode ?? 'DETERMINISTIC',
    scope,
    severity: 'MAJOR',
    blocking: false,
    autofix: 'NONE',
    origin: 'ORGANIZATION_POLICY',
    titleEn: `Requirement from ${guideline.id}`,
    titleAr: `متطلب من ${guideline.id}`,
    displayOrder: 0,
    ...shape,
  } as unknown as RuleDefinition;
}

function fontSizeRule(ruleCode: string, points: number): RuleDefinition {
  return {
    ruleCode,
    category: 'TYPOGRAPHY',
    evaluationMode: 'DETERMINISTIC',
    scope: { kind: 'ELEMENT', elementType: 'PARAGRAPH', property: 'fontSize' },
    operator: 'EQUALS',
    expected: { type: 'NUMBER', number: points },
    unit: 'POINT',
    severity: 'MAJOR',
    blocking: false,
    autofix: 'NONE',
    origin: 'ORGANIZATION_POLICY',
    titleEn: `Body text ${points} pt`,
    titleAr: `نص المتن ${points} نقطة`,
    displayOrder: 0,
  } as unknown as RuleDefinition;
}

function parseRuleScope(key: string): RuleScope {
  return parseFactScope(key) as unknown as RuleScope;
}

function scopeKeyOfDefinition(definition: RuleDefinition): string {
  return scopeKey(definition.scope as unknown as FactScope);
}

function numeric(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value);
}
