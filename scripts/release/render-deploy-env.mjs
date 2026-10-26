#!/usr/bin/env node
/**
 * Turn a release manifest into the image variables a deployment reads
 * (Phase 20 Checkpoint 5).
 *
 *   node scripts/release/render-deploy-env.mjs --manifest release-manifest.json --out images.env
 *
 * Every reference it emits is `repository@sha256:…`. That is the whole job,
 * and the reason it is a script rather than a line of shell: a tag here would
 * mean the artifact could change between staging accepting it and production
 * deploying it, and the change would be invisible — same file, same command,
 * different bytes.
 *
 * Refuses to emit anything if the manifest does not validate, so a malformed
 * release cannot reach a `docker compose up`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { COMPONENT_NAMES, DIGEST_PATTERN, validateManifest } = require('./lib/release-manifest.cjs');

/** Manifest component -> the variable the release topology reads. */
const ENVIRONMENT_VARIABLE = {
  api: 'API_IMAGE',
  worker: 'WORKER_IMAGE',
  migrate: 'MIGRATE_IMAGE',
  web: 'WEB_IMAGE',
  documentEngine: 'ENGINE_IMAGE',
};

function parseArgs(argv) {
  const args = { manifest: null, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--manifest') args.manifest = argv[(index += 1)];
    else if (argv[index] === '--out') args.out = argv[(index += 1)];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.manifest === null || args.out === null) {
  console.error('render-deploy-env: --manifest and --out are required');
  process.exit(64);
}

const manifest = JSON.parse(readFileSync(args.manifest, 'utf8'));
const problems = validateManifest(manifest);
if (problems.length > 0) {
  for (const problem of problems) console.error(`render-deploy-env:   ${problem}`);
  console.error('render-deploy-env: refusing to render from an invalid manifest');
  process.exit(65);
}

const lines = [
  '# Generated from the release manifest. Do not edit.',
  `# Release ${manifest.releaseVersion} (commit ${manifest.commit}).`,
  '#',
  '# Every reference below is a digest. A tag would let the bytes change',
  '# between the environment that accepted this release and the one deploying',
  '# it, and nothing here would look different.',
  `RELEASE_VERSION=${manifest.releaseVersion}`,
  `RELEASE_COMMIT=${manifest.commit}`,
];

for (const component of COMPONENT_NAMES) {
  const image = manifest.images[component];
  if (!DIGEST_PATTERN.test(image.digest)) {
    console.error(`render-deploy-env: ${component} has no digest`);
    process.exit(65);
  }
  lines.push(
    `${ENVIRONMENT_VARIABLE[component]}=${manifest.registry}/${image.repository}@${image.digest}`,
  );
}

writeFileSync(args.out, `${lines.join('\n')}\n`);
console.log(
  `render-deploy-env: ${COMPONENT_NAMES.length} digest-addressed image(s) -> ${args.out}`,
);
