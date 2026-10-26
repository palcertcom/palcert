import { ObservationUniformity, type DocumentFactSet } from '@palcert/contracts';
import { TemplateObservationEngine, scopeKey } from './template-observation.service';

/**
 * Template observations are measurements, not opinions (§32, §33, §34).
 *
 * These tests run without a model, a network or a provider, because the whole
 * point of the engine is that they can: PalCert already knows exactly what a
 * DOCX does, and asking a language model to guess would be slower, dearer and
 * less accurate.
 */

const engine = new TemplateObservationEngine();

function factSet(
  facts: {
    property?: string;
    element?: string;
    level?: number;
    number?: string;
    text?: string;
    unit?: 'POINT' | 'MILLIMETRE';
    times?: number;
  }[],
): DocumentFactSet {
  const expanded = facts.flatMap((fact) =>
    Array.from({ length: fact.times ?? 1 }, () => ({
      scope:
        fact.element === undefined
          ? { kind: 'DOCUMENT' as const, property: fact.property ?? 'wordCount' }
          : {
              kind: 'ELEMENT' as const,
              elementType: fact.element as 'PARAGRAPH',
              ...(fact.level === undefined ? {} : { level: fact.level }),
              property: fact.property ?? 'fontSize',
            },
      value:
        fact.number === undefined
          ? { type: 'STRING' as const, text: fact.text ?? 'x' }
          : { type: 'NUMBER' as const, number: fact.number },
      ...(fact.unit === undefined ? {} : { unit: fact.unit }),
    })),
  );
  return {
    factSchemaVersion: 2,
    documentId: 'template-1',
    extractor: { name: 'test', version: '1' } as DocumentFactSet['extractor'],
    coverage: [],
    facts: expanded as DocumentFactSet['facts'],
  };
}

function observe(set: DocumentFactSet) {
  return engine.observe({
    factSet: set,
    sourceAssetId: '11111111-1111-4111-8111-111111111111',
    sourceSha256: 'a'.repeat(64),
    maxObservations: 100,
  });
}

describe('TemplateObservationEngine', () => {
  it('reports a consistent template as UNIFORM', () => {
    const [observation] = observe(
      factSet([{ element: 'HEADING', level: 1, number: '16', unit: 'POINT', times: 12 }]),
    );

    expect(observation?.uniformity).toBe(ObservationUniformity.UNIFORM);
    expect(observation?.occurrenceCount).toBe(12);
    expect(observation?.matchingCount).toBe(12);
    expect(observation?.distinctValueCount).toBe(1);
    expect(observation?.modalValue).toBe('16');
  });

  it('reports a nearly-consistent template as MOSTLY_UNIFORM, with the counts', () => {
    // The §33 example: 187 of 196 at 12 pt. A reviewer needs the numbers, not
    // a verdict — and certainly not a confidence score (§34).
    const [observation] = observe(
      factSet([
        { element: 'PARAGRAPH', number: '12', unit: 'POINT', times: 187 },
        { element: 'PARAGRAPH', number: '11', unit: 'POINT', times: 5 },
        { element: 'PARAGRAPH', number: '14', unit: 'POINT', times: 4 },
      ]),
    );

    expect(observation?.uniformity).toBe(ObservationUniformity.MOSTLY_UNIFORM);
    expect(observation?.occurrenceCount).toBe(196);
    expect(observation?.matchingCount).toBe(187);
    expect(observation?.distinctValueCount).toBe(3);
    expect(observation?.distribution).toEqual([
      { value: '12', count: 187 },
      { value: '11', count: 5 },
      { value: '14', count: 4 },
    ]);
  });

  it('reports an inconsistent template as MIXED rather than picking the winner', () => {
    // The single most important behaviour here. A template with no settled
    // value is evidence that the institution has not decided, and turning the
    // modal value into a requirement would be PalCert inventing policy (§33).
    const [observation] = observe(
      factSet([
        { element: 'PARAGRAPH', number: '12', unit: 'POINT', times: 10 },
        { element: 'PARAGRAPH', number: '11', unit: 'POINT', times: 9 },
      ]),
    );

    expect(observation?.uniformity).toBe(ObservationUniformity.MIXED);
    expect(observation?.modalValue).toBe('12');
  });

  it('says nothing at all about a property it barely saw', () => {
    const [observation] = observe(
      factSet([{ element: 'CAPTION', number: '10', unit: 'POINT', times: 1 }]),
    );

    expect(observation?.uniformity).toBe(ObservationUniformity.INSUFFICIENT_SAMPLE);
    expect(observation?.occurrenceCount).toBe(1);
  });

  it('never mixes two units into one distribution', () => {
    // Averaging millimetres with points would produce a number that means
    // nothing and looks authoritative.
    const observations = observe(
      factSet([
        { element: 'PARAGRAPH', property: 'indent', number: '12', unit: 'POINT', times: 5 },
        { element: 'PARAGRAPH', property: 'indent', number: '12', unit: 'MILLIMETRE', times: 5 },
      ]),
    );

    const indent = observations.find((entry) => entry.property === 'indent');
    expect(indent?.unit).toBe('POINT');
    expect(indent?.occurrenceCount).toBe(5);
  });

  it('keeps measurements as exact decimal strings', () => {
    const [observation] = observe(
      factSet([{ element: 'PARAGRAPH', number: '1.15', unit: 'POINT', times: 4 }]),
    );

    expect(observation?.modalValue).toBe('1.15');
    expect(typeof observation?.modalValue).toBe('string');
  });

  it('produces the same observations, in the same order, every time', () => {
    // What makes the run hash reproducible and these tests worth anything.
    const set = factSet([
      { element: 'PARAGRAPH', number: '12', unit: 'POINT', times: 8 },
      { element: 'HEADING', level: 1, number: '16', unit: 'POINT', times: 6 },
      { property: 'wordCount', number: '9000' },
    ]);

    expect(observe(set)).toEqual(observe(set));
  });

  it('hashes an observation to its source, so a proposal can be traced back', () => {
    const [first] = observe(
      factSet([{ element: 'PARAGRAPH', number: '12', unit: 'POINT', times: 5 }]),
    );
    const other = engine.observe({
      factSet: factSet([{ element: 'PARAGRAPH', number: '12', unit: 'POINT', times: 5 }]),
      sourceAssetId: '22222222-2222-4222-8222-222222222222',
      sourceSha256: 'b'.repeat(64),
      maxObservations: 100,
    })[0];

    expect(first?.observationHash).toMatch(/^[0-9a-f]{64}$/);
    // Same measurement, different document: different evidence.
    expect(other?.observationHash).not.toBe(first?.observationHash);
  });

  it('puts the settled properties first and bounds how many it returns', () => {
    const observations = engine.observe({
      factSet: factSet([
        { element: 'PARAGRAPH', property: 'a', number: '1', times: 5 },
        { element: 'PARAGRAPH', property: 'b', number: '1', times: 3 },
        { element: 'PARAGRAPH', property: 'b', number: '2', times: 3 },
      ]),
      sourceAssetId: '11111111-1111-4111-8111-111111111111',
      sourceSha256: 'a'.repeat(64),
      maxObservations: 1,
    });

    expect(observations).toHaveLength(1);
    expect(observations[0]?.uniformity).toBe(ObservationUniformity.UNIFORM);
  });
});

describe('scopeKey', () => {
  it('identifies a property structurally, never by parsing a rule code', () => {
    // ADR-0026: `BODY.FONT.SIZE` is a label a human chose, and matching on it
    // breaks the first time someone names a rule differently.
    expect(scopeKey({ kind: 'DOCUMENT', property: 'wordCount' })).toBe('DOCUMENT::wordCount');
    expect(
      scopeKey({ kind: 'ELEMENT', elementType: 'HEADING', level: 1, property: 'fontSize' }),
    ).toBe('ELEMENT:HEADING#1:fontSize');
    expect(scopeKey({ kind: 'PAGE', pages: 'ALL', property: 'marginLeft' })).toBe(
      'PAGE:ALL:marginLeft',
    );
    expect(scopeKey({ kind: 'METADATA', field: 'title' })).toBe('METADATA::title');
  });

  it('keeps two heading levels apart', () => {
    const level1 = scopeKey({
      kind: 'ELEMENT',
      elementType: 'HEADING',
      level: 1,
      property: 'fontSize',
    });
    const level2 = scopeKey({
      kind: 'ELEMENT',
      elementType: 'HEADING',
      level: 2,
      property: 'fontSize',
    });
    expect(level1).not.toBe(level2);
  });
});
