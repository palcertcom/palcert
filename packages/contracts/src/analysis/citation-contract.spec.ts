import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertAnalysisArtifact,
  validateAnalysisArtifact,
  validateAnalysisArtifactSchema,
} from './validator.js';
import { ANALYSIS_ARTIFACT_JSON_SCHEMA } from './schema.generated.js';
import { CitationIntegrityCode, validateCitationIntegrity } from './citation-integrity.js';
import {
  CITATION_PROJECTED_PROPERTIES,
  CITATION_PROJECTION_REGISTRY_VERSION,
  citationProjectionFor,
  isAdvisoryProjection,
  isCitationProjectable,
} from './citation-projection.js';
import type { CitationAnalysis } from './generated.js';

/**
 * The Phase 18 citation contracts, both layers of them.
 *
 * The schema bounds the shape; the integrity check answers what the schema
 * cannot ask. Fixtures are split by which layer must reject them, so a
 * structural fixture cannot quietly start passing because the graph check
 * caught it instead — and the Python suite validates the same files.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, '../../../../contracts/fixtures/analysis');
const integrityDir = join(fixturesDir, 'citation-integrity');

function load(dir: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
}

const citationOf = (artifact: Record<string, unknown>): CitationAnalysis =>
  artifact.citationAnalysis as CitationAnalysis;

describe('analysis artifact v2 envelope', () => {
  const valid = [
    'citation-v1-artifact-without-citation-analysis.json',
    'citation-v2-artifact-docx.json',
    'citation-v2-artifact-pdf.json',
    'citation-v2-artifact-unavailable.json',
    'citation-v2-artifact-arabic.json',
    'citation-v2-artifact-pdf-internal-destination.json',
  ];

  it.each(valid)('accepts %s', (name) => {
    const result = validateAnalysisArtifact(load(fixturesDir, name));
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('leaves a historical v1 artifact free of citation evidence', () => {
    const artifact = load(fixturesDir, 'citation-v1-artifact-without-citation-analysis.json');
    expect(artifact.analysisSchemaVersion).toBe(1);
    expect(artifact.citationAnalysis).toBeUndefined();
  });

  it('requires citation evidence on a v2 artifact, and forbids it on a v1', () => {
    // The envelope version and the section move together in both directions.
    // A v2 that forgot the section would advertise Phase 18 and carry nothing.
    const v1 = load(fixturesDir, 'citation-v1-artifact-without-citation-analysis.json');
    const v2 = load(fixturesDir, 'citation-v2-artifact-docx.json');

    expect(validateAnalysisArtifact({ ...v1, citationAnalysis: citationOf(v2) }).valid).toBe(false);
    const { citationAnalysis: _omitted, ...withoutSection } = v2;
    expect(validateAnalysisArtifact(withoutSection).valid).toBe(false);
  });

  it('pins the citation analysis schema version at 1', () => {
    expect(
      citationOf(load(fixturesDir, 'citation-v2-artifact-docx.json')).citationAnalysisSchemaVersion,
    ).toBe(1);
  });

  const structural = readdirSync(fixturesDir).filter((name) =>
    name.startsWith('invalid-citation-'),
  );

  it('has structural rejection fixtures', () => {
    expect(structural.length).toBeGreaterThanOrEqual(8);
  });

  it.each(structural)('rejects %s at the schema', (name) => {
    expect(validateAnalysisArtifact(load(fixturesDir, name)).valid).toBe(false);
  });
});

describe('citation evidence integrity', () => {
  const broken = readdirSync(integrityDir).filter((name) => name.startsWith('invalid-'));

  it('has graph rejection fixtures', () => {
    expect(broken.length).toBeGreaterThanOrEqual(25);
  });

  it.each(['valid-consistent-graph.json', 'valid-doi-identity-link.json'])(
    'accepts the consistent graph in %s',
    (name) => {
      const artifact = load(integrityDir, name);
      expect(validateAnalysisArtifact(artifact).issues).toEqual([]);
      expect(validateCitationIntegrity(citationOf(artifact)).issues).toEqual([]);
    },
  );

  it.each([
    'invalid-doi-link-without-citation-identity.json',
    'invalid-doi-link-identities-differ.json',
    'invalid-doi-link-on-boundary-ambiguous-identity.json',
  ])('rejects the unbacked DOI link in %s', (name) => {
    // The one method whose evidence is written down on both sides, so the one
    // whose rows can be checked rather than believed.
    const artifact = load(integrityDir, name);
    const result = validateCitationIntegrity(citationOf(artifact));
    expect(result.valid).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain(
      CitationIntegrityCode.DOI_LINK_WITHOUT_SHARED_IDENTITY,
    );
  });

  it('accepts a consistent graph', () => {
    const artifact = load(integrityDir, 'valid-consistent-graph.json');
    expect(validateAnalysisArtifact(artifact).issues).toEqual([]);
    expect(validateCitationIntegrity(citationOf(artifact)).issues).toEqual([]);
  });

  it.each(broken)('%s satisfies the schema but fails the graph check', (name) => {
    const artifact = load(integrityDir, name);
    // Both halves matter: if the schema already rejected it, the fixture would
    // prove nothing about the integrity pass it was written for. This is the
    // one place that wants the schema-only path — everywhere else, and in
    // production, `validateAnalysisArtifact` means the complete contract.
    expect(validateAnalysisArtifactSchema(artifact).issues).toEqual([]);
    expect(validateCitationIntegrity(citationOf(artifact)).valid).toBe(false);
  });

  it('names the defect rather than shrugging', () => {
    const codes = (name: string) =>
      validateCitationIntegrity(citationOf(load(integrityDir, name))).issues.map((i) => i.code);

    expect(codes('invalid-duplicate-citation-id.json')).toContain('DUPLICATE_CITATION_ID');
    expect(codes('invalid-link-citation-unknown.json')).toContain('LINK_CITATION_UNKNOWN');
    expect(codes('invalid-link-target-unknown.json')).toContain('LINK_TARGET_UNKNOWN');
    expect(codes('invalid-link-candidate-unknown.json')).toContain('LINK_CANDIDATE_UNKNOWN');
    expect(codes('invalid-duplicate-of-self.json')).toContain('DUPLICATE_OF_SELF');
    expect(codes('invalid-candidate-count-mismatch.json')).toContain(
      'LINK_CANDIDATE_COUNT_MISMATCH',
    );
    expect(codes('invalid-target-count-mismatch.json')).toContain('CITATION_TARGET_COUNT_MISMATCH');
    expect(codes('invalid-unresolved-link-claiming-target.json')).toContain(
      'LINK_TARGET_NOT_ALLOWED',
    );
    expect(codes('invalid-linked-without-target.json')).toContain('LINK_TARGET_MISSING');
    expect(codes('invalid-coverage-domain-repeated.json')).toContain('COVERAGE_DOMAIN_REPEATED');

    // A confidence is a graded answer. Beside an exact read there is nothing
    // to grade, so the number could only have been invented.
    expect(codes('invalid-confidence-on-ooxml.json')).toContain('CONFIDENCE_NOT_ALLOWED');
    expect(codes('invalid-confidence-on-pdf-text.json')).toContain('CONFIDENCE_NOT_ALLOWED');

    // Each link status has exactly one legal shape.
    expect(codes('invalid-linked-with-candidates.json')).toContain('LINK_CANDIDATES_NOT_ALLOWED');
    expect(codes('invalid-unresolved-with-candidates.json')).toContain(
      'LINK_CANDIDATES_NOT_ALLOWED',
    );
    expect(codes('invalid-ambiguous-without-candidates.json')).toContain(
      'LINK_CANDIDATES_INSUFFICIENT',
    );
    expect(codes('invalid-ambiguous-with-one-candidate.json')).toContain(
      'LINK_CANDIDATES_INSUFFICIENT',
    );
    expect(codes('invalid-ambiguous-with-repeated-candidate.json')).toContain(
      'LINK_CANDIDATE_REPEATED',
    );

    // The citation's own status is a summary of its links, and a summary that
    // disagrees with them leaves a reader unable to say which half is wrong.
    expect(codes('invalid-citation-linked-but-link-unresolved.json')).toContain(
      'CITATION_RESOLUTION_STATUS_MISMATCH',
    );
    expect(codes('invalid-citation-not-attempted-with-link.json')).toContain(
      'CITATION_RESOLUTION_STATUS_MISMATCH',
    );

    expect(codes('invalid-duplicate-confirmed-without-target.json')).toContain(
      'DUPLICATE_OF_MISSING',
    );

    // The same invariants, over the method added in Checkpoint 7. A PDF link
    // gets no weaker graph rules than a Word one: the source of the evidence
    // does not change what a link row is allowed to say.
    expect(codes('invalid-internal-destination-target-missing.json')).toContain(
      'LINK_TARGET_UNKNOWN',
    );
    expect(codes('invalid-internal-destination-linked-with-candidates.json')).toContain(
      'LINK_CANDIDATES_NOT_ALLOWED',
    );
    expect(codes('invalid-internal-destination-ambiguous-with-one-candidate.json')).toContain(
      'LINK_CANDIDATES_INSUFFICIENT',
    );
    expect(codes('invalid-internal-destination-repeated-candidate.json')).toContain(
      'LINK_CANDIDATE_REPEATED',
    );
    expect(codes('invalid-internal-destination-unresolved-with-target.json')).toContain(
      'LINK_TARGET_NOT_ALLOWED',
    );
    expect(codes('invalid-internal-destination-resolution-status-mismatch.json')).toContain(
      'CITATION_RESOLUTION_STATUS_MISMATCH',
    );
  });

  it('has no link method for "we did not link it"', () => {
    // A link row exists only when linking was attempted, so every method names
    // a real attempt. A citation nobody tried to link has no row at all.
    const methods = (
      ANALYSIS_ARTIFACT_JSON_SCHEMA.$defs.CitationReferenceLink.properties.linkMethod as {
        enum: readonly string[];
      }
    ).enum;
    expect([...methods]).toEqual([
      'NATIVE_TAG',
      'DOI_IDENTITY',
      'NUMERIC_LABEL',
      'AUTHOR_YEAR_UNIQUE',
      'STRUCTURED_TUPLE',
      // Added in Checkpoint 7, for an exact relationship the first five could
      // not describe: a document-native link whose internal destination
      // resolves to a declared reference entry.
      'INTERNAL_DESTINATION',
    ]);
  });
});

/**
 * The allow-list is the authority contract, so it is pinned as an exact set.
 *
 * A fifth property cannot arrive without breaking a test that names all four,
 * which is the point: growing what citation evidence may assert is a decision,
 * not a convenience.
 */
describe('citation projection registry', () => {
  it('is at version 4', () => {
    // Version 2 recorded that one row is projectable from PDF as well;
    // version 3 added a format-independent citation-resolution property;
    // version 4 admits a second *class* of row, which is the largest of the
    // three changes. Which formats may project a row, which rows exist at all,
    // and what a row is allowed to assert are each part of what the registry
    // authorizes, so any of them is a version change rather than a data edit.
    expect(CITATION_PROJECTION_REGISTRY_VERSION).toBe(4);
  });

  it('holds exactly the approved properties', () => {
    expect(
      CITATION_PROJECTED_PROPERTIES.map((entry) =>
        [entry.scopeKind, entry.elementType ?? '', entry.property].join('/'),
      ).sort(),
    ).toEqual([
      'DOCUMENT//nativeBibliographySourceCount',
      'DOCUMENT//nativeCitationCount',
      'DOCUMENT//observedCitationCount',
      'DOCUMENT//observedReferenceCount',
      'DOCUMENT//observedReferenceRegionPresent',
      'DOCUMENT//referenceRegionPresent',
      'ELEMENT/CITATION/citationTargetResolved',
      'ELEMENT/CITATION/nativeSourceResolved',
    ]);
  });

  it('keeps the exact allow-list exactly as it was before Checkpoint 15', () => {
    // Pinned on its own so that adding a ninth advisory row cannot quietly be
    // mistaken for an exact one. The exact set is not allowed to grow at all.
    const exact = CITATION_PROJECTED_PROPERTIES.filter((entry) => !isAdvisoryProjection(entry));
    expect(
      exact
        .map((entry) => [entry.scopeKind, entry.elementType ?? '', entry.property].join('/'))
        .sort(),
    ).toEqual([
      'DOCUMENT//nativeBibliographySourceCount',
      'DOCUMENT//nativeCitationCount',
      'DOCUMENT//referenceRegionPresent',
      'ELEMENT/CITATION/citationTargetResolved',
      'ELEMENT/CITATION/nativeSourceResolved',
    ]);
    for (const entry of exact) {
      expect(entry.projectionKind).toMatch(/^EXACT_/);
    }
  });

  it('constrains every advisory row the same way', () => {
    const advisory = CITATION_PROJECTED_PROPERTIES.filter(isAdvisoryProjection);
    expect(advisory.length).toBeGreaterThan(0);
    for (const entry of advisory) {
      // Document-scoped: Checkpoint 15 starts with counters rather than
      // element-level assertions. PARTIAL-only: a heuristic population is a
      // lower bound. PDF-only: heuristic discovery exists for PDF alone.
      expect(entry.scopeKind).toBe('DOCUMENT');
      expect(entry.elementType).toBeUndefined();
      expect(entry.projectionKind).toMatch(/^ADVISORY_/);
      expect(entry.coveragePolicy).toBe('ADVISORY_PARTIAL_ONLY');
      expect(entry.formats).toEqual(['PDF']);
    }
  });

  it('never lets a row be both exact and advisory', () => {
    // The kind says what a row may assert, the class says which objects it may
    // read. A row where one said EXACT and the other ADVISORY would be a row
    // nobody could interpret.
    for (const entry of CITATION_PROJECTED_PROPERTIES) {
      expect(entry.projectionKind.startsWith('EXACT_')).toBe(!isAdvisoryProjection(entry));
    }
  });

  it('never gives an advisory row the name of an exact one', () => {
    // Renaming an exact property to make it heuristic is the thing to
    // prevent. `referenceRegionPresent` means "proven by structure"; the
    // recognition is `observedReferenceRegionPresent`, a different row.
    const exact = new Set(
      CITATION_PROJECTED_PROPERTIES.filter((e) => !isAdvisoryProjection(e)).map((e) => e.property),
    );
    const advisory = new Set(
      CITATION_PROJECTED_PROPERTIES.filter(isAdvisoryProjection).map((e) => e.property),
    );
    for (const name of advisory) expect(exact.has(name)).toBe(false);
    expect(exact.has('referenceRegionPresent')).toBe(true);
    expect(advisory.has('observedReferenceRegionPresent')).toBe(true);
  });

  it('names each scope and property once', () => {
    const keys = CITATION_PROJECTED_PROPERTIES.map((entry) =>
      [entry.scopeKind, entry.elementType ?? '', entry.property].join('/'),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('projects nothing about a rendered reference entry', () => {
    // A rendered entry's identity is established by classification, and
    // coverage cannot repair a wrong element identity.
    for (const entry of CITATION_PROJECTED_PROPERTIES) {
      expect(entry.elementType).not.toBe('REFERENCE_ENTRY');
    }
    for (const property of ['doi', 'isbn', 'issn', 'url', 'duplicateConfirmed']) {
      expect(isCitationProjectable('ELEMENT', property, 'REFERENCE_ENTRY')).toBe(false);
    }
  });

  it('projects nothing heuristic, and each row names its own formats', () => {
    // Three rows are defined in Word-native terms — a CITATION field, a Word
    // source record, a tag matched against a Word source set — and a PDF has
    // none of them. The two defined without reference to storage carry their
    // own format lists: the reference-region marker, "proven by structure",
    // is provable from both, while citation-target resolution is provable
    // today only from a tagged PDF, because a Word citation resolves to a
    // bibliography source record and never to a reference entry.
    expect(
      Object.fromEntries(
        CITATION_PROJECTED_PROPERTIES.filter((entry) => !isAdvisoryProjection(entry)).map(
          (entry) => [entry.property, entry.formats],
        ),
      ),
    ).toEqual({
      nativeCitationCount: ['DOCX'],
      nativeBibliographySourceCount: ['DOCX'],
      nativeSourceResolved: ['DOCX'],
      referenceRegionPresent: ['DOCX', 'PDF'],
      citationTargetResolved: ['PDF'],
    });
    for (const entry of CITATION_PROJECTED_PROPERTIES) {
      if (!isAdvisoryProjection(entry)) expect(entry.projectionKind).toMatch(/^EXACT_/);
    }
    for (const property of [
      'citationCount',
      'referenceCount',
      'orphanCitationCount',
      'uncitedReferenceCount',
      'ambiguousCitationCount',
      'duplicateReferenceCount',
      'citationNumberingOrdered',
    ]) {
      expect(isCitationProjectable('DOCUMENT', property)).toBe(false);
    }
  });

  it('keeps a count away from PARTIAL coverage', () => {
    // A partial count is a wrong value, not a missing one, and PARTIAL does
    // not protect against a wrong value producing FAIL.
    for (const entry of CITATION_PROJECTED_PROPERTIES) {
      if (entry.projectionKind === 'EXACT_COUNT') {
        expect(entry.coveragePolicy).toBe('COMPLETE_OR_UNAVAILABLE');
        expect(entry.valueKind).toBe('NUMBER');
        // Stated, never inferred: a projector must not read COUNT out of a
        // property name, because a name is not a contract.
        expect(entry.unit).toBe('COUNT');
      }
    }
  });

  it('gives every count a unit and leaves the others unitless', () => {
    const units = Object.fromEntries(
      CITATION_PROJECTED_PROPERTIES.map((entry) => [entry.property, entry.unit]),
    );
    expect(units).toEqual({
      observedCitationCount: 'COUNT',
      observedReferenceCount: 'COUNT',
      observedReferenceRegionPresent: undefined,
      nativeCitationCount: 'COUNT',
      nativeBibliographySourceCount: 'COUNT',
      nativeSourceResolved: undefined,
      referenceRegionPresent: undefined,
      citationTargetResolved: undefined,
    });
  });

  it('declares only value kinds a projector can build a fact from', () => {
    // The projector reads the kind and the unit off the row rather than out of
    // the property's name, so a row naming a kind it cannot build would fail
    // at analysis time on a real document. Held here, where it is a test.
    for (const entry of CITATION_PROJECTED_PROPERTIES) {
      expect(['NUMBER', 'BOOLEAN']).toContain(entry.valueKind);
      expect(entry.unit === undefined || entry.unit === 'COUNT').toBe(true);
      // A unit on a boolean would be a measurement in nothing.
      if (entry.valueKind === 'BOOLEAN') expect(entry.unit).toBeUndefined();
      if (entry.unit !== undefined) expect(entry.valueKind).toBe('NUMBER');
    }
  });

  it('names an element type on every element-scoped row and on no other', () => {
    // Fail-closed lookup depends on it: an ELEMENT row without an element type
    // would be findable without one, which is the hole the SmartFix guard
    // closed on the write side.
    for (const entry of CITATION_PROJECTED_PROPERTIES) {
      expect(entry.elementType === undefined).toBe(entry.scopeKind !== 'ELEMENT');
    }
  });

  it('marks the reference region as positive-only evidence', () => {
    const entry = citationProjectionFor('DOCUMENT', 'referenceRegionPresent');
    expect(entry?.projectionKind).toBe('EXACT_POSITIVE_MARKER');
    expect(entry?.coveragePolicy).toBe('POSITIVE_ONLY_PARTIAL_OR_UNAVAILABLE');
  });

  it('scopes native source resolution to the citation element specifically', () => {
    expect(citationProjectionFor('ELEMENT', 'nativeSourceResolved', 'CITATION')).toBeDefined();
    // Not a loose ELEMENT property: without the element type it is not found,
    // which is the same fail-closed rule the SmartFix guard uses.
    expect(citationProjectionFor('ELEMENT', 'nativeSourceResolved')).toBeUndefined();
    expect(
      citationProjectionFor('ELEMENT', 'nativeSourceResolved', 'REFERENCE_ENTRY'),
    ).toBeUndefined();
  });
});

/**
 * The runtime-safety test: one name, the whole contract.
 *
 * These two validators were separate when the citation contracts landed, which
 * meant an artifact whose citation graph was corrupt passed the ordinary
 * analysis-artifact contract unless every caller remembered a second call.
 * Nothing about that is fail-closed — the one caller who forgets is the one
 * that stores the artifact.
 */
describe('the ordinary artifact contract is the complete contract', () => {
  const broken = load(integrityDir, 'invalid-citation-linked-but-link-unresolved.json');

  it('rejects a schema-valid artifact whose citation graph is not', () => {
    expect(validateAnalysisArtifactSchema(broken).issues).toEqual([]);

    const result = validateAnalysisArtifact(broken);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain(
      'CITATION_RESOLUTION_STATUS_MISMATCH',
    );
    // Reported where the defect is, not at the root.
    expect(result.issues[0]?.path).toMatch(/^\/citationAnalysis\//);
  });

  it('throws from the ordinary assertion too', () => {
    expect(() => assertAnalysisArtifact(broken)).toThrow(/citationAnalysis/);
  });

  it('leaves a historical v1 artifact exactly as it was', () => {
    // A v1 artifact carries no citation evidence, so the complete contract and
    // the structural one are the same contract for it.
    const v1 = load(fixturesDir, 'citation-v1-artifact-without-citation-analysis.json');
    expect(validateAnalysisArtifact(v1).issues).toEqual([]);
    expect(validateAnalysisArtifactSchema(v1).issues).toEqual([]);
  });

  it('does not run the graph check over an artifact that failed the schema', () => {
    // The semantic pass assumes the shape it reads; running it anyway would
    // report the structural failure again under a semantic name.
    const { citationAnalysis: _omitted, ...withoutSection } = load(
      fixturesDir,
      'citation-v2-artifact-docx.json',
    );
    const result = validateAnalysisArtifact(withoutSection);
    expect(result.valid).toBe(false);
    expect(result.issues.every((issue) => issue.code === undefined)).toBe(true);
  });
});
