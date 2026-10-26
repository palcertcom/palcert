import { describe, expect, it } from 'vitest';
import { CITATION_PROJECTED_PROPERTIES, citationProjectionFor } from './citation-projection.js';
import {
  PROPERTY_SUPPORT,
  PROPERTY_SUPPORT_REGISTRY_VERSION,
  propertySupportEntry,
  propertySupportsElementType,
  supportFor,
} from './property-support.js';
import { compatibilityFor } from './format-compatibility.js';
import {
  RuleAutofixCapability,
  RuleCategory,
  RuleEvaluationMode,
  RuleOperator,
  RuleOrigin,
  RuleSeverity,
  RuleUnit,
  type RuleDefinition,
} from '../standards/rule-schema.js';
import { validateRuleDefinition } from '../standards/rule-validation.js';

/**
 * Writing a rule about a citation, through the path a rule author uses.
 *
 * Checkpoint 4 made these four properties facts. Until they were declared
 * publicly, nothing a rule author could read said so: the compatibility
 * preview called every one of them UNSUPPORTED, which is the answer for a
 * property no analyzer implements. These tests are the difference between a
 * fact existing and somebody being able to find it.
 *
 * They are equally about what stays hidden. The artifact carries tags,
 * rendered entries, identifiers, link candidates and a dozen advisory
 * counters, and none of them is a fact — so none of them may be discoverable
 * as one.
 */

const CITATION_PROPERTIES = [
  'nativeCitationCount',
  'nativeBibliographySourceCount',
  'nativeSourceResolved',
  'referenceRegionPresent',
  'citationTargetResolved',
] as const;

/**
 * The subset a DOCX can answer.
 *
 * `citationTargetResolved` is absent, and not as an oversight: a Word
 * citation resolves to a bibliography *source* record, which is not a
 * reference entry, so the question this property asks has no answer in that
 * format's graph. Support is derived per format, never copied across.
 */
const DOCX_ANSWERABLE = CITATION_PROPERTIES.filter((name) => name !== 'citationTargetResolved');

/** The subset a tagged PDF can answer. */
const PDF_ANSWERABLE = ['referenceRegionPresent', 'citationTargetResolved'];

/** A rule that validates cleanly; each test changes only its scope and value. */
function citationRule(overrides: Partial<RuleDefinition>): Partial<RuleDefinition> {
  return {
    ruleCode: 'CITATION.NATIVE.MIN',
    category: RuleCategory.CITATIONS,
    evaluationMode: RuleEvaluationMode.DETERMINISTIC,
    operator: RuleOperator.GREATER_THAN_OR_EQUAL,
    expected: { type: 'NUMBER', number: 5 },
    unit: RuleUnit.COUNT,
    severity: RuleSeverity.MAJOR,
    blocking: true,
    autofix: RuleAutofixCapability.NONE,
    origin: RuleOrigin.ORGANIZATION_POLICY,
    originReference: 'Graduate Studies Handbook, s. 6.1',
    displayOrder: 1,
    titleEn: 'At least five cited sources',
    titleAr: 'خمسة مصادر مستشهد بها على الأقل',
    descriptionEn: null,
    descriptionAr: null,
    guidanceEn: null,
    guidanceAr: null,
    ...overrides,
  };
}

describe('citation properties are publicly discoverable', () => {
  it('declares the element types it means, from registry version 2', () => {
    expect(PROPERTY_SUPPORT_REGISTRY_VERSION).toBeGreaterThanOrEqual(2);
  });

  it.each(CITATION_PROPERTIES)('%s is publicly declared with a note per format', (name) => {
    const entry = propertySupportEntry(name);
    expect(entry).not.toBeNull();
    // Including the formats that cannot answer it: "unsupported" with no
    // reason is what a rule author cannot act on.
    expect(entry?.docx.note).toBeTruthy();
    expect(entry?.pdf.note).toBeTruthy();
  });

  it.each(DOCX_ANSWERABLE)('%s is EXACT for DOCX', (name) => {
    expect(supportFor('DOCX', name)).toBe('EXACT');
  });

  it.each(['nativeCitationCount', 'nativeBibliographySourceCount', 'nativeSourceResolved'])(
    '%s is UNSUPPORTED for PDF',
    (name) => {
      // A PDF cannot be asked these at all: they are defined in terms of Word
      // storage. UNSUPPORTED is what makes such a rule INDETERMINATE on a PDF
      // rather than failing it on a confident zero.
      expect(supportFor('PDF', name)).toBe('UNSUPPORTED');
      expect(propertySupportEntry(name)?.pdf.note).toBeTruthy();
    },
  );

  it('referenceRegionPresent is EXACT for PDF too', () => {
    // The first property defined without reference to storage. A DOCX proves
    // it with a BIBLIOGRAPHY field, a PDF with a declared /BibEntry.
    expect(supportFor('PDF', 'referenceRegionPresent')).toBe('EXACT');
    expect(propertySupportEntry('referenceRegionPresent')?.pdf.note).toBeTruthy();
  });

  it('citationTargetResolved is EXACT for PDF and UNSUPPORTED for DOCX', () => {
    // Derived, not copied. A tagged PDF's citation links name a declared
    // reference entry; a Word citation's tag names a bibliography source
    // record, which is a different node, so the question cannot be answered
    // there at all. UNSUPPORTED is what makes such a rule INDETERMINATE on a
    // DOCX rather than failing it on a confident false.
    expect(supportFor('PDF', 'citationTargetResolved')).toBe('EXACT');
    expect(supportFor('DOCX', 'citationTargetResolved')).toBe('UNSUPPORTED');
  });

  it('does not alias citationTargetResolved to nativeSourceResolved', () => {
    // Two different questions with mirror-image support. If one were the
    // other under a new name, the support levels would match and the notes
    // would repeat each other.
    const target = propertySupportEntry('citationTargetResolved');
    const native = propertySupportEntry('nativeSourceResolved');
    expect(supportFor('DOCX', 'nativeSourceResolved')).toBe('EXACT');
    expect(supportFor('PDF', 'nativeSourceResolved')).toBe('UNSUPPORTED');
    expect(target?.docx.note).not.toBe(native?.docx.note);
    expect(target?.pdf.note).not.toBe(native?.pdf.note);
  });

  it('agrees with the projection registry on every declared field', () => {
    for (const projected of CITATION_PROJECTED_PROPERTIES) {
      const entry = propertySupportEntry(projected.property);
      expect(entry).not.toBeNull();
      expect(entry?.valueKind).toBe(projected.valueKind);
      expect(entry?.unit ?? null).toBe(projected.unit ?? null);
      expect(entry?.scopes).toEqual([projected.scopeKind]);
      expect(entry?.elementTypes ?? undefined).toEqual(
        projected.elementType === undefined ? undefined : [projected.elementType],
      );
    }
  });

  it('keeps counts in COUNT and booleans unitless', () => {
    expect(propertySupportEntry('nativeCitationCount')?.unit).toBe('COUNT');
    expect(propertySupportEntry('nativeBibliographySourceCount')?.unit).toBe('COUNT');
    expect(propertySupportEntry('nativeSourceResolved')?.unit).toBeNull();
    expect(propertySupportEntry('referenceRegionPresent')?.unit).toBeNull();
    expect(propertySupportEntry('citationTargetResolved')?.unit).toBeNull();
    expect(propertySupportEntry('citationTargetResolved')?.valueKind).toBe('BOOLEAN');
  });

  it('scopes resolution to a citation element and the counts to the document', () => {
    for (const name of ['nativeSourceResolved', 'citationTargetResolved']) {
      expect(propertySupportsElementType(name, 'CITATION')).toBe(true);
      // Not the entry it points at: the property is a statement about the
      // citation, and a rendered entry carries no property at all.
      expect(propertySupportsElementType(name, 'REFERENCE_ENTRY')).toBe(false);
      expect(propertySupportsElementType(name, 'PARAGRAPH')).toBe(false);
    }
    // A DOCUMENT property is not an element property at all.
    expect(propertySupportsElementType('nativeCitationCount', 'CITATION')).toBe(false);
  });
});

describe('a rule author can write a rule about each of them', () => {
  it('accepts a document-scoped count rule', () => {
    const result = validateRuleDefinition(
      citationRule({ scope: { kind: 'DOCUMENT', property: 'nativeCitationCount' } }),
    );
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('accepts a rule about the bibliography source count', () => {
    const result = validateRuleDefinition(
      citationRule({
        ruleCode: 'CITATION.SOURCES.MIN',
        scope: { kind: 'DOCUMENT', property: 'nativeBibliographySourceCount' },
      }),
    );
    expect(result.issues).toEqual([]);
  });

  it('accepts a rule requiring a reference region', () => {
    const result = validateRuleDefinition(
      citationRule({
        ruleCode: 'CITATION.REGION.PRESENT',
        scope: { kind: 'DOCUMENT', property: 'referenceRegionPresent' },
        operator: RuleOperator.EXISTS,
        // A unary operator takes no operand, and the validator says so.
        expected: { type: 'NONE' },
        unit: null,
      }),
    );
    expect(result.issues).toEqual([]);
  });

  it('accepts an element-scoped rule about citation resolution', () => {
    const result = validateRuleDefinition(
      citationRule({
        ruleCode: 'CITATION.RESOLVED.ALL',
        scope: { kind: 'ELEMENT', elementType: 'CITATION', property: 'nativeSourceResolved' },
        operator: RuleOperator.EQUALS,
        expected: { type: 'BOOLEAN', boolean: true },
        unit: null,
      }),
    );
    expect(result.issues).toEqual([]);
  });

  it('accepts an element-scoped rule about citation-target resolution', () => {
    const result = validateRuleDefinition(
      citationRule({
        ruleCode: 'CITATION.TARGET.ALL',
        scope: { kind: 'ELEMENT', elementType: 'CITATION', property: 'citationTargetResolved' },
        operator: RuleOperator.EQUALS,
        expected: { type: 'BOOLEAN', boolean: true },
        unit: null,
      }),
    );
    expect(result.issues).toEqual([]);
  });

  it('a citation-target rule scoped to the document finds nothing', () => {
    // The rule still validates — Phase 6 chose INDETERMINATE over rejecting a
    // rule about a property no analyzer implements — but the scope the
    // registry declares is ELEMENT/CITATION, and nothing answers a DOCUMENT
    // one. The preview is where the author finds out, before paying.
    expect(propertySupportEntry('citationTargetResolved')?.scopes).toEqual(['ELEMENT']);
    expect(propertySupportsElementType('citationTargetResolved', 'CITATION')).toBe(true);
    expect(citationProjectionFor('DOCUMENT', 'citationTargetResolved')).toBeUndefined();
  });

  it('a citation-target rule scoped to a reference entry finds nothing', () => {
    expect(propertySupportsElementType('citationTargetResolved', 'REFERENCE_ENTRY')).toBe(false);
    expect(
      citationProjectionFor('ELEMENT', 'citationTargetResolved', 'REFERENCE_ENTRY'),
    ).toBeUndefined();
  });

  it('rejects a scope the vocabulary does not have', () => {
    const result = validateRuleDefinition(
      citationRule({
        scope: {
          kind: 'ELEMENT',
          elementType: 'BIBLIOGRAPHY' as never,
          property: 'nativeSourceResolved',
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toContain('scope.elementType');
  });

  it('rejects a malformed property name', () => {
    const result = validateRuleDefinition(
      citationRule({ scope: { kind: 'DOCUMENT', property: 'Native Citation Count' } }),
    );
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toContain('scope.property');
  });
});

describe('the compatibility preview tells the truth about format', () => {
  const rules = CITATION_PROPERTIES.map((property, index) => ({
    ruleCode: `CITATION.R${index}`,
    scope: { property },
  }));

  it('reports a DOCX as answering everything but citation-target resolution', () => {
    const preview = compatibilityFor('DOCX', rules);
    expect(preview.level).toBe('PARTIAL');
    expect(preview.supportedRules).toBe(DOCX_ANSWERABLE.length);
    expect(preview.unsupportedProperties).toEqual(['citationTargetResolved']);
    const supported = preview.rules.filter((rule) => rule.support !== 'UNSUPPORTED');
    expect(new Set(supported.map((rule) => rule.property))).toEqual(new Set(DOCX_ANSWERABLE));
  });

  it('reports a DOCX-only citation standard as fully checkable for DOCX', () => {
    // The Phase 18 standards written before this property existed are
    // unaffected: nothing about them changed, so their preview did not.
    const preview = compatibilityFor(
      'DOCX',
      DOCX_ANSWERABLE.map((property, index) => ({
        ruleCode: `CITATION.D${index}`,
        scope: { property },
      })),
    );
    expect(preview.level).toBe('FULL');
    expect(preview.unsupportedProperties).toEqual([]);
  });

  it('reports a PDF as answering the region and the resolution rules', () => {
    const preview = compatibilityFor('PDF', rules);
    expect(preview.level).toBe('PARTIAL');
    expect(preview.supportedRules).toBe(PDF_ANSWERABLE.length);
    expect(new Set(preview.unsupportedProperties)).toEqual(
      new Set(['nativeCitationCount', 'nativeBibliographySourceCount', 'nativeSourceResolved']),
    );
    const supported = preview.rules.filter((rule) => rule.support !== 'UNSUPPORTED');
    expect(new Set(supported.map((rule) => rule.property))).toEqual(new Set(PDF_ANSWERABLE));
  });

  it('accepts a PDF-checkable reference-region rule through the normal path', () => {
    const result = validateRuleDefinition(
      citationRule({
        ruleCode: 'CITATION.REGION.PDF',
        scope: { kind: 'DOCUMENT', property: 'referenceRegionPresent' },
        operator: RuleOperator.EXISTS,
        expected: { type: 'NONE' },
        unit: null,
      }),
    );
    expect(result.issues).toEqual([]);
  });
});

describe('unapproved citation shapes stay undiscoverable', () => {
  it.each([
    // How PalCert reached a conclusion is not a property of the document.
    'citationTargetId',
    'citationCandidateIds',
    'citationLinkMethod',
    // Bibliographic content: a rule about it is a rule about what was cited.
    'citationDoi',
    'referenceEntryText',
    'referenceEntryDoi',
    // A graded answer, which no deterministic rule may read.
    'citationConfidence',
    // Advisory counters that stay unexposed. Checkpoint 15 exposed three
    // observed counters deliberately and left these: an orphan or duplicate
    // count is a *judgement* over the discovered population rather than a
    // count of it, and exposing one would publish a conclusion drawn from a
    // lower bound.
    'orphanCitationCount',
    'uncitedReferenceCount',
    'duplicateReferenceCount',
  ])('%s is not in the registry and answers UNSUPPORTED', (name) => {
    expect(propertySupportEntry(name)).toBeNull();
    expect(supportFor('DOCX', name)).toBe('UNSUPPORTED');
    expect(supportFor('PDF', name)).toBe('UNSUPPORTED');
    expect(citationProjectionFor('DOCUMENT', name)).toBeUndefined();
  });

  it.each(['observedCitationCount', 'observedReferenceCount', 'observedReferenceRegionPresent'])(
    '%s is ADVISORY on PDF and UNSUPPORTED on DOCX',
    (name) => {
      // Checkpoint 15's exposure, stated as the contract sees it. ADVISORY
      // rather than EXACT because the population is a lower bound and a rule
      // about it can never pass or fail; UNSUPPORTED on DOCX because
      // heuristic discovery is implemented for PDF alone.
      expect(propertySupportEntry(name)).not.toBeNull();
      expect(supportFor('PDF', name)).toBe('ADVISORY');
      expect(supportFor('DOCX', name)).toBe('UNSUPPORTED');
      expect(citationProjectionFor('DOCUMENT', name)).toBeDefined();
    },
  );

  it.each([
    'nativeCitationCount',
    'nativeBibliographySourceCount',
    'nativeSourceResolved',
    'referenceRegionPresent',
    'citationTargetResolved',
  ])('%s was never downgraded to advisory', (name) => {
    // The other half: nothing exact was relabelled to make room. A property
    // quietly admitting heuristic evidence would be invisible in a diff that
    // only added rows.
    expect(supportFor('PDF', name)).not.toBe('ADVISORY');
    expect(supportFor('DOCX', name)).not.toBe('ADVISORY');
  });

  it('exposes no property for a rendered reference entry', () => {
    for (const entry of PROPERTY_SUPPORT) {
      expect(entry.elementTypes ?? []).not.toContain('REFERENCE_ENTRY');
    }
    expect(propertySupportsElementType('nativeSourceResolved', 'REFERENCE_ENTRY')).toBe(false);
    expect(propertySupportsElementType('citationTargetResolved', 'REFERENCE_ENTRY')).toBe(false);
  });

  it('a rule about an undeclared citation shape previews as unsupported', () => {
    // It still *validates* — a standard may reference a property no analyzer
    // implements, and Phase 6 chose INDETERMINATE over rejecting the rule. The
    // preview is where a user finds out, before paying.
    const rule = { ruleCode: 'CITATION.DOI', scope: { property: 'citationDoi' } };
    expect(
      validateRuleDefinition(citationRule({ scope: { kind: 'DOCUMENT', property: 'citationDoi' } }))
        .valid,
    ).toBe(true);
    expect(compatibilityFor('DOCX', [rule]).level).toBe('NONE');
  });
});

describe('the rest of the registry is untouched', () => {
  it('keeps every Phase 13 row free of element types', () => {
    const declared = PROPERTY_SUPPORT.filter((entry) => entry.elementTypes !== undefined);
    expect(declared.map((entry) => entry.name).sort()).toEqual([
      'citationTargetResolved',
      'nativeSourceResolved',
    ]);
  });

  it.each([
    ['marginTop', 'EXACT', 'UNSUPPORTED'],
    ['pageCount', 'UNSUPPORTED', 'EXACT'],
    ['fontSize', 'EXACT', 'EXACT'],
    ['paragraphCount', 'EXACT', 'UNSUPPORTED'],
    ['styleId', 'EXACT', 'UNSUPPORTED'],
  ])('%s still reports %s for DOCX and %s for PDF', (name, docx, pdf) => {
    expect(supportFor('DOCX', name)).toBe(docx);
    expect(supportFor('PDF', name)).toBe(pdf);
  });
});
