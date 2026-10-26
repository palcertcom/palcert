#!/usr/bin/env node
/**
 * The audit record for one deployment (Phase 20 Checkpoint 5).
 *
 * Answers, months later and without repository archaeology: what was deployed,
 * when, by whom, from which commit, which image digests, and whether the gates
 * passed. Nothing here is a credential — a deployment record is read by more
 * people than a deployment log, and often in a hurry.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  serializeManifest,
  findSecretShapedContent,
  manifestDigest,
  imageReferencesFromManifest,
} = require('./lib/release-manifest.cjs');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) args[arg.slice(2)] = argv[(index += 1)] ?? '';
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
for (const required of ['manifest', 'environment', 'out']) {
  if (args[required] === undefined) {
    console.error(`record-deployment: --${required} is required`);
    process.exit(64);
  }
}

const manifest = JSON.parse(readFileSync(args.manifest, 'utf8'));

const record = {
  recordVersion: 1,
  environment: args.environment,
  releaseVersion: manifest.releaseVersion,
  commit: manifest.commit,
  // The manifest by content, not just by name. A later promotion checks this
  // to prove production is deploying the same bytes staging accepted, which a
  // matching version string does not establish.
  manifestDigest: manifestDigest(manifest),
  deployedAt: new Date().toISOString(),
  // Who asked, and which automation carried it out. Both, because "a human
  // approved it" and "this run did it" are different facts.
  actor: args.actor ?? null,
  workflowRun: args['workflow-run'] ?? null,
  reason: args.reason === undefined || args.reason === '' ? null : args.reason,
  outcome: args.outcome ?? 'unknown',
  images: imageReferencesFromManifest(manifest),
  migration: manifest.migration,
  schemaVersions: manifest.schemaVersions,
};

const serialized = serializeManifest(record);
const secrets = findSecretShapedContent(serialized);
if (secrets.length > 0) {
  for (const label of secrets) console.error(`record-deployment:   contains ${label}`);
  console.error(
    'record-deployment: refusing to write a record containing credential-shaped content',
  );
  process.exit(70);
}

writeFileSync(args.out, serialized);
console.log(
  `record-deployment: ${record.releaseVersion} -> ${record.environment} (${record.outcome})`,
);
