import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const {
  validateManifest,
  serializeManifest,
  manifestDigest,
  imageReferencesFromManifest,
} = require('../lib/release-manifest.cjs');

export function prepare({ manifest, freeze, staging, authorization, sha, runId, attempt }) {
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error(`Invalid manifest: ${errors.join('; ')}`);
  if (
    manifest.commit !== sha ||
    authorization.commit !== sha ||
    freeze.commit !== sha ||
    authorization.repository !== 'palcertcom/palcert'
  )
    throw new Error('Commit/repository mismatch');
  if (manifest.registry !== 'ghcr.io') throw new Error('Unexpected registry');
  const references = imageReferencesFromManifest(manifest);
  const names = {
    api: 'api',
    worker: 'worker',
    migrate: 'migrate',
    web: 'web',
    documentEngine: 'document-engine',
  };
  for (const [component, name] of Object.entries(names)) {
    if (
      manifest.images[component].repository !== `palcertcom/palcert-${name}` ||
      freeze.images?.[component]?.reference !== references[component] ||
      freeze.images[component].digest !== manifest.images[component].digest ||
      staging.images?.[component] !== references[component]
    )
      throw new Error(`Image mismatch: ${component}`);
  }
  const digest = manifestDigest(manifest);
  const workflowRun = `https://github.com/palcertcom/palcert/actions/runs/${runId}`;
  if (
    freeze.manifest?.digest !== digest ||
    staging.manifestDigest !== digest ||
    staging.environment !== 'staging' ||
    staging.outcome !== 'success' ||
    staging.commit !== sha ||
    staging.workflowRun !== workflowRun ||
    staging.releaseVersion !== manifest.releaseVersion ||
    freeze.releaseVersion !== manifest.releaseVersion
  ) {
    throw new Error('This run did not stage this exact release successfully');
  }
  return {
    version: 1,
    repository: authorization.repository,
    commit: sha,
    runId,
    attempt,
    issuedAt: new Date().toISOString(),
    authorization,
    manifestText: serializeManifest(manifest),
    freeze,
    staging,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  try {
    const request = prepare({
      manifest: read('release-manifest.json'),
      freeze: read('release-freeze.json'),
      staging: read('staging-deployment.json'),
      authorization: read('merge-authorization.json'),
      sha: process.env.GITHUB_SHA,
      runId: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
    });
    writeFileSync('deployment-request.json', `${JSON.stringify(request)}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
