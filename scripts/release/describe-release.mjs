#!/usr/bin/env node
/**
 * The release descriptor: one machine-readable answer to "what exactly is
 * this release?" (Phase 20 Checkpoint 9).
 *
 *   node scripts/release/describe-release.mjs \
 *     --freeze release-freeze.json --out release-descriptor.json
 *
 * The manifest names the images and the migration state; the freeze record
 * binds that manifest, by content hash, to its supply-chain evidence. Neither
 * says which analyzer versions produced the reports this release will write,
 * and those are exactly what an operator needs when a stored report, a
 * certificate claim or an analysis artifact has to be matched to the software
 * that made it. This composes all of it into one file, and checks it on the
 * way:
 *
 *  - the manifest on disk is the one the freeze accepted (same content hash);
 *  - the analyzer versions the API records agree with the versions the engine
 *    reports, because a disagreement there would stamp artifacts with a
 *    version that did not produce them;
 *  - nothing credential-shaped is in the output.
 *
 * Every value is derived from the release's own records or read from the
 * source at the release commit. Nothing here is typed in.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  COMPONENT_NAMES,
  manifestDigest,
  validateManifest,
  sha256Hex,
  findSecretShapedContent,
  serializeManifest,
} = require('./lib/release-manifest.cjs');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function fail(message, code = 1) {
  console.error(`describe-release: ${message}`);
  process.exit(code);
}

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
};
const freezePath = argument('--freeze');
const out = argument('--out');
if (freezePath === null || out === null) fail('--freeze <file> and --out <file> are required', 64);

const freezeText = readFileSync(freezePath, 'utf8');
const freeze = JSON.parse(freezeText);
const manifestPath = path.join(path.dirname(freezePath), freeze.manifest.file);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const problems = validateManifest(manifest);
if (problems.length > 0) fail(`the manifest is not valid: ${problems.join('; ')}`, 65);
if (manifestDigest(manifest) !== freeze.manifest.digest) {
  fail('the manifest on disk is not the one this freeze record accepted', 65);
}

// --- constants, read from the source at the release commit ---------------
//
// Read from the checkout, so the checkout must *be* the release commit for
// every file read here -- otherwise the descriptor would describe whatever
// happens to be on disk and label it with the release's name.
const SOURCES = [
  'services/document-engine/app',
  'packages/contracts/src',
  'apps/api/src/modules/analysis',
];
try {
  execFileSync('git', ['diff', '--quiet', manifest.commit, '--', ...SOURCES], { cwd: REPO });
} catch {
  fail(`the checkout's analyzer and contract sources differ from ${manifest.commit}`, 65);
}
const read = (relative) => readFileSync(path.join(REPO, relative), 'utf8');
function constant(relative, name) {
  const source = read(relative);
  const match =
    new RegExp(String.raw`^export const ${name}(?::\s*\w+)?\s*=\s*'?([\w.-]+)'?`, 'm').exec(
      source,
    ) ?? new RegExp(String.raw`^${name}(?::\s*\w+)?\s*=\s*"?([\w.-]+)"?`, 'm').exec(source);
  if (match === null) fail(`${name} not found in ${relative}`, 70);
  const value = match[1];
  return /^\d+$/.test(value) ? Number(value) : value;
}

const ENGINE = 'services/document-engine/app';
const docx = {
  analyzerVersion: String(constant(`${ENGINE}/docx/artifact.py`, 'ANALYZER_VERSION')),
  envelopeSchemaVersion: constant(`${ENGINE}/docx/artifact.py`, 'ENVELOPE_SCHEMA_VERSION'),
  analysisSchemaVersion: constant(`${ENGINE}/docx/model.py`, 'ANALYSIS_SCHEMA_VERSION'),
  factSchemaVersion: constant(`${ENGINE}/engine/facts/model.py`, 'FACT_SCHEMA_VERSION'),
  locationSchemaVersion: constant(`${ENGINE}/docx/facts.py`, 'LOCATION_SCHEMA_VERSION'),
  citationAnalysisSchemaVersion: constant(
    `${ENGINE}/docx/citations/producer.py`,
    'CITATION_ANALYSIS_SCHEMA_VERSION',
  ),
};
const pdf = {
  analyzerVersion: String(constant(`${ENGINE}/pdf/analyzer.py`, 'ANALYZER_VERSION')),
  envelopeSchemaVersion: constant(`${ENGINE}/pdf/analyzer.py`, 'ENVELOPE_SCHEMA_VERSION'),
  analysisSchemaVersion: constant(`${ENGINE}/pdf/analyzer.py`, 'ANALYSIS_SCHEMA_VERSION'),
  modelVersion: constant(`${ENGINE}/pdf/model.py`, 'PDF_MODEL_VERSION'),
  classifierVersion: constant(`${ENGINE}/pdf/classify.py`, 'CLASSIFIER_VERSION'),
  factSchemaVersion: constant(`${ENGINE}/pdf/facts.py`, 'FACT_SCHEMA_VERSION'),
  locationSchemaVersion: constant(`${ENGINE}/pdf/facts.py`, 'LOCATION_SCHEMA_VERSION'),
  citationAnalysisSchemaVersion: constant(
    `${ENGINE}/pdf/citations.py`,
    'CITATION_ANALYSIS_SCHEMA_VERSION',
  ),
};

// The API stamps every stored analysis with the version it believes produced
// it. If that belief and the engine disagree, every artifact is mislabelled.
const API_ANALYSIS = 'apps/api/src/modules/analysis/services/document-analysis.service.ts';
const apiDocx = String(constant(API_ANALYSIS, 'DOCX_ANALYZER_VERSION'));
const apiPdf = String(constant(API_ANALYSIS, 'PDF_ANALYZER_VERSION'));
if (apiDocx !== docx.analyzerVersion || apiPdf !== pdf.analyzerVersion) {
  fail(
    `analyzer versions disagree: API docx=${apiDocx} pdf=${apiPdf}, ` +
      `engine docx=${docx.analyzerVersion} pdf=${pdf.analyzerVersion}`,
    65,
  );
}

const smartfixRegistry = read('packages/contracts/src/smartfix/registry.generated.ts');
const smartfix = {
  engineVersion: /engine:\s*\{\s*name:\s*'[^']+',\s*version:\s*'([^']+)'/.exec(
    smartfixRegistry,
  )?.[1],
  registryVersion: Number(/registryVersion:\s*(\d+)/.exec(smartfixRegistry)?.[1]),
  planSchemaVersion: Number(/planSchemaVersion:\s*(\d+)/.exec(smartfixRegistry)?.[1]),
  manifestSchemaVersion: Number(/manifestSchemaVersion:\s*(\d+)/.exec(smartfixRegistry)?.[1]),
};

const CONTRACTS = 'packages/contracts/src';
const descriptor = {
  descriptorVersion: 1,
  product: 'PalCert',
  applicationVersion: manifest.applicationVersion,
  releaseVersion: manifest.releaseVersion,
  releaseTag: manifest.releaseTag,
  sourceCommit: manifest.commit,
  builtAt: manifest.builtAt,
  manifest: { file: freeze.manifest.file, digest: freeze.manifest.digest },
  freeze: { file: path.basename(freezePath), sha256: `sha256:${sha256Hex(freezeText)}` },
  registry: manifest.registry,
  images: Object.fromEntries(
    COMPONENT_NAMES.map((component) => [
      component,
      {
        reference: `${manifest.registry}/${manifest.images[component].repository}@${manifest.images[component].digest}`,
        digest: manifest.images[component].digest,
      },
    ]),
  ),
  migration: manifest.migration,
  schemaVersions: {
    ...manifest.schemaVersions,
    rule: constant(`${CONTRACTS}/standards/rule-schema.ts`, 'RULE_SCHEMA_VERSION'),
    evaluationEngine: constant(`${CONTRACTS}/evaluation/constants.ts`, 'EVALUATION_ENGINE_VERSION'),
    extraction: constant(`${CONTRACTS}/extraction/run.ts`, 'EXTRACTION_SCHEMA_VERSION'),
    submissionEvidence: constant(
      `${CONTRACTS}/submissions/evidence.ts`,
      'SUBMISSION_EVIDENCE_SCHEMA_VERSION',
    ),
    domainEvent: constant(
      `${CONTRACTS}/notifications/notification.ts`,
      'DOMAIN_EVENT_SCHEMA_VERSION',
    ),
    aiReview: constant(`${CONTRACTS}/ai/review.ts`, 'AI_REVIEW_SCHEMA_VERSION'),
    aiContext: constant(`${CONTRACTS}/ai/review.ts`, 'AI_CONTEXT_SCHEMA_VERSION'),
    aiAssessment: constant(`${CONTRACTS}/ai/review.ts`, 'AI_ASSESSMENT_SCHEMA_VERSION'),
  },
  analyzers: {
    documentEngineVersion: constant(`${ENGINE}/__init__.py`, '__version__'),
    evaluationEngineVersion: constant(`${ENGINE}/engine/evaluation/engine.py`, 'ENGINE_VERSION'),
    docx,
    pdf,
    smartfix,
  },
  supplyChain: freeze.supplyChain,
};

const serialized = serializeManifest(descriptor);
const secrets = findSecretShapedContent(serialized);
if (secrets.length > 0)
  fail(`refusing to write credential-shaped content: ${secrets.join(', ')}`, 70);

writeFileSync(out, serialized);
console.log(`describe-release: ${descriptor.releaseVersion} (${descriptor.sourceCommit})`);
console.log(`describe-release:   manifest ${descriptor.manifest.digest}`);
console.log(
  `describe-release:   migrations ${descriptor.migration.count}, head ${descriptor.migration.head}`,
);
console.log(
  `describe-release:   analyzers docx ${docx.analyzerVersion}, pdf ${pdf.analyzerVersion}; ` +
    `report schema ${descriptor.schemaVersions.reportSchema}`,
);
console.log(`describe-release: written to ${out}`);
