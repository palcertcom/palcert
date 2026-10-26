#!/usr/bin/env node
/**
 * Decide whether this promotion may proceed (Phase 20 Checkpoint 5).
 *
 *   node scripts/release/check-promotion-allowed.mjs \
 *     --environment production --ref refs/heads/main --reason "..." \
 *     --approved-by someone --freeze release-freeze.json \
 *     --staging-record staging-deployment.json
 *
 * The production promotion boundary, written where it can be tested. It used
 * to live as `if:` conditions and inline shell inside the deployment workflow,
 * which meant the only way to find out whether it refused an unofficial branch
 * was to dispatch a production deployment from one.
 *
 * Four conditions, and each exists because of a specific way a release reaches
 * production without anyone deciding it should:
 *
 *   ref        — the workflow file is read from the ref it was dispatched on,
 *                so a branch can carry a modified deployment. Production runs
 *                from the default branch or a release tag, and nothing else.
 *   approval   — a named human. GitHub's environment protection is the
 *                mechanism; this records that it actually happened, so the
 *                audit record can say who rather than "a workflow".
 *   reason     — stated, not inferred. The question "why was this deployed"
 *                is asked months later, usually during an incident.
 *   staging    — this exact release, by manifest digest, must have passed
 *                staging. Not a release with the same version string: the
 *                same bytes. This is what stops a manifest being rebuilt or
 *                edited between the environment that accepted it and the one
 *                that serves it.
 *
 * Exit codes are distinct so a workflow, and a test, can tell the reasons
 * apart: 3 unofficial ref, 4 no approval, 5 no reason, 6 staging evidence
 * missing or for something else.
 */
import { readFileSync } from 'node:fs';

/** Refs a production promotion may be dispatched from. */
const PRODUCTION_REFS = [/^refs\/heads\/main$/, /^refs\/tags\/v/];

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) args[arg.slice(2)] = argv[(index += 1)] ?? '';
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const environment = args.environment ?? '';
if (!['staging', 'production'].includes(environment)) {
  console.error(`check-promotion: unknown environment: ${environment || '(none)'}`);
  process.exit(64);
}
if (args.freeze === undefined) {
  console.error('check-promotion: --freeze <release-freeze.json> is required');
  process.exit(64);
}

const freeze = JSON.parse(readFileSync(args.freeze, 'utf8'));
console.log(`check-promotion: ${freeze.releaseVersion} -> ${environment}`);

function refuse(message, code) {
  console.error(`check-promotion: REFUSED — ${message}`);
  process.exit(code);
}

if (environment === 'staging') {
  // Staging is where a release earns the right to be considered. It has no
  // approval boundary by design: requiring one would mean releases wait for a
  // human before anyone can tell whether they work.
  console.log('check-promotion: staging needs no approval boundary');
  console.log('check-promotion: allowed');
  process.exit(0);
}

const ref = args.ref ?? '';
if (!PRODUCTION_REFS.some((pattern) => pattern.test(ref))) {
  refuse(`production cannot be promoted from ${ref || '(no ref)'}`, 3);
}
console.log(`check-promotion: ok   ref ${ref} may promote production`);

const approvedBy = (args['approved-by'] ?? '').trim();
if (approvedBy === '') {
  refuse('production promotion requires a named approver', 4);
}
console.log(`check-promotion: ok   approved by ${approvedBy}`);

const reason = (args.reason ?? '').trim();
if (reason === '') {
  refuse('production promotion requires a stated reason', 5);
}
console.log('check-promotion: ok   a reason was stated');

// --- the staging evidence ---------------------------------------------------
if (args['staging-record'] === undefined) {
  refuse('production promotion requires the staging deployment record', 6);
}

let staging;
try {
  staging = JSON.parse(readFileSync(args['staging-record'], 'utf8'));
} catch (error) {
  refuse(`the staging record cannot be read: ${error.message}`, 6);
}

if (staging.environment !== 'staging') {
  refuse(`the record supplied is for ${staging.environment}, not staging`, 6);
}
if (staging.outcome !== 'success') {
  refuse(`staging recorded outcome "${staging.outcome}", not success`, 6);
}
if (staging.releaseVersion !== freeze.releaseVersion) {
  refuse(
    `staging passed ${staging.releaseVersion}, but this promotion is ${freeze.releaseVersion}`,
    6,
  );
}

// By content, not by version string. Two manifests can name the same release
// and describe different images; only the digest tells them apart.
const recordedManifest = staging.manifestDigest ?? null;
if (recordedManifest === null) {
  refuse('the staging record does not name the manifest it deployed', 6);
}
if (recordedManifest !== freeze.manifest.digest) {
  refuse(
    `staging deployed manifest ${recordedManifest.slice(0, 23)}…, ` +
      `this promotion carries ${freeze.manifest.digest.slice(0, 23)}…`,
    6,
  );
}
console.log(`check-promotion: ok   staging passed this exact manifest`);

// And the digests themselves, so a record naming the right manifest but the
// wrong images cannot pass either.
for (const [component, image] of Object.entries(freeze.images)) {
  const deployed = staging.images?.[component];
  if (typeof deployed !== 'string' || !deployed.endsWith(`@${image.digest}`)) {
    refuse(`staging did not run the frozen ${component} image`, 6);
  }
}
console.log('check-promotion: ok   staging ran all five frozen digests');

console.log('check-promotion: allowed');
