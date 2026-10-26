#!/usr/bin/env node
/**
 * The audit record for one release (Phase 20 Checkpoint 5).
 *
 *   node scripts/release/make-release-record.mjs \
 *     --freeze release-freeze.json --out release-record.json \
 *     --staging staging-deployment.json \
 *     --approval '{"approvedBy":"...","reason":"...","ref":"refs/heads/main"}' \
 *     --result production-rehearsal=passed --result rollback=passed \
 *     --evidence staging-smoke=...
 *
 * One file answering, months later and without repository archaeology: what
 * was released, from which commit, as which five image digests, whether it
 * passed staging, who approved production, whether the rollback was rehearsed
 * and what the supply-chain scans found.
 *
 * Both readable and machine-readable on purpose. The machine reading is a
 * later promotion checking that production is deploying what staging
 * accepted; the human reading happens during an incident, at speed, by
 * someone who did not cut the release.
 *
 * Nothing credential-shaped may reach it — this file is read by more people
 * than a deployment log, and archived for longer. The same detector that
 * guards the manifest guards this, and it refuses to write rather than
 * redacting, because a record that silently drops a field is worse than one
 * that will not be written.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { serializeManifest, findSecretShapedContent } = require('./lib/release-manifest.cjs');

function parseArgs(argv) {
  const args = {
    freeze: null,
    out: null,
    staging: null,
    approval: null,
    results: {},
    evidence: {},
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--freeze') args.freeze = argv[(index += 1)];
    else if (arg === '--out') args.out = argv[(index += 1)];
    else if (arg === '--staging') args.staging = argv[(index += 1)];
    else if (arg === '--approval') args.approval = argv[(index += 1)];
    else if (arg === '--result' || arg === '--evidence') {
      const pair = String(argv[(index += 1)]);
      const split = pair.indexOf('=');
      const target = arg === '--result' ? args.results : args.evidence;
      target[pair.slice(0, split)] = pair.slice(split + 1);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.freeze === null || args.out === null) {
  console.error('make-release-record: --freeze and --out are required');
  process.exit(64);
}

const freeze = JSON.parse(readFileSync(args.freeze, 'utf8'));
const staging = args.staging === null ? null : JSON.parse(readFileSync(args.staging, 'utf8'));

/**
 * The approval, as stated.
 *
 * Who and why, never a credential or a token. "Approved by a workflow" is not
 * an approval — the question an auditor asks is which person accepted the
 * risk, and a record that cannot answer it is not an audit record.
 */
let approval = null;
if (args.approval !== null) {
  const supplied = JSON.parse(args.approval);
  approval = {
    approvedBy: supplied.approvedBy ?? null,
    reason: supplied.reason ?? null,
    ref: supplied.ref ?? null,
    approvedAt: supplied.approvedAt ?? new Date().toISOString(),
  };
}

const scan = freeze.supplyChain?.vulnerabilityScan ?? null;

const record = {
  recordVersion: 1,
  recordedAt: new Date().toISOString(),

  // --- identity ------------------------------------------------------------
  releaseVersion: freeze.releaseVersion,
  releaseTag: freeze.releaseTag,
  commit: freeze.commit,
  manifest: freeze.manifest,
  images: Object.fromEntries(
    Object.entries(freeze.images).map(([component, image]) => [component, image.reference]),
  ),
  migration: freeze.migration,
  schemaVersions: freeze.schemaVersions,

  // --- supply chain --------------------------------------------------------
  supplyChain: {
    vulnerabilityScan:
      scan === null
        ? null
        : {
            // The gate's own definition, so the record cannot claim "clean" on
            // a looser reading than the check that let the release through.
            fixableHighOrCritical: scan.fixableHighOrCritical,
            findings: scan.findings,
            blocking: scan.fixableHighOrCritical > 0,
          },
    secretScan: args.results['secret-scan'] ?? null,
    secretScanSelfTest: args.results['secret-scan-self-test'] ?? null,
    sbom:
      freeze.supplyChain?.sbom === null || freeze.supplyChain?.sbom === undefined
        ? null
        : Object.fromEntries(
            Object.entries(freeze.supplyChain.sbom).map(([component, entry]) => [
              component,
              {
                file: entry.file,
                format: entry.format,
                packages: entry.packages,
                digest: entry.digest,
              },
            ]),
          ),
    provenance: freeze.supplyChain?.provenance ?? null,
  },

  // --- delivery ------------------------------------------------------------
  staging:
    staging === null
      ? null
      : {
          outcome: staging.outcome,
          deployedAt: staging.deployedAt,
          manifestDigest: staging.manifestDigest,
          // Recorded so a reader can see that staging ran these bytes, rather
          // than a release that merely shared this version string.
          ranFrozenDigests: Object.entries(freeze.images).every(
            ([component, image]) =>
              typeof staging.images?.[component] === 'string' &&
              staging.images[component].endsWith(`@${image.digest}`),
          ),
        },
  approval,
  results: args.results,
  evidence: args.evidence,
};

const serialized = serializeManifest(record);
const secrets = findSecretShapedContent(serialized);
if (secrets.length > 0) {
  for (const label of secrets) console.error(`make-release-record:   contains ${label}`);
  console.error(
    'make-release-record: refusing to write a record containing credential-shaped content',
  );
  process.exit(70);
}

writeFileSync(args.out, serialized);

console.log(`make-release-record: ${record.releaseVersion} (${record.commit.slice(0, 12)})`);
console.log(`make-release-record:   manifest ${record.manifest.digest}`);
if (record.staging !== null) {
  console.log(
    `make-release-record:   staging ${record.staging.outcome}` +
      `${record.staging.ranFrozenDigests ? ', on the frozen digests' : ', NOT on the frozen digests'}`,
  );
}
if (record.approval !== null) {
  console.log(`make-release-record:   approved by ${record.approval.approvedBy}`);
}
for (const [name, outcome] of Object.entries(record.results)) {
  console.log(`make-release-record:   ${name}: ${outcome}`);
}
console.log(`make-release-record: written to ${args.out}`);
