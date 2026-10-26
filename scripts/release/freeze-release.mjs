#!/usr/bin/env node
/**
 * Freeze a verified release manifest into one indivisible release set
 * (Phase 20 Checkpoint 5).
 *
 *   node scripts/release/freeze-release.mjs \
 *     --manifest release-manifest.json --out release-freeze.json \
 *     --sbom-dir sbom --scan-dir scan [--provenance <predicate-type>]
 *
 * The manifest says what a release *is*. This says that a particular manifest
 * has been accepted, names its content hash, and records the supply-chain
 * evidence gathered against exactly those digests. From here on, staging,
 * production and rollback consume this file: nothing downstream re-derives a
 * digest, and nothing rebuilds.
 *
 * The five images are treated as one unit deliberately. They are built from
 * one commit, tested together, and share a schema expectation; promoting four
 * of them and rebuilding the fifth produces a system that was never tested,
 * under a version string that claims it was.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  COMPONENT_NAMES,
  serializeManifest,
  validateManifest,
  findSecretShapedContent,
  manifestDigest,
  imageReferencesFromManifest,
} = require('./lib/release-manifest.cjs');

function parseArgs(argv) {
  const args = { manifest: null, out: null, sbomDir: null, scanDir: null, provenance: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--manifest') args.manifest = argv[(index += 1)];
    else if (arg === '--out') args.out = argv[(index += 1)];
    else if (arg === '--sbom-dir') args.sbomDir = argv[(index += 1)];
    else if (arg === '--scan-dir') args.scanDir = argv[(index += 1)];
    else if (arg === '--provenance') args.provenance = argv[(index += 1)];
  }
  return args;
}

function fail(message, code = 65) {
  console.error(`freeze-release: ${message}`);
  process.exit(code);
}

const args = parseArgs(process.argv.slice(2));
if (args.manifest === null || args.out === null) {
  fail('--manifest and --out are required', 64);
}

const raw = readFileSync(args.manifest, 'utf8');
const manifest = JSON.parse(raw);

// A freeze is an acceptance. Accepting something that does not validate would
// make every later "verified against the freeze record" meaningless.
const problems = validateManifest(manifest);
if (problems.length > 0) {
  for (const problem of problems) console.error(`freeze-release:   ${problem}`);
  fail(`refusing to freeze an invalid manifest (${problems.length} problem(s))`);
}
if (serializeManifest(manifest) !== raw) {
  fail('the manifest on disk is not in canonical form; freeze the canonical file');
}

/** The content hash of a file on disk, so a named artifact can be re-checked. */
function fileDigest(file) {
  return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
}

/**
 * The SBOMs, by component, with their content hashes.
 *
 * Referenced rather than embedded: an SBOM for these images runs to hundreds
 * of packages each, and a freeze record is meant to be read. The hash is what
 * makes the reference checkable.
 */
function collectSboms(directory) {
  if (directory === null) return null;
  if (!existsSync(directory)) fail(`--sbom-dir ${directory} does not exist`);
  const found = {};
  for (const entry of readdirSync(directory)) {
    const match = /^palcert-(.+)\.spdx\.json$/.exec(entry);
    if (match === null) continue;
    const file = path.join(directory, entry);
    const document = JSON.parse(readFileSync(file, 'utf8'));
    found[match[1]] = {
      file: entry,
      format: 'SPDX-2.3',
      packages: (document.packages ?? []).length,
      digest: fileDigest(file),
    };
  }
  const missing = COMPONENT_NAMES.filter((name) => found[name] === undefined);
  if (missing.length > 0) fail(`no SBOM for: ${missing.join(', ')}`);
  return found;
}

/**
 * The vulnerability scan result, recomputed from the scan reports rather than
 * taken on trust from whoever ran them.
 *
 * Counts only *fixable* HIGH and CRITICAL, which is the same question the
 * release gate asks. A record that said "clean" on a different definition
 * than the gate that let it through would be worse than no record.
 */
function collectScan(directory) {
  if (directory === null) return null;
  if (!existsSync(directory)) fail(`--scan-dir ${directory} does not exist`);
  let fixableHighOrCritical = 0;
  let total = 0;
  const reports = {};
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(directory, entry);
    const document = JSON.parse(readFileSync(file, 'utf8'));
    let imageFixable = 0;
    let imageTotal = 0;
    for (const result of document.Results ?? []) {
      for (const vulnerability of result.Vulnerabilities ?? []) {
        imageTotal += 1;
        if (
          vulnerability.FixedVersion &&
          (vulnerability.Severity === 'HIGH' || vulnerability.Severity === 'CRITICAL')
        ) {
          imageFixable += 1;
        }
      }
    }
    fixableHighOrCritical += imageFixable;
    total += imageTotal;
    reports[entry.replace(/\.json$/, '')] = {
      fixableHighOrCritical: imageFixable,
      findings: imageTotal,
      digest: fileDigest(file),
    };
  }
  if (Object.keys(reports).length === 0) fail(`--scan-dir ${directory} holds no scan reports`);
  return { fixableHighOrCritical, findings: total, reports };
}

const freeze = {
  freezeVersion: 1,
  frozenAt: new Date().toISOString(),
  releaseVersion: manifest.releaseVersion,
  releaseTag: manifest.releaseTag,
  commit: manifest.commit,
  registry: manifest.registry,
  // The manifest this freeze is *of*, by content. A later file claiming the
  // same releaseVersion but hashing differently is a different release.
  manifest: {
    file: path.basename(args.manifest),
    digest: manifestDigest(manifest),
  },
  // The release set. Five digests, named together, because they are deployed
  // together or not at all.
  images: Object.fromEntries(
    COMPONENT_NAMES.map((component) => [
      component,
      {
        reference: imageReferencesFromManifest(manifest)[component],
        digest: manifest.images[component].digest,
      },
    ]),
  ),
  migration: manifest.migration,
  schemaVersions: manifest.schemaVersions,
  supplyChain: {
    sbom: collectSboms(args.sbomDir),
    vulnerabilityScan: collectScan(args.scanDir),
    // Named, not embedded: the attestation lives in the registry beside the
    // image and is fetched from there. Recording the predicate type says what
    // kind of statement to expect.
    provenance:
      args.provenance === null
        ? null
        : { predicateType: args.provenance, attachedTo: 'the image index in the registry' },
  },
};

const serialized = serializeManifest(freeze);
const secrets = findSecretShapedContent(serialized);
if (secrets.length > 0) {
  for (const label of secrets) console.error(`freeze-release:   contains ${label}`);
  fail('refusing to write a freeze record containing credential-shaped content', 70);
}

writeFileSync(args.out, serialized);

console.log(`freeze-release: ${freeze.releaseVersion} (${freeze.commit})`);
console.log(`freeze-release:   manifest ${freeze.manifest.digest}`);
for (const component of COMPONENT_NAMES) {
  console.log(`freeze-release:   ${component.padEnd(14)} ${freeze.images[component].digest}`);
}
if (freeze.supplyChain.vulnerabilityScan !== null) {
  const scan = freeze.supplyChain.vulnerabilityScan;
  console.log(
    `freeze-release:   scan ${scan.fixableHighOrCritical} fixable HIGH/CRITICAL across ${scan.findings} finding(s)`,
  );
}
console.log(`freeze-release: frozen to ${args.out}`);
