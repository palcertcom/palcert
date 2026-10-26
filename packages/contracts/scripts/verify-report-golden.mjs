#!/usr/bin/env node
/**
 * Verify the committed report golden.
 *
 * The fixture pair — the report and its canonical serialization — is the only
 * thing standing between "report hashes are stable" and a claim nobody checks.
 * Recomputing the determination, the score and both hashes here means a change
 * to any of them shows up as a failing gate rather than as reports that
 * quietly stop verifying against hashes issued last year (§78).
 *
 *   pnpm --filter @palcert/contracts run verify:report-golden
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertCheckReport,
  canonicalizeJson,
  computeDeterministicScore,
  computeEvaluationHash,
  determineCompliance,
  sha256Hex,
} from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, '../../../contracts/fixtures/checks');

const report = JSON.parse(readFileSync(resolve(fixtures, 'report-v1-input.json'), 'utf8'));
const canonical = readFileSync(resolve(fixtures, 'report-v1-canonical.json'), 'utf8');
const digest = readFileSync(resolve(fixtures, 'report-v1.sha256'), 'utf8').trim();

const problems = [];

assertCheckReport(report);

if (canonicalizeJson(report) !== canonical) {
  problems.push('the canonical serialization no longer matches report-v1-canonical.json');
}
if (sha256Hex(canonical) !== digest) {
  problems.push('the canonical bytes no longer hash to report-v1.sha256');
}

const determination = determineCompliance({ results: report.ruleResults }).determination;
if (determination !== report.determination) {
  problems.push(`determination is now ${determination}, fixture says ${report.determination}`);
}

const score = computeDeterministicScore(report.ruleResults);
if (score.value !== report.score.value || score.coverage !== report.score.coverage) {
  problems.push(
    `score is now ${score.value} (coverage ${score.coverage}), fixture says ${report.score.value} (coverage ${report.score.coverage})`,
  );
}

const evaluationHash = computeEvaluationHash({
  documentSha256: report.document.sha256,
  standardContentHash: report.standard.contentHash,
  analysisArtifactSha256: report.analysis.artifactSha256,
  analyzerName: report.analysis.analyzerName,
  analyzerVersion: report.analysis.analyzerVersion,
  factSchemaVersion: report.analysis.factSchemaVersion,
  ruleEngineName: report.engine.ruleEngineName,
  ruleEngineVersion: report.engine.ruleEngineVersion,
  ruleSchemaVersion: report.engine.ruleSchemaVersion,
  orchestratorVersion: report.engine.orchestratorVersion,
  determination: report.determination,
  score: report.score.value,
  scoreCoverage: report.score.coverage,
  results: report.ruleResults,
});
if (evaluationHash !== report.evaluationHash) {
  problems.push('the evaluation hash no longer matches the fixture');
}

if (problems.length > 0) {
  console.error('The report golden is out of date:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '\nIf this change is deliberate, it is a canonicalization change: raise\n' +
      'REPORT_CANONICALIZATION_VERSION and keep the old golden, so reports\n' +
      'written under the old rules still verify.',
  );
  process.exit(1);
}

process.stdout.write('The report golden verifies.\n');
