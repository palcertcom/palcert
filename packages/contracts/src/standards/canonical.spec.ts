import { describe, expect, it } from 'vitest';
import {
  STANDARD_CANONICALIZATION_VERSION,
  buildCanonicalSnapshot,
  canonicalizeStandardVersion,
  isValidContentHash,
  serializeCanonical,
  type CanonicalStandardInput,
} from './canonical.js';
import {
  RuleAutofixCapability,
  RuleCategory,
  RuleEvaluationMode,
  RuleOperator,
  RuleOrigin,
  RuleSeverity,
  RuleUnit,
  type RuleDefinition,
} from './rule-schema.js';

const marginRule: RuleDefinition = {
  ruleCode: 'MARGIN.TOP.MIN',
  category: RuleCategory.MARGINS,
  evaluationMode: RuleEvaluationMode.DETERMINISTIC,
  scope: { kind: 'DOCUMENT', property: 'marginTop' },
  operator: RuleOperator.GREATER_THAN_OR_EQUAL,
  expected: { type: 'NUMBER', number: 25 },
  unit: RuleUnit.MILLIMETRE,
  tolerance: 0.5,
  severity: RuleSeverity.MAJOR,
  blocking: true,
  autofix: RuleAutofixCapability.SAFE,
  origin: RuleOrigin.ORGANIZATION_POLICY,
  originReference: null,
  displayOrder: 1,
  titleEn: 'Top margin at least 25 mm',
  titleAr: 'الهامش العلوي 25 مم على الأقل',
  descriptionEn: null,
  descriptionAr: null,
  guidanceEn: null,
  guidanceAr: null,
};

const abstractRule: RuleDefinition = {
  ruleCode: 'ABSTRACT.WORDS.MAX',
  category: RuleCategory.ABSTRACT,
  evaluationMode: RuleEvaluationMode.DETERMINISTIC,
  scope: { kind: 'SECTION', sectionKey: 'ABSTRACT', property: 'wordCount' },
  operator: RuleOperator.LESS_THAN_OR_EQUAL,
  expected: { type: 'NUMBER', number: 300 },
  unit: RuleUnit.WORDS,
  tolerance: null,
  severity: RuleSeverity.MINOR,
  blocking: false,
  autofix: RuleAutofixCapability.NONE,
  origin: RuleOrigin.STYLE_GUIDE,
  originReference: null,
  displayOrder: 2,
  titleEn: 'Abstract at most 300 words',
  titleAr: 'الملخص 300 كلمة كحد أقصى',
  descriptionEn: null,
  descriptionAr: null,
  guidanceEn: null,
  guidanceAr: null,
};

const fixture: CanonicalStandardInput = {
  standardCode: 'IUG.THESIS.FORMAT',
  standardNameEn: 'IUG Thesis Formatting',
  standardNameAr: 'تنسيق رسائل الجامعة الإسلامية',
  standardDescriptionEn: null,
  standardDescriptionAr: null,
  documentTypeCategory: 'THESIS',
  documentTypeName: "Master's Thesis",
  versionLabel: '1.0',
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  effectiveUntil: null,
  // Pinned to 1, deliberately, and never to "the current version": this
  // fixture exists to prove a published v1 standard still hashes to exactly
  // what it hashed to when it was published. Tracking the current version
  // would make the golden silently follow every schema bump and assert
  // nothing at all.
  ruleSchemaVersion: 1,
  rules: [marginRule, abstractRule],
};

/**
 * The golden canonical form.
 *
 * This literal is the contract. If a change to the canonicalizer alters it, the
 * change is not a refactor: every previously issued content hash becomes
 * unverifiable. The correct response to this test failing is to bump
 * `STANDARD_CANONICALIZATION_VERSION` and add a *new* golden alongside this
 * one, never to edit this string in place.
 *
 * It is written out in full, with the Arabic text literal rather than escaped,
 * because the exact bytes are the thing being pinned.
 */
const GOLDEN_CANONICAL_V1 =
  '{"canonicalizationVersion":1,"documentType":{"name":"Master\'s Thesis","systemCategory":"THESIS"},"ruleSchemaVersion":1,"rules":[{"autofix":"NONE","blocking":false,"category":"ABSTRACT","displayOrder":2,"evaluationMode":"DETERMINISTIC","expected":{"number":300,"type":"NUMBER"},"operator":"LESS_THAN_OR_EQUAL","origin":"STYLE_GUIDE","ruleCode":"ABSTRACT.WORDS.MAX","scope":{"kind":"SECTION","property":"wordCount","sectionKey":"ABSTRACT"},"severity":"MINOR","titleAr":"الملخص 300 كلمة كحد أقصى","titleEn":"Abstract at most 300 words","unit":"WORDS"},{"autofix":"SAFE","blocking":true,"category":"MARGINS","displayOrder":1,"evaluationMode":"DETERMINISTIC","expected":{"number":25,"type":"NUMBER"},"operator":"GREATER_THAN_OR_EQUAL","origin":"ORGANIZATION_POLICY","ruleCode":"MARGIN.TOP.MIN","scope":{"kind":"DOCUMENT","property":"marginTop"},"severity":"MAJOR","titleAr":"الهامش العلوي 25 مم على الأقل","titleEn":"Top margin at least 25 mm","tolerance":0.5,"unit":"MILLIMETRE"}],"standard":{"code":"IUG.THESIS.FORMAT","nameAr":"تنسيق رسائل الجامعة الإسلامية","nameEn":"IUG Thesis Formatting"},"version":{"effectiveFrom":"2026-09-01T00:00:00.000Z","versionLabel":"1.0"}}';

describe('canonicalization — the golden form', () => {
  it('produces exactly the committed canonical string', () => {
    expect(canonicalizeStandardVersion(fixture)).toBe(GOLDEN_CANONICAL_V1);
  });

  it('round-trips: re-serializing the parsed snapshot reproduces the same bytes', () => {
    // This is the property a verifier depends on. It is *not* deep equality
    // with `buildCanonicalSnapshot`, because canonicalization drops null-valued
    // keys — parsing back gives the snapshot without them, and serializing that
    // must still land on the identical string.
    const canonical = canonicalizeStandardVersion(fixture);
    expect(serializeCanonical(JSON.parse(canonical))).toBe(canonical);
  });

  it('serializes the built snapshot to the same bytes as the one-step helper', () => {
    expect(serializeCanonical(buildCanonicalSnapshot(fixture))).toBe(
      canonicalizeStandardVersion(fixture),
    );
  });

  it('stamps the canonicalization version inside the hashed content', () => {
    // Inside, not merely alongside: a verifier reading only the snapshot must
    // be able to tell which algorithm to apply.
    const parsed = JSON.parse(canonicalizeStandardVersion(fixture)) as {
      canonicalizationVersion: number;
    };
    expect(parsed.canonicalizationVersion).toBe(STANDARD_CANONICALIZATION_VERSION);
  });
});

describe('canonicalization — determinism', () => {
  it('does not depend on the order rules arrive in', () => {
    const reversed: CanonicalStandardInput = { ...fixture, rules: [abstractRule, marginRule] };
    expect(canonicalizeStandardVersion(reversed)).toBe(canonicalizeStandardVersion(fixture));
  });

  it('does not depend on the order object keys were written in', () => {
    const shuffled: CanonicalStandardInput = {
      ...fixture,
      rules: [
        // Same rule, properties declared in a different order.
        {
          titleAr: marginRule.titleAr,
          titleEn: marginRule.titleEn,
          unit: marginRule.unit,
          severity: marginRule.severity,
          scope: marginRule.scope,
          ruleCode: marginRule.ruleCode,
          origin: marginRule.origin,
          originReference: marginRule.originReference,
          operator: marginRule.operator,
          guidanceEn: marginRule.guidanceEn,
          guidanceAr: marginRule.guidanceAr,
          expected: marginRule.expected,
          evaluationMode: marginRule.evaluationMode,
          displayOrder: marginRule.displayOrder,
          descriptionEn: marginRule.descriptionEn,
          descriptionAr: marginRule.descriptionAr,
          category: marginRule.category,
          blocking: marginRule.blocking,
          autofix: marginRule.autofix,
          tolerance: marginRule.tolerance,
        },
        abstractRule,
      ],
    };
    expect(canonicalizeStandardVersion(shuffled)).toBe(canonicalizeStandardVersion(fixture));
  });

  it('treats NFC and NFD Arabic text as the same content', () => {
    // The same word typed with a combining mark rather than a precomposed
    // character must not produce a different hash: it is the same standard.
    const decomposed = 'الملخص'.normalize('NFD');
    const a = canonicalizeStandardVersion({
      ...fixture,
      rules: [{ ...abstractRule, titleAr: decomposed }],
    });
    const b = canonicalizeStandardVersion({
      ...fixture,
      rules: [{ ...abstractRule, titleAr: decomposed.normalize('NFC') }],
    });
    expect(a).toBe(b);
  });

  it('treats -0 and 0 as the same number', () => {
    const negativeZero = canonicalizeStandardVersion({
      ...fixture,
      rules: [{ ...marginRule, tolerance: -0 }],
    });
    const zero = canonicalizeStandardVersion({
      ...fixture,
      rules: [{ ...marginRule, tolerance: 0 }],
    });
    expect(negativeZero).toBe(zero);
  });

  it('omits a null field entirely rather than writing null', () => {
    // So adding an optional field that nobody fills in cannot change an
    // existing hash.
    expect(canonicalizeStandardVersion(fixture)).not.toContain('null');
  });

  it('produces byte-identical output on repeated calls', () => {
    const runs = new Set(Array.from({ length: 5 }, () => canonicalizeStandardVersion(fixture)));
    expect(runs.size).toBe(1);
  });
});

describe('canonicalization — what is deliberately excluded', () => {
  const otherOrganizationSameContent = canonicalizeStandardVersion(fixture);

  it('is identical for two organizations that wrote the same standard', () => {
    // The hash identifies content, not ownership. Isolation is RLS's job.
    expect(canonicalizeStandardVersion({ ...fixture })).toBe(otherOrganizationSameContent);
  });

  it('never contains a UUID', () => {
    expect(otherOrganizationSameContent).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
    );
  });

  it('does not carry any of the excluded bookkeeping keys', () => {
    for (const key of [
      'id',
      'organizationId',
      'standardId',
      'createdAt',
      'updatedAt',
      'publishedAt',
      'publishedByUserId',
      'status',
      'revision',
      'clonedFromVersionId',
    ]) {
      expect(otherOrganizationSameContent, key).not.toContain(`"${key}"`);
    }
  });
});

describe('canonicalization — what must change the output', () => {
  const base = canonicalizeStandardVersion(fixture);

  it.each<[string, CanonicalStandardInput]>([
    [
      'a changed expected value',
      {
        ...fixture,
        rules: [{ ...marginRule, expected: { type: 'NUMBER', number: 30 } }, abstractRule],
      },
    ],
    [
      'a changed severity',
      { ...fixture, rules: [{ ...marginRule, severity: RuleSeverity.CRITICAL }, abstractRule] },
    ],
    [
      'a changed blocking flag',
      { ...fixture, rules: [{ ...marginRule, blocking: false }, abstractRule] },
    ],
    [
      'a changed display order',
      { ...fixture, rules: [{ ...marginRule, displayOrder: 9 }, abstractRule] },
    ],
    [
      'a changed Arabic title',
      { ...fixture, rules: [{ ...marginRule, titleAr: 'نص مختلف' }, abstractRule] },
    ],
    ['a changed tolerance', { ...fixture, rules: [{ ...marginRule, tolerance: 1 }, abstractRule] }],
    [
      'a changed unit',
      { ...fixture, rules: [{ ...marginRule, unit: RuleUnit.CENTIMETRE }, abstractRule] },
    ],
    ['a changed effective date', { ...fixture, effectiveFrom: '2027-01-01T00:00:00.000Z' }],
    ['a changed version label', { ...fixture, versionLabel: '1.1' }],
    ['a changed document type category', { ...fixture, documentTypeCategory: 'DISSERTATION' }],
    ['an added rule', { ...fixture, rules: [marginRule] }],
  ])('changes when %s', (_label, input) => {
    expect(canonicalizeStandardVersion(input)).not.toBe(base);
  });
});

describe('canonicalization — refusals', () => {
  it('refuses duplicate rule codes, which would make the order undefined', () => {
    expect(() =>
      canonicalizeStandardVersion({ ...fixture, rules: [marginRule, { ...marginRule }] }),
    ).toThrow(/duplicate rule codes/i);
  });

  it('refuses a non-finite number rather than emitting null', () => {
    expect(() => serializeCanonical({ value: Number.POSITIVE_INFINITY })).toThrow(/non-finite/i);
  });
});

describe('content hash format', () => {
  it.each([
    'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    `sha256:${'a'.repeat(64)}`,
  ])('accepts %s', (value) => expect(isValidContentHash(value)).toBe(true));

  it.each([
    `sha256:${'A'.repeat(64)}`,
    `sha1:${'a'.repeat(40)}`,
    'a'.repeat(64),
    `sha256:${'a'.repeat(63)}`,
  ])('rejects %s', (value) => expect(isValidContentHash(value)).toBe(false));
});
