#!/usr/bin/env node
/**
 * Prove an environment supplies everything the release topology requires,
 * before anything starts (Phase 20 Checkpoint 5).
 *
 *   node scripts/release/check-deployment-secrets.mjs --env-file env --compose docker/docker-compose.release.yml
 *
 * The required set is read from the topology itself — every `${VAR:?...}` in
 * the compose file — rather than from a list maintained beside it. A list
 * drifts: Checkpoint 20.4 made the webhook keyring required and CI's
 * environment file, written months earlier, did not have it. Nothing noticed
 * until the API refused to start, which is a late and expensive place to find
 * out.
 *
 * Finding out here instead matters because of where the failure lands. A
 * missing secret discovered during rollout leaves a half-started deployment:
 * migrations applied, some services up, ingress closed, and an operator
 * deciding what to do at the worst moment. Discovered here, nothing has
 * happened yet.
 *
 * Values are never printed, compared or logged — only whether a name is
 * present and non-empty. A tool that reports which secret is wrong by showing
 * it is a tool that puts secrets in CI logs.
 */
import { readFileSync } from 'node:fs';

function parseArgs(argv) {
  const args = { envFile: null, compose: 'docker/docker-compose.release.yml' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--env-file') args.envFile = argv[(index += 1)];
    else if (arg === '--compose') args.compose = argv[(index += 1)];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.envFile === null) {
  console.error('check-deployment-secrets: --env-file is required');
  process.exit(64);
}

/**
 * Every variable the topology declares mandatory.
 *
 * `${VAR:?message}` is compose's "fail if unset or empty". Comment lines are
 * skipped: the file explains the pattern in prose in several places, and
 * matching those would invent requirements that do not exist.
 */
function requiredVariables(composeFile) {
  const required = new Set();
  for (const line of readFileSync(composeFile, 'utf8').split('\n')) {
    if (line.trim().startsWith('#')) continue;
    for (const match of line.matchAll(/\$\{([A-Z0-9_]+):\?/g)) required.add(match[1]);
  }
  return [...required].sort();
}

/** Names present and non-empty in the environment file. Values are discarded. */
function providedNames(envFile) {
  const provided = new Set();
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const split = trimmed.indexOf('=');
    if (split === -1) continue;
    const name = trimmed.slice(0, split).trim();
    if (trimmed.slice(split + 1).trim() !== '') provided.add(name);
  }
  return provided;
}

const required = requiredVariables(args.compose);
if (required.length === 0) {
  // The topology declaring nothing mandatory means the parse failed, not that
  // the deployment needs nothing. Reporting a pass here would disable the check.
  console.error(
    `check-deployment-secrets: found no required variables in ${args.compose} — the check is broken`,
  );
  process.exit(70);
}

const provided = providedNames(args.envFile);
const missing = required.filter((name) => !provided.has(name));

console.log(
  `check-deployment-secrets: ${required.length} required by ${args.compose}, ` +
    `${required.length - missing.length} supplied`,
);

if (missing.length > 0) {
  for (const name of missing) console.error(`check-deployment-secrets:   missing ${name}`);
  console.error(
    'check-deployment-secrets: this environment cannot run the release; nothing has been started',
  );
  process.exit(78);
}

console.log('check-deployment-secrets: every required variable is present');
