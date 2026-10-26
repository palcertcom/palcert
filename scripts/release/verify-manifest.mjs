#!/usr/bin/env node
/**
 * Decide whether a release manifest may be deployed from (Phase 20 Checkpoint 5).
 *
 *   node scripts/release/verify-manifest.mjs --manifest release-manifest.json [--registry-check]
 *
 * Runs before staging, before production promotion, and before a rollback,
 * because all three are the same act: resolve five digests and deploy them.
 * The checks are cheap and the failure they prevent is a deployment of
 * something nobody meant to deploy.
 *
 * `--registry-check` additionally asks the registry to resolve each digest,
 * which is the difference between "this file is well formed" and "these
 * images exist and can be pulled". It needs registry credentials, so it is a
 * choice rather than the default.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  COMPONENT_NAMES,
  validateManifest,
  findSecretShapedContent,
  serializeManifest,
} = require('./lib/release-manifest.cjs');

function parseArgs(argv) {
  const args = {
    manifest: null,
    registryCheck: false,
    expectCommit: null,
    json: false,
    // Only for a plain-HTTP registry, which in practice means a local
    // rehearsal. Production registries are HTTPS and must stay verified, so
    // this is opt-in rather than a convenience default.
    insecure: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--manifest') args.manifest = argv[(index += 1)];
    else if (arg === '--expect-commit') args.expectCommit = argv[(index += 1)];
    else if (arg === '--registry-check') args.registryCheck = true;
    else if (arg === '--insecure-registry') args.insecure = true;
    else if (arg === '--json') args.json = true;
  }
  return args;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`verify-manifest: ${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
}

const args = parseArgs(process.argv.slice(2));
if (args.manifest === null) {
  console.error('verify-manifest: --manifest <path> is required');
  process.exit(64);
}

let raw;
try {
  raw = readFileSync(args.manifest, 'utf8');
} catch (error) {
  console.error(`verify-manifest: cannot read ${args.manifest}: ${error.message}`);
  process.exit(65);
}

let manifest;
try {
  manifest = JSON.parse(raw);
} catch (error) {
  console.error(`verify-manifest: ${args.manifest} is not valid JSON: ${error.message}`);
  process.exit(65);
}

const problems = validateManifest(manifest);
check(
  'manifest is well formed',
  problems.length === 0,
  problems.length === 0 ? `release ${manifest.releaseVersion}` : problems.join('; '),
);

// Round-tripping proves the file on disk is the canonical serialization, which
// is what makes two manifests for the same release comparable byte for byte.
check(
  'manifest is in canonical form',
  serializeManifest(manifest) === raw,
  'sorted keys, stable formatting',
);

const secrets = findSecretShapedContent(raw);
check(
  'manifest carries nothing credential-shaped',
  secrets.length === 0,
  secrets.length === 0 ? 'clean' : secrets.join(', '),
);

// Five images, five distinct digests. Two components sharing a digest means
// the build published the same image twice under different names, which would
// deploy the wrong process somewhere.
const digests = COMPONENT_NAMES.map((name) => manifest.images?.[name]?.digest).filter(Boolean);
check(
  'every component has its own image',
  new Set(digests).size === COMPONENT_NAMES.length,
  `${new Set(digests).size} distinct digest(s) across ${COMPONENT_NAMES.length} components`,
);

if (args.expectCommit !== null) {
  check(
    'manifest is for the expected commit',
    manifest.commit === args.expectCommit,
    `${manifest.commit?.slice(0, 12)} vs expected ${args.expectCommit.slice(0, 12)}`,
  );
}

if (args.registryCheck) {
  for (const component of COMPONENT_NAMES) {
    const image = manifest.images?.[component];
    if (image === undefined) continue;
    const reference = `${manifest.registry}/${image.repository}@${image.digest}`;

    let ok = false;
    let detail = '';
    try {
      // `manifest inspect` resolves the reference without pulling the layers,
      // which is all that is needed to prove the digest exists and is readable
      // with these credentials.
      execFileSync(
        'docker',
        ['manifest', 'inspect', ...(args.insecure ? ['--insecure'] : []), reference],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      ok = true;
      detail = 'resolves in the registry';
    } catch (error) {
      detail = String(error.stderr ?? error.message)
        .split('\n')[0]
        .slice(0, 120);
    }
    check(`${component} digest is pullable`, ok, detail);
    if (!ok) continue;

    // And that these bytes were built from the commit this manifest claims.
    //
    // Without this a manifest can be assembled from the wrong images and look
    // perfectly valid: the digests exist, the version is well formed, and
    // every field agrees with every other field. The only thing that would
    // disagree is the image itself, which carries the commit it was built
    // from as an OCI label.
    let revision = null;
    try {
      const inspected = execFileSync(
        'docker',
        ['buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Image}}'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const parsed = JSON.parse(inspected);
      // Single-platform images describe the config directly; an index nests
      // one entry per platform, and any of them answers the question.
      const configs = parsed.config !== undefined ? [parsed] : Object.values(parsed);
      for (const entry of configs) {
        const labels = entry?.config?.Labels ?? entry?.Labels ?? null;
        if (labels?.['org.opencontainers.image.revision'] !== undefined) {
          revision = labels['org.opencontainers.image.revision'];
          break;
        }
      }
    } catch {
      revision = null;
    }

    if (revision === null) {
      check(`${component} records the commit it was built from`, false, 'no revision label');
    } else {
      check(
        `${component} was built from this release's commit`,
        revision === manifest.commit,
        revision === manifest.commit
          ? `${revision.slice(0, 12)}`
          : `image says ${revision.slice(0, 12)}, manifest says ${String(manifest.commit).slice(0, 12)}`,
      );
    }
  }
}

const failures = results.filter((result) => !result.ok);
if (args.json) {
  console.log(JSON.stringify({ releaseVersion: manifest.releaseVersion, results }, null, 2));
}
console.log(`verify-manifest: ${results.length - failures.length}/${results.length} checks passed`);
if (failures.length > 0) process.exit(65);
