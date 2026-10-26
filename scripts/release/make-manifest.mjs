#!/usr/bin/env node
/**
 * Write the release manifest for a set of images that have just been pushed
 * (Phase 20 Checkpoint 5).
 *
 *   node scripts/release/make-manifest.mjs \
 *     --commit "$GITHUB_SHA" --registry ghcr.io --owner "$OWNER" \
 *     --digest api=sha256:… --digest worker=sha256:… … \
 *     --out release-manifest.json
 *
 * The manifest is the only thing staging, production, rollback and
 * post-disaster redeployment read. Everything in it is derived from inputs
 * that are already fixed by the time this runs -- the commit, the application
 * version, the migrations on disk, and the digests the registry returned --
 * so writing it is bookkeeping rather than a decision.
 *
 * Digests come from the push, not from a local build. An image that was not
 * pushed has no digest, and a release that cannot name its digests is not a
 * release.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  RELEASE_MANIFEST_VERSION,
  RELEASE_COMPONENTS,
  COMPONENT_NAMES,
  DIGEST_PATTERN,
  releaseVersion,
  releaseTag,
  serializeManifest,
  sha256Hex,
  validateManifest,
  findSecretShapedContent,
} = require('./lib/release-manifest.cjs');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const args = {
    commit: null,
    registry: 'ghcr.io',
    owner: null,
    out: null,
    digests: {},
    builtAt: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--commit') args.commit = argv[(index += 1)];
    else if (arg === '--registry') args.registry = argv[(index += 1)];
    else if (arg === '--owner') args.owner = argv[(index += 1)];
    else if (arg === '--out') args.out = argv[(index += 1)];
    else if (arg === '--built-at') args.builtAt = argv[(index += 1)];
    else if (arg === '--digest') {
      const [component, digest] = String(argv[(index += 1)]).split('=');
      args.digests[component] = digest;
    }
  }
  return args;
}

function fail(message, exitCode = 1) {
  console.error(`make-manifest: ${message}`);
  process.exit(exitCode);
}

const args = parseArgs(process.argv.slice(2));
if (args.commit === null) fail('--commit <sha> is required', 64);
if (args.owner === null) fail('--owner <registry owner> is required', 64);
if (args.out === null) fail('--out <path> is required', 64);

const missing = COMPONENT_NAMES.filter((name) => args.digests[name] === undefined);
if (missing.length > 0) {
  // Not a warning. A release missing an image is a release that cannot be
  // deployed, and discovering that during a promotion is too late.
  fail(`no digest given for: ${missing.join(', ')}`, 64);
}
for (const [component, digest] of Object.entries(args.digests)) {
  if (!COMPONENT_NAMES.includes(component)) fail(`unknown component: ${component}`, 64);
  if (!DIGEST_PATTERN.test(String(digest))) fail(`${component}: not a sha256 digest`, 64);
}

const applicationVersion = JSON.parse(
  readFileSync(path.join(REPO, 'package.json'), 'utf8'),
).version;
const version = releaseVersion(applicationVersion, args.commit);
const tag = releaseTag(version);

// The migration state this release requires. Recorded so a deployment can be
// checked against it before anything serves, and so an operator reading the
// manifest of a release they are rolling back to can see whether its schema
// is the one currently in the database.
const migrationsDir = path.join(REPO, 'packages', 'database', 'prisma', 'migrations');
const migrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (migrations.length === 0) fail('no migrations found', 70);

const contracts = readFileSync(
  path.join(REPO, 'packages', 'contracts', 'src', 'checks', 'check.ts'),
  'utf8',
);
const claim = readFileSync(
  path.join(REPO, 'packages', 'contracts', 'src', 'certificates', 'claim.ts'),
  'utf8',
);
/**
 * Read an exported integer constant out of a contracts source file.
 *
 * Deliberately a text read rather than an import: this script runs before the
 * workspace is necessarily built, and a release manifest must be writable from
 * a checkout alone.
 */
const constant = (source, name) => {
  const match = new RegExp(String.raw`export const ${name} = (\d+)`).exec(source);
  return match === null ? null : Number(match[1]);
};

const manifest = {
  manifestVersion: RELEASE_MANIFEST_VERSION,
  releaseVersion: version,
  releaseTag: tag,
  applicationVersion,
  commit: args.commit,
  builtAt: args.builtAt ?? new Date().toISOString(),
  registry: args.registry,
  owner: args.owner,
  images: Object.fromEntries(
    COMPONENT_NAMES.map((component) => [
      component,
      {
        repository: `${args.owner}/${RELEASE_COMPONENTS[component]}`,
        digest: args.digests[component],
        // Recorded for humans. Nothing deploys from these: the digest above is
        // what every environment resolves, precisely because a tag can later
        // be moved to different bytes and a digest cannot.
        tags: [tag, `sha-${args.commit}`],
      },
    ]),
  ),
  migration: {
    count: migrations.length,
    head: migrations[migrations.length - 1],
    // Over the names, not the contents: this answers "is the database at the
    // schema level this release expects", which is a question about which
    // migrations have been applied.
    checksum: sha256Hex(migrations.join('\n')),
  },
  // Versions whose change is an operational event rather than an
  // implementation detail: a report hash or a certificate claim hash computed
  // under a different canonicalization is a different hash for the same input.
  schemaVersions: {
    reportSchema: constant(contracts, 'REPORT_SCHEMA_VERSION'),
    reportCanonicalization: constant(contracts, 'REPORT_CANONICALIZATION_VERSION'),
    certificateClaimSchema: constant(claim, 'CERTIFICATE_CLAIM_SCHEMA_VERSION'),
    certificateClaimCanonicalization: constant(claim, 'CERTIFICATE_CLAIM_CANONICALIZATION_VERSION'),
  },
};

const serialized = serializeManifest(manifest);

const problems = validateManifest(JSON.parse(serialized));
if (problems.length > 0) {
  for (const problem of problems) console.error(`make-manifest:   ${problem}`);
  fail(`refusing to write an invalid manifest (${problems.length} problem(s))`, 70);
}

const secrets = findSecretShapedContent(serialized);
if (secrets.length > 0) {
  // The manifest is committed, attached to a release, and read during an
  // incident. Nothing credential-shaped may reach it, whatever put it there.
  for (const label of secrets) console.error(`make-manifest:   contains ${label}`);
  fail('refusing to write a manifest containing credential-shaped content', 70);
}

writeFileSync(args.out, serialized);
console.log(`make-manifest: ${version} (${args.commit})`);
for (const component of COMPONENT_NAMES) {
  console.log(`make-manifest:   ${component} ${manifest.images[component].digest}`);
}
console.log(
  `make-manifest: migration head ${manifest.migration.head} (${manifest.migration.count})`,
);
console.log(`make-manifest: written to ${args.out}`);
