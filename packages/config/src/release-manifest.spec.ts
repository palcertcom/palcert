import { execFileSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RELEASE = path.join(REPO, 'scripts', 'release');

const {
  COMPONENT_NAMES,
  RELEASE_MANIFEST_VERSION,
  findSecretShapedContent,
  imageReference,
  imageReferencesFromManifest,
  manifestDigest,
  releaseTag,
  releaseVersion,
  serializeManifest,
  validateManifest,
} = require(path.join(RELEASE, 'lib', 'release-manifest.cjs'));

const digest = (seed: string): string => `sha256:${seed.repeat(64).slice(0, 64)}`;

/**
 * The release artifact model (Phase 20 Checkpoint 5).
 *
 * Checkpoint 20.1 found no delivery path at all: images were built on every
 * push, tagged `:ci`, never pushed anywhere, and thrown away. "Rollback" named
 * a previous image that did not exist. These tests are about the property that
 * replaces that — a release is five digests and a commit, and every
 * environment resolves the same five.
 */
describe('release version and identity', () => {
  it('derives the version from the application version and the commit', () => {
    expect(releaseVersion('0.1.0', 'a'.repeat(40))).toBe('0.1.0+aaaaaaa');
    // Derived, not chosen: two people computing it for the same release get
    // the same answer, and a version cannot be reused for a different commit.
    expect(releaseVersion('0.1.0', 'a'.repeat(40))).toBe(releaseVersion('0.1.0', 'a'.repeat(40)));
    expect(releaseVersion('0.1.0', 'b'.repeat(40))).not.toBe(
      releaseVersion('0.1.0', 'a'.repeat(40)),
    );
  });

  it('refuses a short commit or a non-SemVer version', () => {
    expect(() => releaseVersion('0.1.0', 'abc1234')).toThrow(/40-character/);
    expect(() => releaseVersion('v0.1', 'a'.repeat(40))).toThrow(/x\.y\.z/);
  });

  it('spells the version as a tag a registry will accept', () => {
    // OCI tags may not contain `+`.
    expect(releaseTag('0.1.0+abc1234')).toBe('0.1.0-abc1234');
    expect(releaseTag('0.1.0+abc1234')).not.toContain('+');
  });

  it('addresses images by digest, never by tag', () => {
    const reference = imageReference('ghcr.io', 'acme', 'api', digest('a'));
    expect(reference).toBe(`ghcr.io/acme/palcert-api@${digest('a')}`);
    expect(reference).toContain('@sha256:');
    // The repository part carries no tag: everything after the last `/` is
    // `name@sha256:…`, never `name:something`.
    const last = reference.slice(reference.lastIndexOf('/') + 1);
    expect(last.split('@')[0]).not.toContain(':');
  });

  it('refuses anything that is not a sha256 digest', () => {
    expect(() => imageReference('ghcr.io', 'acme', 'api', 'latest')).toThrow(/valid image digest/);
    expect(() => imageReference('ghcr.io', 'acme', 'api', 'sha256:short')).toThrow();
  });
});

describe('release manifest', () => {
  const valid = (): Record<string, unknown> => ({
    manifestVersion: RELEASE_MANIFEST_VERSION,
    releaseVersion: '0.1.0+aaaaaaa',
    releaseTag: '0.1.0-aaaaaaa',
    applicationVersion: '0.1.0',
    commit: 'a'.repeat(40),
    builtAt: '2026-01-01T00:00:00.000Z',
    registry: 'ghcr.io',
    owner: 'acme',
    images: Object.fromEntries(
      COMPONENT_NAMES.map((name: string, index: number) => [
        name,
        {
          repository: `acme/palcert-${name}`,
          digest: digest(String(index)),
          tags: ['0.1.0-aaaaaaa'],
        },
      ]),
    ),
    migration: { count: 63, head: '20260925000000_x', checksum: 'd'.repeat(64) },
    schemaVersions: { reportSchema: 1 },
  });

  it('accepts a well-formed manifest', () => {
    expect(validateManifest(valid())).toEqual([]);
  });

  it('requires all five release images', () => {
    for (const component of COMPONENT_NAMES) {
      const manifest = valid() as { images: Record<string, unknown> };
      delete manifest.images[component];
      // A release missing an image is a release that cannot be deployed, and
      // discovering that during a promotion is too late.
      expect(validateManifest(manifest).join(' ')).toContain(`missing the ${component} image`);
    }
  });

  it('refuses a version that does not follow from its own commit', () => {
    const manifest = { ...valid(), releaseVersion: '9.9.9+deadbee' };
    // The identity is the digests; the version is a label. A label that does
    // not follow from the manifest's own fields was edited by hand.
    expect(validateManifest(manifest).join(' ')).toContain('does not follow from');
  });

  it('refuses a manifest version this build does not understand', () => {
    const manifest = { ...valid(), manifestVersion: 999 };
    expect(validateManifest(manifest).join(' ')).toContain('not supported by this build');
  });

  it('refuses a tag where a digest belongs', () => {
    const manifest = valid() as { images: Record<string, { digest: string }> };
    manifest.images['api']!.digest = 'latest';
    expect(validateManifest(manifest).join(' ')).toContain('no valid sha256 digest');
  });

  it('requires the migration state a release expects', () => {
    const manifest = valid() as Record<string, unknown>;
    delete manifest['migration'];
    expect(validateManifest(manifest).join(' ')).toContain('no required migration state');
  });

  it('serializes deterministically', () => {
    const first = serializeManifest({ b: 2, a: { z: 1, y: 2 } });
    const second = serializeManifest({ a: { y: 2, z: 1 }, b: 2 });
    // Determinism makes two manifests diffable and the manifest's own
    // checksum meaningful.
    expect(first).toBe(second);
  });

  it.each([
    ['a Stripe secret', '{"x":"sk_live_AAAAAAAABBBB"}'], // gitleaks:allow (planted; must be refused)
    ['a webhook secret', '{"x":"whsec_AAAAAAAABBBB"}'],
    ['a private key', '{"x":"-----BEGIN RSA PRIVATE KEY-----"}'],
    ['an AWS key id', '{"x":"AKIAIOSFODNN7EXAMPLE"}'],
    ['a credential-shaped field', '{"password":"x"}'],
    ['a database URL with a password', '{"x":"postgresql://u:p@h/db"}'],
  ])('detects %s in anything destined for a manifest', (_label, text) => {
    expect(findSecretShapedContent(text).length).toBeGreaterThan(0);
  });

  it('passes a real manifest', () => {
    expect(findSecretShapedContent(serializeManifest(valid()))).toEqual([]);
  });
});

/**
 * The tools, run as an operator runs them.
 *
 * Executed rather than imported: the failure being guarded against is a
 * command that exits 0 when it should not, and only running it proves that.
 */
// These tests start real Node processes while other workspaces run in CI.
// Allow process scheduling/startup time without relaxing pure manifest tests.
describe('release tooling', { timeout: 30_000 }, () => {
  let work: string;

  const run = (
    script: string,
    args: string[],
  ): { status: number; stdout: string; stderr: string } => {
    // stderr is captured whichever way the tool exits: these tools report
    // their reasoning there even when they allow what they were asked about,
    // and the refusal message is the thing most worth asserting.
    const stderrFile = path.join(work, `stderr-${Math.random().toString(36).slice(2)}.log`);
    const handle = openSync(stderrFile, 'w');
    let status = 0;
    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [path.join(RELEASE, script), ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', handle],
        timeout: 10_000,
      });
    } catch (error) {
      const details = error as { status?: number; stdout?: string };
      status = details.status ?? 1;
      stdout = details.stdout ?? '';
    } finally {
      closeSync(handle);
    }
    return { status, stdout, stderr: readFileSync(stderrFile, 'utf8') };
  };

  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();

  const makeManifest = (out: string, overrides: string[] = []): { status: number } =>
    run('make-manifest.mjs', [
      '--commit',
      commit,
      '--owner',
      'testowner',
      '--out',
      out,
      ...COMPONENT_NAMES.flatMap((name: string, index: number) => [
        '--digest',
        `${name}=${digest(String(index))}`,
      ]),
      ...overrides,
    ]);

  beforeAll(() => {
    work = mkdtempSync(path.join(tmpdir(), 'palcert-release-'));
  });
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('writes a manifest that verifies', () => {
    const out = path.join(work, 'manifest.json');
    expect(makeManifest(out).status).toBe(0);
    const verified = run('verify-manifest.mjs', ['--manifest', out, '--expect-commit', commit]);
    expect(verified.status).toBe(0);
    expect(verified.stdout).toContain('checks passed');
  });

  it('refuses to write a manifest with a missing image', () => {
    const result = run('make-manifest.mjs', [
      '--commit',
      commit,
      '--owner',
      'testowner',
      '--out',
      path.join(work, 'x.json'),
      '--digest',
      `api=${digest('a')}`,
    ]);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('no digest given for');
  });

  it('refuses a digest that is really a tag', () => {
    const result = run('make-manifest.mjs', [
      '--commit',
      commit,
      '--owner',
      'testowner',
      '--out',
      path.join(work, 'y.json'),
      ...COMPONENT_NAMES.flatMap((name: string) => ['--digest', `${name}=latest`]),
    ]);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('not a sha256 digest');
  });

  it('renders only digest-addressed references for a deployment', () => {
    const manifest = path.join(work, 'render.json');
    expect(makeManifest(manifest).status).toBe(0);
    const env = path.join(work, 'images.env');
    expect(run('render-deploy-env.mjs', ['--manifest', manifest, '--out', env]).status).toBe(0);

    const rendered = readFileSync(env, 'utf8');
    const references = rendered
      .split('\n')
      .filter((line) => line.endsWith('_IMAGE') || /_IMAGE=/.test(line))
      .map((line) => line.split('=')[1]!);
    expect(references).toHaveLength(COMPONENT_NAMES.length);
    for (const reference of references) {
      // The property the whole checkpoint rests on: a deployment cannot name
      // a mutable tag, so the bytes cannot change between environments.
      expect(reference).toContain('@sha256:');
      expect(reference).not.toMatch(/:(latest|main|rc)\b/);
    }
  });

  it('refuses to render from an invalid manifest', () => {
    const broken = path.join(work, 'broken.json');
    writeFileSync(broken, JSON.stringify({ manifestVersion: 1 }));
    const result = run('render-deploy-env.mjs', [
      '--manifest',
      broken,
      '--out',
      path.join(work, 'z.env'),
    ]);
    expect(result.status).toBe(65);
  });

  it('records a deployment without recording a secret', () => {
    const manifest = path.join(work, 'record.json');
    expect(makeManifest(manifest).status).toBe(0);
    const out = path.join(work, 'deployment.json');
    const result = run('record-deployment.mjs', [
      '--manifest',
      manifest,
      '--environment',
      'production',
      '--actor',
      'someone',
      '--outcome',
      'success',
      '--out',
      out,
    ]);
    expect(result.status).toBe(0);

    const record = JSON.parse(readFileSync(out, 'utf8'));
    // What an audit has to answer, months later, without repository archaeology.
    expect(record.environment).toBe('production');
    expect(record.commit).toBe(commit);
    expect(record.actor).toBe('someone');
    expect(Object.keys(record.images)).toEqual(expect.arrayContaining(COMPONENT_NAMES));
    expect(findSecretShapedContent(readFileSync(out, 'utf8'))).toEqual([]);
  });

  const manifestWith = (name: string, overrides: Record<string, unknown>): string => {
    const file = path.join(work, `${name}.json`);
    const source = path.join(work, `${name}-base.json`);
    expect(makeManifest(source).status).toBe(0);
    const doc = { ...JSON.parse(readFileSync(source, 'utf8')), ...overrides };
    writeFileSync(file, serializeManifest(doc));
    return file;
  };

  describe('manifest identity', () => {
    it('hashes a manifest by its canonical content', () => {
      const file = manifestWith('digest-a', {});
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      // Round-tripped through JSON and with its keys in a different order:
      // the digest is over canonical content, so neither may change it. This
      // is what lets a freeze record name a manifest and a later promotion
      // check it is the same file rather than one that merely shares a
      // version string.
      const reordered = Object.fromEntries(Object.entries(manifest).reverse());

      expect(manifestDigest(manifest)).toBe(manifestDigest(reordered));
      expect(manifestDigest(manifest)).toBe(manifestDigest(JSON.parse(JSON.stringify(manifest))));
      expect(manifestDigest(manifest)).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it('gives two manifests built at different times different digests', () => {
      // `builtAt` is part of the manifest, so two builds of the same commit
      // are two different artifacts and must be distinguishable. A digest
      // that ignored it would let one be substituted for the other.
      const left = JSON.parse(readFileSync(manifestWith('digest-b', {}), 'utf8'));
      const right = JSON.parse(readFileSync(manifestWith('digest-c', {}), 'utf8'));
      expect(left.commit).toBe(right.commit);
      expect(manifestDigest(left)).not.toBe(manifestDigest(right));
    });

    it('gives a different digest when any field changes', () => {
      const base = JSON.parse(readFileSync(manifestWith('digest-base', {}), 'utf8'));
      const altered = { ...base, commit: 'f'.repeat(40) };
      expect(manifestDigest(altered)).not.toBe(manifestDigest(base));
    });

    it('derives every image reference as a digest, never a tag', () => {
      const manifest = JSON.parse(readFileSync(manifestWith('refs', {}), 'utf8'));
      const references = imageReferencesFromManifest(manifest);
      expect(Object.keys(references)).toEqual(expect.arrayContaining(COMPONENT_NAMES));
      for (const reference of Object.values(references)) {
        expect(reference).toContain('@sha256:');
        // The repository part must carry no tag: `repo:tag@sha256:…` would
        // resolve by digest but record a tag that can later move.
        const repository = String(reference).split('@')[0];
        expect(repository.slice(repository.lastIndexOf('/'))).not.toContain(':');
      }
    });
  });

  describe('rollback safety', () => {
    it('allows an application-only rollback when the schema is unchanged', () => {
      const from = manifestWith('from-same', { releaseVersion: '0.1.0+bbbbbbb' });
      const to = manifestWith('to-same', { releaseVersion: '0.1.0+aaaaaaa' });
      const result = run('check-rollback-safety.mjs', ['--from', from, '--to', to]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('SAFE');
    });

    it('refuses when the current release applied migrations the target never saw', () => {
      const from = manifestWith('from-ahead', {
        releaseVersion: '0.1.0+ccccccc',
        migration: { count: 99, head: '29990101000000_future', checksum: 'f'.repeat(64) },
      });
      const to = manifestWith('to-behind', { releaseVersion: '0.1.0+aaaaaaa' });
      const result = run('check-rollback-safety.mjs', ['--from', from, '--to', to]);
      // Exit 3, distinct from a crash: a deployment workflow can tell
      // "refused pending a human decision" from "something broke".
      expect(result.status).toBe(3);
      expect(result.stderr).toContain('REFUSED');
      // And it never offers to generate a reverse migration.
      expect(result.stderr).not.toMatch(/down.?migration|reverse migration will/i);
      expect(result.stderr).toContain('forward-fix');
    });

    it('lets an operator override, deliberately and on the record', () => {
      const from = manifestWith('from-ovr', {
        releaseVersion: '0.1.0+ccccccc',
        migration: { count: 99, head: '29990101000000_future', checksum: 'f'.repeat(64) },
      });
      const to = manifestWith('to-ovr', { releaseVersion: '0.1.0+aaaaaaa' });
      const result = run('check-rollback-safety.mjs', [
        '--from',
        from,
        '--to',
        to,
        '--i-have-confirmed-schema-compatibility',
      ]);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('ALLOWED BY OPERATOR');
    });

    it('refuses a "rollback" that is really a roll forward', () => {
      const from = manifestWith('from-old', {
        releaseVersion: '0.1.0+aaaaaaa',
        migration: { count: 1, head: '20200101000000_first', checksum: 'a'.repeat(64) },
      });
      const to = manifestWith('to-new', { releaseVersion: '0.1.0+bbbbbbb' });
      const result = run('check-rollback-safety.mjs', ['--from', from, '--to', to]);
      expect(result.status).toBe(65);
      expect(result.stderr).toContain('this is not a rollback');
    });
  });
});
