import type { CanonicalStandardInput, RuleDefinition } from '@palcert/contracts';
import { StandardHasherService } from './standard-hasher.service';
import { toRuleDefinition, toleranceToNumber, type StandardRuleRow } from './rule-mapping';

const rule: RuleDefinition = {
  ruleCode: 'MARGIN.TOP.MIN',
  category: 'MARGINS',
  evaluationMode: 'DETERMINISTIC',
  scope: { kind: 'DOCUMENT', property: 'marginTop' },
  operator: 'GREATER_THAN_OR_EQUAL',
  expected: { type: 'NUMBER', number: 25 },
  unit: 'MILLIMETRE',
  tolerance: 0.5,
  severity: 'MAJOR',
  blocking: true,
  autofix: 'SAFE',
  origin: 'ORGANIZATION_POLICY',
  originReference: null,
  displayOrder: 0,
  titleEn: 'Top margin at least 25 mm',
  titleAr: 'الهامش العلوي 25 مم على الأقل',
  descriptionEn: null,
  descriptionAr: null,
  guidanceEn: null,
  guidanceAr: null,
};

const input: CanonicalStandardInput = {
  standardCode: 'IUG.THESIS.FORMAT',
  standardNameEn: 'IUG Thesis Formatting',
  standardNameAr: 'تنسيق رسائل الجامعة الإسلامية',
  standardDescriptionEn: null,
  standardDescriptionAr: null,
  documentTypeCategory: 'THESIS',
  documentTypeName: "Master's Thesis",
  versionLabel: '1.0',
  effectiveFrom: null,
  effectiveUntil: null,
  ruleSchemaVersion: 1,
  rules: [rule],
};

describe('StandardHasherService', () => {
  const hasher = new StandardHasherService();

  it('produces a prefixed, lowercase hex SHA-256', () => {
    expect(hasher.build(input).contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is stable across calls', () => {
    expect(hasher.build(input).contentHash).toBe(hasher.build(input).contentHash);
  });

  it('reports the rule count alongside the hash', () => {
    expect(hasher.build(input).ruleCount).toBe(1);
  });

  it('stamps the canonicalization version that produced the hash', () => {
    expect(hasher.build(input).canonicalizationVersion).toBe(1);
  });

  it('changes when any hashed field changes', () => {
    const baseline = hasher.build(input).contentHash;
    const changed = hasher.build({
      ...input,
      rules: [{ ...rule, expected: { type: 'NUMBER', number: 30 } }],
    }).contentHash;

    expect(changed).not.toBe(baseline);
  });

  it('verifies a snapshot against its own hash', () => {
    const built = hasher.build(input);
    expect(hasher.verify(built.canonical, built.contentHash)).toBe(true);
  });

  it('rejects a snapshot whose content no longer matches its hash', () => {
    const built = hasher.build(input);
    const tampered = JSON.parse(built.serialized) as { version: { versionLabel: string } };
    tampered.version.versionLabel = 'tampered';

    expect(hasher.verify(tampered, built.contentHash)).toBe(false);
  });

  it('refuses to hash content it cannot canonicalize deterministically', () => {
    // Duplicate codes make the canonical rule ordering ambiguous, so the hash
    // could not be reproduced. Failing loudly beats storing an unverifiable one.
    expect(() => hasher.build({ ...input, rules: [rule, { ...rule }] })).toThrow(
      /duplicate rule codes/i,
    );
  });

  it('hashes the serialized bytes, not an object identity', () => {
    // Two structurally identical inputs built separately must agree, which is
    // what lets a third party recompute the hash from the published snapshot.
    const a = hasher.build(input);
    const b = hasher.build(JSON.parse(JSON.stringify(input)) as CanonicalStandardInput);
    expect(b.contentHash).toBe(a.contentHash);
  });
});

describe('rule mapping', () => {
  const row: StandardRuleRow = {
    id: 'ec2f0c5c-2c4e-4d0e-9c1f-000000000001',
    ruleCode: 'MARGIN.TOP.MIN',
    category: 'MARGINS',
    evaluationMode: 'DETERMINISTIC',
    scope: { kind: 'DOCUMENT', property: 'marginTop' },
    operator: 'GREATER_THAN_OR_EQUAL',
    expectedValue: { type: 'NUMBER', number: 25 },
    unit: 'MILLIMETRE',
    tolerance: { toNumber: () => 0.5 },
    severity: 'MAJOR',
    blocking: true,
    autofix: 'SAFE',
    origin: 'ORGANIZATION_POLICY',
    originReference: null,
    titleEn: 'Top margin at least 25 mm',
    titleAr: 'الهامش العلوي 25 مم على الأقل',
    descriptionEn: null,
    descriptionAr: null,
    guidanceEn: null,
    guidanceAr: null,
    displayOrder: 0,
    ruleSchemaVersion: 1,
    createdAt: new Date('2026-06-01T12:00:00.000Z'),
    updatedAt: new Date('2026-06-02T12:00:00.000Z'),
  };

  it('converts a Decimal tolerance to a number', () => {
    expect(toleranceToNumber({ toNumber: () => 1.25 })).toBe(1.25);
    expect(toleranceToNumber(2)).toBe(2);
    expect(toleranceToNumber(null)).toBeNull();
  });

  it('keeps the database id and timestamps out of the hashed definition', () => {
    // These are storage details. If they reached the canonicalizer, two
    // identical standards would hash differently and the hash would identify
    // storage rather than content.
    const definition = toRuleDefinition(row);
    expect(Object.keys(definition)).not.toContain('id');
    expect(Object.keys(definition)).not.toContain('createdAt');
    expect(Object.keys(definition)).not.toContain('updatedAt');
    expect(Object.keys(definition)).not.toContain('ruleSchemaVersion');
  });

  it('renames the stored column to the contract field name', () => {
    expect(toRuleDefinition(row).expected).toEqual({ type: 'NUMBER', number: 25 });
  });
});
