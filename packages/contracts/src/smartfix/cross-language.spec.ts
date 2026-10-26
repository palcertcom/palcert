import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type SmartFixContract, validateSmartFixContract } from './validator.js';

/**
 * The cross-language SmartFix contract tests.
 *
 * These run the *same* fixture files the Python mutation engine runs
 * (`services/document-engine/tests/smartfix/test_contracts.py`) through the
 * *same* JSON Schema. A plan accepted by one runtime and rejected by the other
 * fails CI here — which is what stops a plan the API considers well-formed
 * from meaning something else to the engine that will apply it to a thesis.
 *
 * The rejected fixtures matter more than the accepted ones. Each carries a
 * `why`: an action type nobody implemented, an XPath expression smuggled into
 * an action, a font size as a JSON float. None of those may be shrugged off.
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

interface Fixture {
  readonly contract: SmartFixContract;
  readonly why: string;
  readonly value: unknown;
}

const ROOT = repositoryRoot();
const ACCEPTED = join(ROOT, 'contracts', 'fixtures', 'smartfix', 'accepted');
const REJECTED = join(ROOT, 'contracts', 'fixtures', 'smartfix', 'rejected');

const load = (directory: string): readonly (readonly [string, Fixture])[] =>
  readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => [name, JSON.parse(readFileSync(join(directory, name), 'utf8')) as Fixture]);

const accepted = load(ACCEPTED);
const rejected = load(REJECTED);

describe('SmartFix fixtures — accepted by TypeScript exactly as by Python', () => {
  it('finds the shared fixtures', () => {
    expect(accepted.length).toBeGreaterThanOrEqual(8);
    expect(rejected.length).toBeGreaterThanOrEqual(15);
  });

  it.each(accepted)('%s is accepted', (_name, fixture) => {
    const result = validateSmartFixContract(fixture.contract, fixture.value);
    expect(result.issues).toEqual([]);
  });

  it.each(accepted)('%s explains itself', (_name, fixture) => {
    expect(fixture.why.length).toBeGreaterThan(20);
  });
});

describe('SmartFix fixtures — rejected by TypeScript exactly as by Python', () => {
  it.each(rejected)('%s is rejected', (_name, fixture) => {
    const result = validateSmartFixContract(fixture.contract, fixture.value);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it.each(rejected)('%s explains itself', (_name, fixture) => {
    expect(fixture.why.length).toBeGreaterThan(20);
  });
});
