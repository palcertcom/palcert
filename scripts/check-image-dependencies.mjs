#!/usr/bin/env node
/**
 * Runtime-dependency gate for the production images (Phase 20 Checkpoint 2).
 *
 * Checkpoint 20.1 found the web image copying the whole monorepo
 * `node_modules`, so vitest, testing-library, eslint and the Prisma CLI all
 * shipped inside the public web image. The packaging is fixed; this is what
 * stops it drifting back, because the failure mode is silent — an image that
 * ships too much still starts, still serves traffic, and still passes every
 * functional test.
 *
 * It answers two questions per image and reports both:
 *   1. is any known development-only package present in the final image?
 *   2. what does the image actually carry at the top level?
 *
 * It also answers a third question, of every image including the Python
 * document engine: does this image still carry a package manager? Checkpoint
 * 20.5 removed them, and that has to stay true.
 *
 * The development-only package check is meaningful only for Node images. The
 * document engine carries no `node_modules`; its declared dependencies are
 * audited by `pip-audit`, which reads installed distributions rather than a
 * directory listing.
 *
 * Run: node scripts/check-image-dependencies.mjs <image>[ <image>...]
 */
import { execFileSync } from 'node:child_process';

/**
 * Packages that must never reach a runtime image.
 *
 * Each one is a test runner, a linter or a schema-mutating CLI. The Prisma CLI
 * is on the list deliberately: the migration image is the only place it
 * belongs, because a CLI that can rewrite the schema has no business sitting
 * inside every API replica.
 */
const FORBIDDEN = [
  'vitest',
  '@vitest',
  'jest',
  'ts-jest',
  '@testing-library',
  'eslint',
  'prettier',
  'supertest',
  'typescript',
  '@nestjs/cli',
  'prisma',
  // Browser automation and accessibility scanning (Phase 20 Checkpoint 8).
  //
  // The release QA harness added `playwright` and `axe-core` as root
  // devDependencies, and this list — which names what it already knows about
  // and nothing else — let them through. They reached the migration image,
  // the one container with schema authority, and the supply-chain scan found
  // them there before this gate did: CVE-2025-59288, HIGH, fixed upstream. A
  // library that drives browsers has no business in any runtime image, and
  // least of all that one.
  'playwright',
  'playwright-core',
  'axe-core',
];

/** The migration image is the one place the Prisma CLI is required. */
const ALLOWED_BY_IMAGE = new Map([['migrate', new Set(['prisma', 'typescript'])]]);

/**
 * The component an image reference names, independent of where it is stored.
 *
 * The same image is referred to three ways: `palcert/migrate:ci` locally,
 * `ghcr.io/owner/palcert-migrate@sha256:…` from the registry, and
 * `127.0.0.1:5001/owner/palcert-migrate@sha256:…` in a rehearsal. This keys
 * the exemption on the component, so the migration image is recognised as the
 * migration image in all three.
 *
 * The previous `image.split(':')[0]` worked only for the local form. On a
 * digest reference it produced `ghcr.io/owner/palcert-migrate@sha256`, which
 * matched nothing — so the migration image would have been failed for carrying
 * the very CLI it exists to run. Nothing noticed, because the one workflow
 * that used digest references was passing no images at all.
 */
function componentOf(reference) {
  const withoutDigest = reference.split('@')[0];
  const lastSegment = withoutDigest.slice(withoutDigest.lastIndexOf('/') + 1);
  const withoutTag = lastSegment.split(':')[0];
  return withoutTag.replace(/^palcert[-/]/, '');
}

/**
 * Every package directory inside every `node_modules` in the image.
 *
 * Written without `find -exec` on purpose: the images are Alpine, busybox
 * `find` is fussy about `-exec` quoting, and a mis-quoted command here exits 0
 * and reports nothing — which reads as a pass. A gate that cannot fail is
 * worse than no gate, so `listPackages` throws when it finds no packages at
 * all rather than reporting a clean image.
 */
function listPackages(image) {
  // Scoped to the application trees, not `/`.
  //
  // This asks what PalCert's own build put in the image. The base image's
  // bundled npm used to be excluded here because flagging it would have made
  // the gate unpassable — npm vendors a directory literally named `typescript`
  // in a socks example — and a gate nobody can pass gets disabled. That
  // premise is gone: Checkpoint 20.5 removes npm from the runtime stages
  // outright, and `presentToolchainPaths` below now asserts its absence directly,
  // which is a cleaner question than pattern-matching its vendored tree.
  const script = [
    // Proves the probe ran. An image with no `node_modules` at all — the
    // Python engine — is a legitimate empty result; a command that never
    // executed is not, and without this marker they look identical.
    'echo __probe_ok__',
    'for d in $(find /app /srv -type d -name node_modules 2>/dev/null); do',
    '  for e in "$d"/*; do',
    '    case "$e" in',
    '      */@*) for f in "$e"/*; do [ -d "$f" ] && echo "$f"; done ;;',
    // `[ -d ]` follows symlinks, so a link left pointing at a directory that
    // was pruned fails it. That matters: pnpm leaves dangling links behind in
    // `.pnpm/node_modules`, and counting those would report packages the image
    // does not actually contain.
    '      *) [ -d "$e" ] && echo "$e" ;;',
    '    esac',
    '  done',
    'done',
    // The last `[ -d ] && echo` sets a non-zero exit status when it is false,
    // which would make this look like a failed command.
    'true',
  ].join('\n');

  const output = execFileSync(
    'docker',
    ['run', '--rm', '--entrypoint', 'sh', image, '-c', script],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  );

  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.includes('__probe_ok__')) {
    throw new Error(
      `${image}: the package inspection did not run. Treat this as a failure, ` +
        'not as a clean image.',
    );
  }

  const names = new Set();
  for (const path of lines) {
    // `node_modules/@palcert/database/prisma` is that package's schema
    // directory, not a package called `prisma`. Only the segment immediately
    // after a `node_modules/` (plus one more for a scope) names a package.
    const match = /node_modules\/(@[^/*]+\/[^/*]+|[^@/*][^/*]*)$/.exec(path);
    if (match) names.add(match[1]);
  }

  return names;
}

/**
 * Build tooling that must not exist in any runtime image, Node or Python.
 *
 * Added in Checkpoint 20.5, after the first real vulnerability scan of the
 * shipped images. Every single HIGH/CRITICAL finding across all five was in
 * one of these: npm's vendored dependencies in the four Node images, and
 * setuptools' vendored dependencies in the document engine. PalCert's own
 * dependency closure was clean in all five.
 *
 * So the finding was never "PalCert depends on something vulnerable". It was
 * "PalCert ships a package manager it does not run". A package manager in a
 * production container is a tool that fetches and executes remote code, held
 * by a process that should only ever serve requests — and it drags in an
 * advisory feed that has nothing to do with this application. Removing it
 * fixes both problems at once, and this keeps it removed.
 */
const TOOLCHAIN_PATHS = [
  '/usr/local/lib/node_modules/npm',
  '/usr/local/lib/node_modules/corepack',
  '/usr/local/bin/npm',
  '/usr/local/bin/npx',
  '/usr/local/bin/corepack',
  '/usr/local/lib/python3.11/site-packages/setuptools',
  '/usr/local/lib/python3.11/site-packages/pkg_resources',
  '/usr/local/lib/python3.11/site-packages/wheel',
  '/usr/local/lib/python3.11/site-packages/pip',
  '/usr/local/bin/pip',
];

/**
 * Report which of those paths exist in the image.
 *
 * Prints a sentinel first and requires it back, because `test -e` over a list
 * that all comes back absent produces no output at all — which is
 * indistinguishable from a command that never ran. This gate has to be able to
 * tell "nothing is there" from "I could not look".
 */
function presentToolchainPaths(image) {
  const script = [
    'echo __probe_ok__',
    ...TOOLCHAIN_PATHS.map((path) => `[ -e "${path}" ] && echo "${path}"`),
    'true',
  ].join('\n');

  const output = execFileSync(
    'docker',
    ['run', '--rm', '--entrypoint', 'sh', image, '-c', script],
    { encoding: 'utf8' },
  );

  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.includes('__probe_ok__')) {
    throw new Error(`${image}: the toolchain probe did not run. Treat this as a failure.`);
  }
  return lines.filter((line) => line !== '__probe_ok__');
}

const images = process.argv.slice(2);
if (images.length === 0) {
  // Without this the script inspects nothing and exits 0, which reads as a
  // pass. `release.yml` called it with no arguments and had been "passing"
  // this gate against zero images.
  console.error('check-image-dependencies: no images given — refusing to report a pass');
  process.exit(64);
}

let failed = false;

function reportToolchain(image) {
  const toolchain = presentToolchainPaths(image);
  if (toolchain.length > 0) {
    failed = true;
    console.error(`  FAIL build tooling present: ${toolchain.join(', ')}`);
  } else {
    console.error('  ok  no package manager or build tooling present');
  }
}

for (const image of images) {
  const allowed = ALLOWED_BY_IMAGE.get(componentOf(image)) ?? new Set();
  const present = listPackages(image);

  if (present.size === 0) {
    // No `node_modules` anywhere: the Python image. The toolchain check below
    // still applies to it, and is the reason it is passed to this gate at all.
    console.error(`${image}: no node_modules tree — skipping the Node package check`);
    reportToolchain(image);
    continue;
  }

  const violations = FORBIDDEN.filter((name) => {
    if (allowed.has(name)) return false;
    // A scope like `@vitest` matches any package inside it.
    return name.startsWith('@')
      ? [...present].some((p) => p === name || p.startsWith(`${name}/`))
      : present.has(name);
  });

  // `console.error` throughout: this is a gate, its output is a report, and
  // stderr is where a report belongs when stdout might be piped somewhere.
  console.error(`${image}: ${present.size} packages`);
  if (violations.length > 0) {
    failed = true;
    console.error(`  FAIL development-only packages present: ${violations.join(', ')}`);
  } else {
    console.error('  ok  no development-only package present');
  }

  reportToolchain(image);
}

process.exit(failed ? 1 : 0);
