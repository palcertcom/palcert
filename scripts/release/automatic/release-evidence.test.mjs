import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { COMPONENT_NAMES } = require('../lib/release-manifest.cjs');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const digest = (index) => `sha256:${String(index + 1).repeat(64)}`;
const steps = {
  api: 'api',
  worker: 'worker',
  migrate: 'migrate',
  web: 'web',
  engine: 'documentEngine',
};

function workflowReferences() {
  const workflow = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  const block = workflow.match(
    /- name: Generate an SBOM for every shipped image\n([\s\S]*?)(?=\n {6}- name:)/,
  );
  assert.ok(block, 'the real Release SBOM step must exist');
  const refs = block[1].split('IMAGE_REFS: |')[1];
  assert.ok(refs, 'the SBOM step must supply image references');
  const resolved = refs
    .trim()
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replaceAll('${{ env.REGISTRY }}', 'ghcr.io')
        .replaceAll('${{ steps.ns.outputs.owner }}', 'palcertcom')
        .replace(/\$\{\{ steps\.(\w+)\.outputs\.digest \}\}/g, (_, step) => {
          assert.ok(steps[step], `unknown build step: ${step}`);
          return digest(COMPONENT_NAMES.indexOf(steps[step]));
        }),
    )
    .join('\n');
  assert.ok(!resolved.includes('${{'), 'all workflow image expressions must be resolved');
  return resolved;
}

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'palcert-release-evidence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  mkdirSync(bin);
  // Only the external scanner is replaced. The real shell generator, manifest
  // writer and freeze CLI must agree on all five workflow-provided components.
  writeFileSync(
    path.join(bin, 'syft'),
    `#!/usr/bin/env python3
import json, sys
assert sys.argv[1] == 'scan'
output = next(value.split('=', 1)[1] for value in sys.argv if value.startswith('spdx-json='))
with open(output, 'w') as stream:
    json.dump({'spdxVersion': 'SPDX-2.3', 'name': sys.argv[2],
               'packages': [{'name': 'fixture-package-' + str(i)} for i in range(12)]}, stream)
`,
    { mode: 0o755 },
  );
  const manifest = path.join(directory, 'release-manifest.json');
  const sbom = path.join(directory, 'sbom');
  const out = path.join(directory, 'release-freeze.json');
  const run = (command, args, env = {}) =>
    spawnSync(command, args, {
      cwd: root,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...env },
      encoding: 'utf8',
      timeout: 30_000,
    });
  const made = run(process.execPath, [
    'scripts/release/make-manifest.mjs',
    '--commit',
    'a'.repeat(40),
    '--owner',
    'palcertcom',
    '--out',
    manifest,
    ...COMPONENT_NAMES.flatMap((name, i) => ['--digest', `${name}=${digest(i)}`]),
  ]);
  assert.equal(made.status, 0, made.stderr);
  const generated = run('bash', ['scripts/release/generate-sboms.sh'], {
    IMAGE_REFS: workflowReferences(),
    SBOM_DIR: sbom,
  });
  assert.equal(generated.status, 0, generated.stderr);
  const freeze = () =>
    run(process.execPath, [
      'scripts/release/freeze-release.mjs',
      '--manifest',
      manifest,
      '--out',
      out,
      '--sbom-dir',
      sbom,
    ]);
  return { sbom, out, freeze };
}

test('freezes all five SBOMs generated from the actual Release workflow inputs', (t) => {
  const f = fixture(t);
  const result = f.freeze();
  assert.equal(result.status, 0, result.stderr);
  const frozen = JSON.parse(readFileSync(f.out, 'utf8'));
  assert.deepEqual(Object.keys(frozen.supplyChain.sbom).sort(), [...COMPONENT_NAMES].sort());
  for (const component of COMPONENT_NAMES) {
    const evidence = frozen.supplyChain.sbom[component];
    const bytes = readFileSync(path.join(f.sbom, evidence.file));
    assert.equal(evidence.file, `palcert-${component}.spdx.json`);
    assert.equal(JSON.parse(bytes).name, frozen.images[component].reference);
    assert.equal(evidence.packages, 12);
    assert.equal(evidence.digest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  }
});

for (const component of COMPONENT_NAMES) {
  test(`refuses to freeze when the ${component} SBOM is missing`, (t) => {
    const f = fixture(t);
    rmSync(path.join(f.sbom, `palcert-${component}.spdx.json`));
    const result = f.freeze();
    assert.equal(result.status, 65);
    assert.ok(result.stderr.includes(`no SBOM for: ${component}`));
    assert.equal(existsSync(f.out), false);
  });
}

test('an engine alias cannot substitute for the documentEngine SBOM', (t) => {
  const f = fixture(t);
  renameSync(
    path.join(f.sbom, 'palcert-documentEngine.spdx.json'),
    path.join(f.sbom, 'palcert-engine.spdx.json'),
  );
  const result = f.freeze();
  assert.equal(result.status, 65);
  assert.ok(result.stderr.includes('no SBOM for: documentEngine'));
  assert.equal(existsSync(f.out), false);
});
