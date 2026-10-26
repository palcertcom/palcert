import { describe, expect, it } from 'vitest';
import {
  PORTABLE_STANDARD_LIMITS,
  PortablePackageErrorCode,
  buildPortableStandardPackage,
  computePortableStandardHash,
  portableStandardFileName,
  readPortableStandardPackage,
  serializePortableStandardPackage,
  type PortableStandardPackage,
  type PortableStandardRule,
} from './portable.js';

function margin(
  ruleCode: string,
  property: string,
  number: number,
  displayOrder: number,
): PortableStandardRule {
  return {
    ruleCode,
    category: 'MARGINS',
    evaluationMode: 'DETERMINISTIC',
    scope: { kind: 'DOCUMENT', property },
    operator: 'EQUALS',
    expected: { type: 'NUMBER', number },
    unit: 'CENTIMETRE',
    tolerance: 0.1,
    severity: 'MAJOR',
    blocking: true,
    autofix: 'NONE',
    origin: 'ORGANIZATION_POLICY',
    originReference: null,
    titleEn: `Margin ${property}`,
    titleAr: `الهامش ${displayOrder}`,
    descriptionEn: null,
    descriptionAr: null,
    guidanceEn: null,
    guidanceAr: null,
    displayOrder,
  } as PortableStandardRule;
}

const RULES: PortableStandardRule[] = [
  margin('MARGINS.TOP', 'marginTop', 3, 0),
  margin('MARGINS.BOTTOM', 'marginBottom', 3, 1),
  margin('MARGINS.LEFT', 'marginLeft', 3.5, 2),
  margin('MARGINS.RIGHT', 'marginRight', 3, 3),
];

function build(
  rules: PortableStandardRule[] = RULES,
  at = new Date('2026-09-30T00:00:00.000Z'),
): PortableStandardPackage {
  return buildPortableStandardPackage(
    {
      source: {
        organizationName: 'Islamic University of Gaza',
        standardCode: 'IUG-PHD',
        standardNameEn: 'PhD Thesis Standard',
        standardNameAr: 'معيار رسائل الدكتوراه',
        versionLabel: '1.4',
        versionStatus: 'PUBLISHED',
      },
      schema: { ruleSchemaVersion: 2, canonicalizationVersion: 1 },
      standard: {
        code: 'IUG-PHD',
        nameEn: 'PhD Thesis Standard',
        nameAr: 'معيار رسائل الدكتوراه',
        descriptionEn: null,
        descriptionAr: null,
      },
      documentType: { systemCategory: 'THESIS', name: 'PhD Thesis' },
      version: { versionLabel: '1.4', effectiveFrom: null, effectiveUntil: null },
      rules,
    },
    at,
  );
}

const text = (pkg: unknown): string => JSON.stringify(pkg, null, 2);

/** Re-stamp the hash after editing, as a careful forger would. */
function rehash(pkg: Record<string, unknown>): Record<string, unknown> {
  return { ...pkg, contentHash: computePortableStandardHash(pkg as never) };
}

describe('building a package', () => {
  it('is deterministic: the export time does not change the hash', () => {
    const a = build(RULES, new Date('2026-09-30T00:00:00.000Z'));
    const b = build(RULES, new Date('2027-01-01T12:00:00.000Z'));
    expect(a.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b.contentHash).toBe(a.contentHash);
    expect(b.exportedAt).not.toBe(a.exportedAt);
  });

  it('orders rules by code, and the input order does not change the hash', () => {
    const forward = build(RULES);
    const reversed = build([...RULES].reverse());
    expect(reversed.contentHash).toBe(forward.contentHash);
    expect(forward.rules.map((rule) => rule.ruleCode)).toEqual([
      'MARGINS.BOTTOM',
      'MARGINS.LEFT',
      'MARGINS.RIGHT',
      'MARGINS.TOP',
    ]);
  });

  it('carries no identifier of any kind', () => {
    const serialized = serializePortableStandardPackage(build());
    for (const forbidden of [
      'organizationId',
      'standardId',
      'standardVersionId',
      'versionId',
      'ruleId',
      'documentTypeId',
      'userId',
      '"id"',
      'publishedBy',
      'createdAt',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized.endsWith('\n')).toBe(true);
    expect(serialized).toContain('\n  "format": "PALCERT_STANDARD"');
  });

  it('names the file after the code and version, safely', () => {
    expect(portableStandardFileName('IUG-PHD', '1.4')).toBe('IUG-PHD-1.4.palcert.json');
    expect(portableStandardFileName('IUG.PHD', '2026 / edition')).toBe(
      'IUG.PHD-2026_edition.palcert.json',
    );
    expect(portableStandardFileName('X', '../../etc')).toBe('X-etc.palcert.json');
  });
});

describe('reading a package', () => {
  it('reads what it wrote, with every value intact', () => {
    const pkg = build();
    const result = readPortableStandardPackage(serializePortableStandardPackage(pkg));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.packageHash).toBe(pkg.contentHash);
    expect(result.rules.every((rule) => rule.definition !== null)).toBe(true);
    const left = result.rules.find((rule) => rule.display.ruleCode === 'MARGINS.LEFT')!;
    expect(left.definition).toMatchObject({
      expected: { type: 'NUMBER', number: 3.5 },
      unit: 'CENTIMETRE',
      tolerance: 0.1,
      displayOrder: 2,
      titleAr: 'الهامش 2',
    });
  });

  it('accepts a file an editor saved with a byte-order mark', () => {
    const result = readPortableStandardPackage(
      `\uFEFF${serializePortableStandardPackage(build())}`,
    );
    expect(result.ok).toBe(true);
  });

  it('refuses a file changed after export', () => {
    const pkg = JSON.parse(text(build())) as { rules: { tolerance: number }[] };
    pkg.rules[0]!.tolerance = 0.5;
    const result = readPortableStandardPackage(text(pkg));
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: PortablePackageErrorCode.INTEGRITY_FAILED,
        message:
          "The file's integrity check failed. The contents may have been changed after export.",
      },
    });
  });

  it('notices a changed source organization too', () => {
    const pkg = JSON.parse(text(build())) as { source: { organizationName: string } };
    pkg.source.organizationName = 'Someone Else';
    expect(readPortableStandardPackage(text(pkg))).toMatchObject({
      ok: false,
      error: { code: PortablePackageErrorCode.INTEGRITY_FAILED },
    });
  });

  it('refuses malformed JSON and anything that is not a package', () => {
    expect(readPortableStandardPackage('{"format": ')).toMatchObject({
      ok: false,
      error: { code: 'MALFORMED' },
    });
    expect(readPortableStandardPackage('')).toMatchObject({
      ok: false,
      error: { code: 'MALFORMED' },
    });
    expect(readPortableStandardPackage('[1,2,3]')).toMatchObject({
      ok: false,
      error: { code: 'INVALID' },
    });
    expect(readPortableStandardPackage(text({ format: 'SOMETHING_ELSE' }))).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_FORMAT' },
    });
  });

  it('refuses a newer format version without partially reading it', () => {
    const future = { ...JSON.parse(text(build())), formatVersion: 2, newThing: { x: 1 } };
    expect(readPortableStandardPackage(text(future))).toMatchObject({
      ok: false,
      error: {
        code: 'UNSUPPORTED_FORMAT_VERSION',
        message:
          'This standard was created by a newer PalCert format that this installation does not support.',
      },
    });
  });

  it('refuses a newer rule schema and a newer canonicalization', () => {
    const base = JSON.parse(text(build()));
    const schema = rehash({
      ...base,
      schema: { ruleSchemaVersion: 3, canonicalizationVersion: 1 },
    });
    expect(readPortableStandardPackage(text(schema))).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_RULE_SCHEMA' },
    });
    const canon = rehash({ ...base, schema: { ruleSchemaVersion: 2, canonicalizationVersion: 2 } });
    expect(readPortableStandardPackage(text(canon))).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_CANONICALIZATION' },
    });
  });

  it('reads an older supported rule schema and says it will be upgraded', () => {
    const v1 = rehash({
      ...JSON.parse(text(build())),
      schema: { ruleSchemaVersion: 1, canonicalizationVersion: 1 },
    });
    const result = readPortableStandardPackage(text(v1));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.package.schema.ruleSchemaVersion).toBe(1);
    expect(result.importRuleSchemaVersion).toBe(2);
    expect(result.rules.every((rule) => rule.issues.length === 0)).toBe(true);
  });

  it('refuses prototype-pollution property names anywhere', () => {
    for (const payload of [
      '{"__proto__": {"polluted": true}, "format": "PALCERT_STANDARD"}',
      '{"format": "PALCERT_STANDARD", "rules": [{"constructor": {"prototype": {"x": 1}}}]}',
      '{"format": "PALCERT_STANDARD", "source": {"prototype": 1}}',
    ]) {
      expect(readPortableStandardPackage(payload)).toMatchObject({
        ok: false,
        error: { code: 'MALFORMED' },
      });
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('refuses excessive nesting before parsing', () => {
    const deep = `${'['.repeat(10_000)}${']'.repeat(10_000)}`;
    expect(readPortableStandardPackage(deep)).toMatchObject({
      ok: false,
      error: { code: 'MALFORMED' },
    });
  });

  it('refuses a file over the size limit', () => {
    const big = `{"format":"PALCERT_STANDARD","pad":"${'x'.repeat(PORTABLE_STANDARD_LIMITS.maxBytes)}"}`;
    expect(readPortableStandardPackage(big)).toMatchObject({
      ok: false,
      error: { code: 'TOO_LARGE' },
    });
  });

  it('refuses more rules than the limit', () => {
    const many = Array.from({ length: PORTABLE_STANDARD_LIMITS.maxRules + 1 }, (_, index) =>
      margin(`R.${index}`, 'marginTop', 3, index % 100_000),
    );
    const pkg = rehash({ ...JSON.parse(text(build())), rules: many });
    expect(readPortableStandardPackage(JSON.stringify(pkg))).toMatchObject({
      ok: false,
      error: { code: 'TOO_MANY_RULES' },
    });
  });

  it('refuses unknown fields at the root and in metadata', () => {
    const base = JSON.parse(text(build()));
    expect(
      readPortableStandardPackage(text(rehash({ ...base, organizationId: 'abc' }))),
    ).toMatchObject({
      ok: false,
      error: { code: 'INVALID' },
    });
    const source = rehash({ ...base, source: { ...base.source, secret: 'x' } });
    expect(readPortableStandardPackage(text(source))).toMatchObject({
      ok: false,
      error: { code: 'INVALID' },
    });
  });

  it('accepts reserved signatures without interpreting them', () => {
    const signed = {
      ...JSON.parse(text(build())),
      signatures: [{ algorithm: 'ed25519', keyId: 'future-key', value: 'AAAA' }],
    };
    const result = readPortableStandardPackage(text(signed));
    expect(result).toMatchObject({ ok: true, signatureCount: 1 });
  });
});

describe('rules inside a package', () => {
  function readWith(rules: unknown[]) {
    const pkg = rehash({ ...JSON.parse(text(build())), rules });
    const result = readPortableStandardPackage(text(pkg));
    if (!result.ok) throw new Error(result.error.message);
    return result.rules;
  }

  it('reports an invalid rule with its exact issue, without repairing it', () => {
    const bad = { ...margin('margins.lower', 'marginTop', 3, 0) };
    const [rule] = readWith([bad]);
    expect(rule!.definition).toBeNull();
    expect(rule!.issues.map((issue) => issue.path)).toContain('ruleCode');
    expect(rule!.display.ruleCode).toBe('margins.lower');
  });

  it('reports duplicate rule codes on every rule involved', () => {
    const rules = readWith([
      margin('MARGINS.TOP', 'marginTop', 3, 0),
      margin('MARGINS.TOP', 'marginBottom', 3, 1),
    ]);
    for (const rule of rules) {
      expect(rule.definition).toBeNull();
      expect(rule.issues.some((issue) => issue.code === 'DUPLICATE')).toBe(true);
    }
  });

  it('reports unknown and missing fields', () => {
    const extra = { ...margin('A.B', 'marginTop', 3, 0), id: 'rule-id' };
    const missing: Record<string, unknown> = { ...margin('A.C', 'marginTop', 3, 1) };
    delete missing['guidanceAr'];
    const scopeExtra = {
      ...margin('A.D', 'marginTop', 3, 2),
      scope: { kind: 'DOCUMENT', property: 'marginTop', url: 'x' },
    };
    const [a, b, c] = readWith([extra, missing, scopeExtra]);
    expect(a!.issues.map((issue) => issue.path)).toContain('id');
    expect(b!.issues.map((issue) => issue.path)).toContain('guidanceAr');
    expect(c!.issues.map((issue) => issue.path)).toContain('scope.url');
  });

  it('refuses a tolerance the database would round', () => {
    const [rule] = readWith([{ ...margin('A.B', 'marginTop', 3, 0), tolerance: 0.12345 }]);
    expect(rule!.issues.map((issue) => issue.path)).toContain('tolerance');
  });

  it('refuses markup in rule text', () => {
    const [rule] = readWith([
      { ...margin('A.B', 'marginTop', 3, 0), titleEn: '<script>x</script>' },
    ]);
    expect(rule!.definition).toBeNull();
  });
});
