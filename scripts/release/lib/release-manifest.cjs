/**
 * The PalCert release manifest: what a release *is*, as data.
 *
 * A release is five images built from one commit, each identified by the only
 * thing that cannot be re-pointed at different bytes -- its OCI digest. Tags
 * are labels for humans and can be moved; a digest is the content. Everything
 * downstream of a build (staging, production, rollback, redeploy after a
 * disaster) resolves images from this file, so nothing after the build ever
 * has to decide what to deploy.
 *
 * CommonJS so the operator tooling and the Jest suite share one implementation
 * rather than two that drift apart, exactly as the backup format does.
 */
const { createHash } = require('node:crypto');

/**
 * The manifest layout this build writes and understands.
 *
 * A manifest is read by whatever version of PalCert is promoting, rolling back
 * or recovering -- which is not necessarily the version that wrote it. A
 * layout this reader does not know is refused by name rather than parsed
 * optimistically.
 */
const RELEASE_MANIFEST_VERSION = 1;
const SUPPORTED_MANIFEST_VERSIONS = Object.freeze([1]);

/**
 * The five images that constitute a release.
 *
 * Frozen here rather than discovered, because "we forgot to publish one" must
 * be a failing test and not a surprise during a promotion. The keys are the
 * manifest's field names; the values are the repository suffix in the registry.
 */
const RELEASE_COMPONENTS = Object.freeze({
  api: 'palcert-api',
  worker: 'palcert-worker',
  migrate: 'palcert-migrate',
  web: 'palcert-web',
  documentEngine: 'palcert-document-engine',
});

const COMPONENT_NAMES = Object.freeze(Object.keys(RELEASE_COMPONENTS));

/** `sha256:` followed by 64 lowercase hex characters, and nothing else. */
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/**
 * The release version for a commit.
 *
 * SemVer with the commit's short hash as build metadata: derived entirely from
 * inputs that are already fixed, so two people computing it for the same
 * release get the same answer, and a version can never be silently reused for
 * a different commit.
 *
 * It is a *label*. The identity of a release is its digests -- see
 * `assertNoDigestCollision`.
 */
function releaseVersion(applicationVersion, commit) {
  if (!/^\d+\.\d+\.\d+$/.test(applicationVersion)) {
    throw new Error(`Application version must be x.y.z, got ${applicationVersion}`);
  }
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error(`Commit must be a full 40-character SHA, got ${commit}`);
  }
  return `${applicationVersion}+${commit.slice(0, 7)}`;
}

/**
 * The same release, spelled so an OCI registry will accept it as a tag.
 *
 * Tags may not contain `+`, so the build-metadata separator becomes `-`. Kept
 * as one function so the two spellings cannot drift.
 */
function releaseTag(version) {
  return version.replace('+', '-');
}

/** The immutable reference an environment actually deploys. */
function imageReference(registry, owner, component, digest) {
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error(`Not a valid image digest: ${digest}`);
  }
  const repository = RELEASE_COMPONENTS[component];
  if (repository === undefined) throw new Error(`Unknown release component: ${component}`);
  return `${registry}/${owner}/${repository}@${digest}`;
}

/**
 * Serialize with sorted keys, so the same release produces the same bytes.
 *
 * Determinism is what lets two manifests be diffed, and what makes the
 * manifest's own checksum mean something. `builtAt` is the one field that
 * cannot be deterministic, and it is recorded rather than hidden.
 */
function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, sortedReplacer, 2)}\n`;
}

function sortedReplacer(_key, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Everything that must be true before a manifest may be deployed from.
 *
 * Returns every problem rather than the first, because an operator deciding
 * whether to promote wants to know everything wrong with a candidate.
 */
function validateManifest(manifest) {
  const problems = [];
  const fail = (message) => problems.push(message);

  if (manifest === null || typeof manifest !== 'object') return ['Manifest is not an object'];

  if (!Number.isInteger(manifest.manifestVersion)) {
    fail('Manifest has no integer manifestVersion');
  } else if (!SUPPORTED_MANIFEST_VERSIONS.includes(manifest.manifestVersion)) {
    fail(
      `Release manifest version ${manifest.manifestVersion} is not supported by this build ` +
        `(understands ${SUPPORTED_MANIFEST_VERSIONS.join(', ')})`,
    );
  }

  if (typeof manifest.commit !== 'string' || !COMMIT_PATTERN.test(manifest.commit)) {
    fail('Manifest commit is not a full 40-character SHA');
  }
  if (typeof manifest.releaseVersion !== 'string' || manifest.releaseVersion.length === 0) {
    fail('Manifest has no releaseVersion');
  } else if (
    typeof manifest.applicationVersion === 'string' &&
    typeof manifest.commit === 'string' &&
    COMMIT_PATTERN.test(manifest.commit) &&
    manifest.releaseVersion !== releaseVersion(manifest.applicationVersion, manifest.commit)
  ) {
    // The version is derived, so a manifest whose version does not follow from
    // its own commit was edited by hand or assembled wrongly.
    fail('Manifest releaseVersion does not follow from its applicationVersion and commit');
  }
  for (const field of ['registry', 'owner', 'builtAt']) {
    if (typeof manifest[field] !== 'string' || manifest[field].length === 0) {
      fail(`Manifest field ${field} is missing`);
    }
  }

  const images = manifest.images;
  if (images === null || typeof images !== 'object') {
    fail('Manifest has no images');
  } else {
    for (const component of COMPONENT_NAMES) {
      const image = images[component];
      if (image === null || typeof image !== 'object') {
        fail(`Manifest is missing the ${component} image`);
        continue;
      }
      if (!DIGEST_PATTERN.test(String(image.digest))) {
        fail(`Image ${component} has no valid sha256 digest`);
      }
      if (typeof image.repository !== 'string' || image.repository.length === 0) {
        fail(`Image ${component} has no repository`);
      }
      if (!Array.isArray(image.tags) || image.tags.length === 0) {
        fail(`Image ${component} records no tags`);
      }
    }
    const unknown = Object.keys(images).filter((name) => !COMPONENT_NAMES.includes(name));
    if (unknown.length > 0) fail(`Manifest has unknown image(s): ${unknown.join(', ')}`);
  }

  const migration = manifest.migration;
  if (migration === null || typeof migration !== 'object') {
    fail('Manifest records no required migration state');
  } else {
    if (!Number.isInteger(migration.count) || migration.count <= 0) {
      fail('Manifest migration count is missing or not positive');
    }
    if (typeof migration.head !== 'string' || migration.head.length === 0) {
      fail('Manifest records no head migration');
    }
    if (!/^[0-9a-f]{64}$/.test(String(migration.checksum))) {
      fail('Manifest migration checksum is missing or malformed');
    }
  }

  return problems;
}

/**
 * Anything that looks like a credential has no business in a file that is
 * committed, attached to a release and read during an incident.
 *
 * Deliberately a shape check over the serialized manifest rather than a field
 * allow-list: the failure being guarded against is somebody adding a field,
 * and an allow-list only catches the fields somebody already thought of.
 */
/**
 * The release manifest's own content hash.
 *
 * Computed over the canonical serialization, so the same release produces the
 * same digest wherever it is written. This is what lets a manifest be named
 * in a freeze record, an audit record or a runbook and later checked to be the
 * same file, byte for byte, rather than merely a file with the same version
 * string in it.
 */
function manifestDigest(manifest) {
  return `sha256:${sha256Hex(serializeManifest(manifest))}`;
}

/**
 * The five digest-pinned image references a manifest names, by component.
 *
 * One place derives them, so the deployment renderer, the no-rebuild proof and
 * the audit record cannot disagree about what "the release's images" means.
 */
function imageReferencesFromManifest(manifest) {
  return Object.fromEntries(
    COMPONENT_NAMES.map((component) => [
      component,
      `${manifest.registry}/${manifest.images[component].repository}@${manifest.images[component].digest}`,
    ]),
  );
}

const SECRET_SHAPED = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bsk_(live|test)_[A-Za-z0-9]{8,}/, 'a Stripe secret key'],
  [/\bwhsec_[A-Za-z0-9]{8,}/, 'a Stripe webhook secret'],
  [/\bghp_[A-Za-z0-9]{20,}/, 'a GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/"(password|secret|token|apiKey|privateKey)"\s*:/i, 'a credential-shaped field'],
  [
    /\b[A-Z0-9_]*(PASSWORD|SECRET_KEY|ENCRYPTION_KEYS|ACCESS_KEY)[A-Z0-9_]*\s*=/,
    'an inlined secret',
  ],
  [/postgres(ql)?:\/\/[^:\s"]+:[^@\s"]+@/, 'a database URL with a password'],
];

function findSecretShapedContent(serialized) {
  return SECRET_SHAPED.filter(([pattern]) => pattern.test(serialized)).map(([, label]) => label);
}

module.exports = {
  RELEASE_MANIFEST_VERSION,
  SUPPORTED_MANIFEST_VERSIONS,
  RELEASE_COMPONENTS,
  COMPONENT_NAMES,
  DIGEST_PATTERN,
  COMMIT_PATTERN,
  releaseVersion,
  releaseTag,
  imageReference,
  serializeManifest,
  sha256Hex,
  validateManifest,
  findSecretShapedContent,
  manifestDigest,
  imageReferencesFromManifest,
};
