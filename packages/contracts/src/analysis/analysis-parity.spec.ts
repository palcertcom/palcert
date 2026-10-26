import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateAnalysisArtifact } from './validator.js';
import { validateEvaluationContract, EvaluationContract } from '../evaluation/validator.js';

/**
 * The analysis artifact contract, both sides of it (§33).
 *
 * Phase 6 shipped this envelope in Python only; Node parsed whatever arrived.
 * These fixtures are validated here *and* by the Python suite, against the
 * same schema file, so an artifact either runtime would accept and the other
 * would reject fails CI rather than a production check.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, '../../../../contracts/fixtures/analysis');

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'));
}

describe('analysis artifact contract', () => {
  it('accepts a real artifact produced by the analyzer', () => {
    const result = validateAnalysisArtifact(load('artifact-v2-minimal.json'));
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('the fact set inside it satisfies the evaluation contract too', () => {
    const artifact = load('artifact-v2-minimal.json') as { factSet: unknown };
    const result = validateEvaluationContract(
      EvaluationContract.DOCUMENT_FACT_SET,
      artifact.factSet,
    );
    expect(result.issues).toEqual([]);
  });

  const rejections = readdirSync(fixturesDir).filter((name) => name.startsWith('invalid-'));

  it('has rejection fixtures', () => {
    expect(rejections.length).toBeGreaterThan(0);
  });

  it.each(rejections)('rejects %s', (name) => {
    expect(validateAnalysisArtifact(load(name)).valid).toBe(false);
  });

  it('carries the identities a check depends on', () => {
    const artifact = load('artifact-v2-minimal.json') as {
      analyzer: { name: string; version: string };
      source: { sha256: string };
      factSchemaVersion: number;
      analysisSchemaVersion: number;
    };
    expect(artifact.analyzer.name).toBe('palcert-docx');
    expect(artifact.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.factSchemaVersion).toBeGreaterThanOrEqual(1);
    expect(artifact.analysisSchemaVersion).toBeGreaterThanOrEqual(1);
  });
});
