import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvaluationContract, validateEvaluationContract } from './validator.js';

/**
 * The cross-language contract tests.
 *
 * These run the *same* fixture files the Python engine runs
 * (`services/document-engine/tests/engine/test_contracts.py` and
 * `test_golden.py`), through the *same* JSON Schema. A payload accepted by one
 * runtime and rejected by the other fails CI here — which is the whole reason
 * for having one schema instead of two hand-written models.
 */

function repositoryRoot(): string {
  let directory = resolve(dirname(new URL(import.meta.url).pathname));
  for (let depth = 0; depth < 10; depth += 1) {
    try {
      readdirSync(join(directory, 'contracts', 'schemas'));
      return directory;
    } catch {
      directory = dirname(directory);
    }
  }
  throw new Error('Could not locate the contracts directory');
}

const ROOT = repositoryRoot();
const GOLDEN_DIR = join(ROOT, 'contracts', 'fixtures', 'evaluation');
const INVALID_DIR = join(ROOT, 'contracts', 'fixtures', 'invalid');

const read = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

const goldenFiles = readdirSync(GOLDEN_DIR).filter((name) => name.endsWith('.json'));
const invalidFiles = readdirSync(INVALID_DIR).filter((name) => name.endsWith('.json'));

describe('golden fixtures — accepted by TypeScript exactly as by Python', () => {
  it('finds the shared fixtures', () => {
    expect(goldenFiles.length).toBeGreaterThanOrEqual(15);
  });

  it.each(goldenFiles)('%s has a valid fact set', (name) => {
    const fixture = read(join(GOLDEN_DIR, name));
    const result = validateEvaluationContract(
      EvaluationContract.DOCUMENT_FACT_SET,
      fixture.factSet,
    );
    expect(result.issues).toEqual([]);
  });

  it.each(goldenFiles)('%s has a valid expected result', (name) => {
    const fixture = read(join(GOLDEN_DIR, name));
    const result = validateEvaluationContract(
      EvaluationContract.RULE_EVALUATION_RESULT,
      fixture.expectedResult,
    );
    expect(result.issues).toEqual([]);
  });
});

describe('rejection fixtures — refused by TypeScript exactly as by Python', () => {
  it('finds the shared rejection fixtures', () => {
    expect(invalidFiles.length).toBeGreaterThanOrEqual(10);
  });

  it.each(invalidFiles)('%s is rejected', (name) => {
    const fixture = read(join(INVALID_DIR, name));
    const result = validateEvaluationContract(
      fixture.contract as (typeof EvaluationContract)[keyof typeof EvaluationContract],
      fixture.payload,
    );

    // If this passes in TypeScript while the Python suite rejects it, the two
    // validators have diverged and the contract is no longer shared.
    expect(result.valid).toBe(false);
  });

  it.each(invalidFiles)('%s explains why it must be rejected', (name) => {
    const fixture = read(join(INVALID_DIR, name));
    expect(String(fixture.description ?? '').length).toBeGreaterThan(20);
  });
});

describe('the validator itself', () => {
  it('accepts a minimal fact set', () => {
    const result = validateEvaluationContract(EvaluationContract.DOCUMENT_FACT_SET, {
      factSchemaVersion: 1,
      documentId: 'd',
      extractor: { name: 'synthetic', version: '1' },
      coverage: [],
      facts: [],
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a JSON number where a decimal string is required', () => {
    // The single most important rejection: a JSON number is read back as a
    // binary float, and 0.1 + 0.2 is not 0.3 in a margin measurement.
    const result = validateEvaluationContract(EvaluationContract.FACT_VALUE, {
      type: 'NUMBER',
      number: 11,
    });
    expect(result.valid).toBe(false);
  });

  it('reports a JSON Pointer for each problem', () => {
    const result = validateEvaluationContract(EvaluationContract.DOCUMENT_FACT_SET, {
      factSchemaVersion: 1,
      documentId: 'd',
      extractor: { name: 'synthetic', version: '1' },
      coverage: [],
      facts: [
        {
          scope: { kind: 'ELEMENT', property: 'fontSize' },
          value: { type: 'NUMBER', number: '1' },
        },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.path.startsWith('/facts/0'))).toBe(true);
  });

  it('reports every problem rather than only the first', () => {
    const result = validateEvaluationContract(EvaluationContract.LOCATION, {
      locationSchemaVersion: 1,
      nodeId: '',
      page: 0,
    });
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses an unknown contract name rather than silently passing', () => {
    expect(() =>
      validateEvaluationContract(
        'NoSuchThing' as (typeof EvaluationContract)[keyof typeof EvaluationContract],
        {},
      ),
    ).toThrow(/No such evaluation contract/);
  });
});
