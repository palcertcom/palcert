import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { authorize } from './authorize.mjs';
import { prepare } from './request.mjs';
const require = createRequire(import.meta.url);
const { manifestDigest, imageReferencesFromManifest } = require('../lib/release-manifest.cjs');

function authority() {
  const sha = 'a'.repeat(40);
  return {
    repository: 'palcertcom/palcert',
    sha,
    ref: 'refs/heads/main',
    event: 'push',
    main: { sha },
    pulls: [
      {
        number: 4,
        merged_at: '2026-10-27T00:00:00Z',
        merge_commit_sha: sha,
        base: { ref: 'main', repo: { full_name: 'palcertcom/palcert' } },
        merged_by: { login: 'palcertcom' },
      },
    ],
  };
}

test('accepts the exact current main merge and records its actual merger', () => {
  assert.equal(authorize(authority()).mergedBy, 'palcertcom');
});
for (const [name, mutate] of Object.entries({
  'stale main': (a) => {
    a.main.sha = 'b'.repeat(40);
  },
  'PR execution': (a) => {
    a.event = 'pull_request';
  },
  'feature branch': (a) => {
    a.ref = 'refs/heads/feature';
  },
  'foreign repository': (a) => {
    a.repository = 'attacker/palcert';
  },
  'direct push': (a) => {
    a.pulls = [];
  },
  'unmerged PR': (a) => {
    a.pulls[0].merged_at = null;
  },
  'wrong merge': (a) => {
    a.pulls[0].merge_commit_sha = 'b'.repeat(40);
  },
  'missing human identity': (a) => {
    delete a.pulls[0].merged_by;
  },
  'ambiguous PRs': (a) => {
    a.pulls.push(a.pulls[0]);
  },
})) {
  test(`refuses ${name}`, () => {
    const a = authority();
    mutate(a);
    assert.throws(() => authorize(a));
  });
}

function fixture() {
  const authorization = authorize(authority());
  const sha = authorization.commit;
  const names = {
    api: 'api',
    worker: 'worker',
    migrate: 'migrate',
    web: 'web',
    documentEngine: 'document-engine',
  };
  const manifest = {
    manifestVersion: 1,
    applicationVersion: '0.1.0',
    releaseVersion: `0.1.0+${sha.slice(0, 7)}`,
    commit: sha,
    builtAt: '2026-10-27T00:00:00Z',
    registry: 'ghcr.io',
    owner: 'palcertcom',
    images: Object.fromEntries(
      Object.entries(names).map(([k, v], i) => [
        k,
        {
          repository: `palcertcom/palcert-${v}`,
          digest: `sha256:${String(i).repeat(64)}`,
          tags: ['tested'],
        },
      ]),
    ),
    migration: {
      count: 84,
      head: '20261025000000_financial_service_reports',
      checksum: 'd'.repeat(64),
    },
  };
  const images = imageReferencesFromManifest(manifest);
  const digest = manifestDigest(manifest);
  return {
    sha,
    runId: '123',
    attempt: '1',
    authorization,
    manifest,
    freeze: {
      commit: sha,
      releaseVersion: manifest.releaseVersion,
      manifest: { digest },
      images: Object.fromEntries(
        Object.entries(images).map(([k, reference]) => [
          k,
          { reference, digest: manifest.images[k].digest },
        ]),
      ),
    },
    staging: {
      commit: sha,
      releaseVersion: manifest.releaseVersion,
      environment: 'staging',
      outcome: 'success',
      manifestDigest: digest,
      images,
      workflowRun: 'https://github.com/palcertcom/palcert/actions/runs/123',
    },
  };
}
test('packs the tested manifest and all five immutable images', () => {
  assert.equal(JSON.parse(prepare(fixture()).manifestText).migration.count, 84);
});
for (const [name, mutate] of Object.entries({
  'failed staging': (f) => {
    f.staging.outcome = 'failure';
  },
  'other run': (f) => {
    f.runId = '124';
  },
  'changed manifest': (f) => {
    f.manifest.builtAt = 'different';
  },
  'missing component': (f) => {
    delete f.manifest.images.worker;
  },
  'tag replacing digest': (f) => {
    f.manifest.images.api.digest = 'latest';
  },
  'wrong image in staging': (f) => {
    f.staging.images.web = f.staging.images.api;
  },
  'wrong frozen digest': (f) => {
    f.freeze.images.api.digest = 'sha256:' + 'f'.repeat(64);
  },
  'foreign image': (f) => {
    f.manifest.images.api.repository = 'attacker/palcert-api';
  },
})) {
  test(`request refuses ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => prepare(f));
  });
}
