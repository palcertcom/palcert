#!/usr/bin/env node
/**
 * Prove that what is about to run, or is running, is the frozen release set
 * (Phase 20 Checkpoint 5).
 *
 *   node scripts/release/assert-frozen-images.mjs --freeze release-freeze.json --images-env images.env
 *   node scripts/release/assert-frozen-images.mjs --freeze release-freeze.json --running
 *
 * Two questions, one answer each:
 *
 *   --images-env  does the rendered deployment configuration name exactly the
 *                 frozen digests? Run before deploying. This is what refuses a
 *                 tag-derived image substituted for a digest-pinned one.
 *
 *   --running     were the containers that exist created from exactly those
 *                 digests? Run after deploying. This is the no-rebuild proof:
 *                 build digest == deployed digest, for all five images.
 *
 * A matching tag is not evidence and is treated as a failure. `:v1.2.3` can be
 * moved to different bytes at any time by anyone who can push; that is the
 * entire reason the release model is digest-addressed, and accepting a tag
 * here would quietly undo it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { COMPONENT_NAMES, DIGEST_PATTERN } = require('./lib/release-manifest.cjs');

/** Manifest component -> the variable the release topology reads. */
const ENVIRONMENT_VARIABLE = {
  api: 'API_IMAGE',
  worker: 'WORKER_IMAGE',
  migrate: 'MIGRATE_IMAGE',
  web: 'WEB_IMAGE',
  documentEngine: 'ENGINE_IMAGE',
};

/**
 * Component -> compose service. `migrate` is absent on purpose: it is a
 * one-shot job that has exited by the time anything asks what is running, so
 * "no container" is its correct state rather than a failure.
 */
const RUNNING_SERVICE = {
  api: 'api',
  worker: 'worker',
  web: 'web',
  documentEngine: 'document-engine',
};

function parseArgs(argv) {
  const args = { freeze: null, imagesEnv: null, running: false, project: 'palcert-release' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--freeze') args.freeze = argv[(index += 1)];
    else if (arg === '--images-env') args.imagesEnv = argv[(index += 1)];
    else if (arg === '--project') args.project = argv[(index += 1)];
    else if (arg === '--running') args.running = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.freeze === null) {
  console.error('assert-frozen-images: --freeze <release-freeze.json> is required');
  process.exit(64);
}
if (args.imagesEnv === null && !args.running) {
  console.error('assert-frozen-images: one of --images-env or --running is required');
  process.exit(64);
}

const freeze = JSON.parse(readFileSync(args.freeze, 'utf8'));

let failed = false;
function check(name, ok, detail) {
  if (!ok) failed = true;
  console.log(`assert-frozen-images: ${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
}

console.log(
  `assert-frozen-images: release ${freeze.releaseVersion} (${String(freeze.commit).slice(0, 12)})`,
);

// --- the rendered deployment configuration ---------------------------------
if (args.imagesEnv !== null) {
  const variables = new Map();
  for (const line of readFileSync(args.imagesEnv, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const split = trimmed.indexOf('=');
    if (split === -1) continue;
    variables.set(trimmed.slice(0, split), trimmed.slice(split + 1));
  }

  for (const component of COMPONENT_NAMES) {
    const variable = ENVIRONMENT_VARIABLE[component];
    const actual = variables.get(variable);
    const expected = freeze.images[component].reference;

    if (actual === undefined) {
      check(`${variable} is set`, false, 'absent from the rendered configuration');
      continue;
    }
    // Checked before equality so the failure names the real problem. A
    // reference with no `@sha256:` is a tag, and a tag is not an artifact.
    const digestPart = actual.includes('@') ? actual.slice(actual.indexOf('@') + 1) : null;
    if (digestPart === null || !DIGEST_PATTERN.test(digestPart)) {
      check(
        `${variable} is digest-addressed`,
        false,
        `not a digest reference: ${actual.slice(0, 80)}`,
      );
      continue;
    }
    check(
      `${variable} is the frozen image`,
      actual === expected,
      actual === expected
        ? `${digestPart.slice(0, 19)}…`
        : `configured ${digestPart.slice(0, 19)}…, frozen ${freeze.images[component].digest.slice(0, 19)}…`,
    );
  }

  // The release version travels with the images, so a record of this
  // deployment names the release it actually deployed.
  check(
    'RELEASE_VERSION matches the freeze',
    variables.get('RELEASE_VERSION') === freeze.releaseVersion,
    `${variables.get('RELEASE_VERSION')} vs ${freeze.releaseVersion}`,
  );
  check(
    'RELEASE_COMMIT matches the freeze',
    variables.get('RELEASE_COMMIT') === freeze.commit,
    `${String(variables.get('RELEASE_COMMIT')).slice(0, 12)} vs ${String(freeze.commit).slice(0, 12)}`,
  );
}

// --- the containers that actually exist ------------------------------------
if (args.running) {
  for (const [component, service] of Object.entries(RUNNING_SERVICE)) {
    const container = `${args.project}-${service}-1`;
    let created;
    try {
      // `.Image` on the container is the image ID it was created from, and
      // `.Config.Image` is the reference it was asked for. The reference is
      // what carries the digest, and it is recorded at creation time, so it
      // cannot be changed afterwards by moving a tag.
      created = execFileSync('docker', ['inspect', container, '--format', '{{.Config.Image}}'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      check(`${service} is running the frozen image`, false, `container ${container} not found`);
      continue;
    }

    const digest = freeze.images[component].digest;
    const isDigestReference = created.includes('@sha256:');
    if (!isDigestReference) {
      check(
        `${service} was created from a digest`,
        false,
        `created from a tag: ${created.slice(0, 80)}`,
      );
      continue;
    }
    check(
      `${service} is running the frozen image`,
      created.endsWith(`@${digest}`),
      created.endsWith(`@${digest}`)
        ? `${digest.slice(0, 19)}…`
        : `running ${created.slice(0, 80)}`,
    );
  }
}

if (failed) {
  console.error('assert-frozen-images: this is not the frozen release set');
  process.exit(65);
}
console.log('assert-frozen-images: every image is exactly the frozen digest — nothing was rebuilt');
