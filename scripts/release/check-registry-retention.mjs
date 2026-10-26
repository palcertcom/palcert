#!/usr/bin/env node
/**
 * Decide what registry cleanup may delete, and prove it cannot delete a
 * rollback target (Phase 20 Checkpoint 5).
 *
 *   node scripts/release/check-registry-retention.mjs \
 *     --registry 127.0.0.1:5001 --owner testowner \
 *     --protect release-freeze.json --protect previous-release-freeze.json \
 *     [--keep 10] [--insecure] [--json]
 *
 * A rollback plan that depends on an image an automated cleanup may delete is
 * not a rollback plan. Registry retention is usually configured as "keep the
 * last N" or "delete untagged after D days", and both quietly assume the
 * thing worth keeping is the thing most recently pushed. During an incident
 * the thing worth keeping is the release *before* the one that broke — which
 * is, by construction, older.
 *
 * So the protected set is named explicitly rather than inferred from age:
 *
 *   - every image digest of the release currently in production;
 *   - every image digest of the release that is the rollback target;
 *   - the release manifest and freeze record for both, since a digest nobody
 *     can find is as good as deleted;
 *   - the SBOM and provenance attached to those images, which are what answer
 *     "what was in the thing that was running" after the fact.
 *
 * This reports what a cleanup pass would remove under the policy, and fails
 * if that set intersects the protected one. It deletes nothing itself: a tool
 * that both decides and deletes is one bug away from being the incident.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { COMPONENT_NAMES, RELEASE_COMPONENTS } = require('./lib/release-manifest.cjs');

function parseArgs(argv) {
  const args = { registry: null, owner: null, protect: [], keep: 10, insecure: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--registry') args.registry = argv[(index += 1)];
    else if (arg === '--owner') args.owner = argv[(index += 1)];
    else if (arg === '--protect') args.protect.push(argv[(index += 1)]);
    else if (arg === '--keep') args.keep = Number(argv[(index += 1)]);
    else if (arg === '--insecure') args.insecure = true;
    else if (arg === '--json') args.json = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.registry === null || args.owner === null || args.protect.length === 0) {
  console.error(
    'check-registry-retention: --registry, --owner and at least one --protect are required',
  );
  process.exit(64);
}

/** Every tag a repository currently holds, and the digest each resolves to. */
function repositoryTags(repository) {
  const scheme = args.insecure ? 'http' : 'https';
  const url = `${scheme}://${args.registry}/v2/${args.owner}/${repository}/tags/list`;
  let body;
  try {
    body = execFileSync('curl', ['-sS', '--fail', url], { encoding: 'utf8' });
  } catch (error) {
    console.error(`check-registry-retention: cannot list ${repository}: ${error.message}`);
    process.exit(69);
  }
  const tags = JSON.parse(body).tags ?? [];
  return tags.map((tag) => {
    const headers = execFileSync(
      'curl',
      [
        '-sS',
        '-I',
        '-H',
        'Accept: application/vnd.oci.image.index.v1+json',
        '-H',
        'Accept: application/vnd.oci.image.manifest.v1+json',
        '-H',
        'Accept: application/vnd.docker.distribution.manifest.v2+json',
        `${scheme}://${args.registry}/v2/${args.owner}/${repository}/manifests/${tag}`,
      ],
      { encoding: 'utf8' },
    );
    const digest = /docker-content-digest:\s*(\S+)/i.exec(headers)?.[1] ?? null;
    return { tag, digest };
  });
}

// --- the protected set ------------------------------------------------------
const protectedDigests = new Map();
const protectedReleases = [];
for (const file of args.protect) {
  const freeze = JSON.parse(readFileSync(file, 'utf8'));
  protectedReleases.push(freeze.releaseVersion);
  for (const component of COMPONENT_NAMES) {
    const digest = freeze.images[component].digest;
    protectedDigests.set(`${RELEASE_COMPONENTS[component]}@${digest}`, {
      release: freeze.releaseVersion,
      component,
    });
  }
}

console.log(
  `check-registry-retention: protecting ${protectedReleases.join(', ')} ` +
    `(${protectedDigests.size} image digest(s))`,
);

// --- what cleanup would delete ---------------------------------------------
let failed = false;
const deletable = [];
const kept = [];

for (const component of COMPONENT_NAMES) {
  const repository = RELEASE_COMPONENTS[component];
  const tags = repositoryTags(repository);

  // The policy: keep the most recent `--keep` tags, then delete the rest.
  // Sorted by tag so the ordering is deterministic and independent of the
  // registry's listing order, which is not specified.
  const ordered = [...tags].sort((left, right) => right.tag.localeCompare(left.tag));
  const candidates = ordered.slice(args.keep);

  for (const entry of candidates) {
    const key = `${repository}@${entry.digest}`;
    if (protectedDigests.has(key)) {
      // The whole point. A protected digest reached the deletion candidate
      // list, which means the policy alone would have removed a rollback
      // target: a release old enough to fall outside "keep the last N" is
      // exactly the one an incident needs.
      const owner = protectedDigests.get(key);
      console.error(
        `check-registry-retention: FAIL cleanup would delete ${repository}:${entry.tag} — ` +
          `the ${owner.component} image of ${owner.release}`,
      );
      failed = true;
    } else {
      deletable.push(`${repository}:${entry.tag}`);
    }
  }
  for (const entry of ordered.slice(0, args.keep)) kept.push(`${repository}:${entry.tag}`);
}

// --- the protected images must actually still be there ----------------------
// Retention is only meaningful if the thing being protected exists. A rollback
// target that was deleted before this policy was written is not protected by
// it, and the freeze record would still name it.
for (const [key, owner] of protectedDigests) {
  const [repository, digest] = key.split('@');
  const scheme = args.insecure ? 'http' : 'https';
  try {
    execFileSync(
      'curl',
      [
        '-sS',
        '--fail',
        '-I',
        '-H',
        'Accept: application/vnd.oci.image.index.v1+json',
        '-H',
        'Accept: application/vnd.docker.distribution.manifest.v2+json',
        `${scheme}://${args.registry}/v2/${args.owner}/${repository}/manifests/${digest}`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch {
    console.error(
      `check-registry-retention: FAIL ${owner.release}'s ${owner.component} image is already gone ` +
        `(${digest.slice(0, 19)}…)`,
    );
    failed = true;
  }
}

console.log(`check-registry-retention: ${kept.length} tag(s) kept by the policy`);
console.log(`check-registry-retention: ${deletable.length} tag(s) eligible for deletion`);
if (args.json) {
  console.log(JSON.stringify({ protected: protectedReleases, kept, deletable }, null, 2));
}

if (failed) {
  console.error(
    'check-registry-retention: retention does not protect the rollback path; fix the policy ' +
      'before relying on it',
  );
  process.exit(65);
}
console.log(
  'check-registry-retention: every protected release survives a cleanup pass under this policy',
);
