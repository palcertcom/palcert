#!/usr/bin/env node
/**
 * Configuration inventory and reconciliation (Phase 20 Checkpoint 7).
 *
 *   node scripts/security/audit-config.mjs [--json]
 *
 * Two questions, asked mechanically rather than by reading:
 *
 *   1. Is every variable the schema declares actually consumed by something?
 *      A declared-and-unread variable is worse than clutter when it looks
 *      like a security control: an operator sets `SOMETHING_ENFORCED=true`,
 *      the deployment validates it, and nothing reads it. The audit that
 *      opened Phase 20 found exactly one of those (F-002,
 *      `AUTH_SESSION_SECRET`).
 *
 *   2. Is every variable something actually *reads* declared and validated?
 *      An undeclared read is configuration that bypasses the schema, so it is
 *      neither validated nor refused when malformed, and a typo in a
 *      deployment becomes a silent default at runtime.
 *
 * The answer to both must be "yes" for every variable, or this exits non-zero
 * and names the ones that fail.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA = 'packages/config/src/env.schema.ts';

/** Where a variable may legitimately be read. */
const CODE_GLOBS = [
  'apps/**/*.ts',
  'apps/**/*.tsx',
  'packages/**/*.ts',
  'services/**/*.py',
  'scripts/**/*.mjs',
  'scripts/**/*.cjs',
  'scripts/**/*.sh',
  'packages/**/*.mjs',
];

/** Where a variable may legitimately be *supplied*. */
const DEPLOYMENT_GLOBS = ['docker/**', '.github/workflows/**', '.env.example', 'docs/**/*.md'];

function ripgrep(pattern, globs, extra = []) {
  try {
    return execFileSync(
      'rg',
      [
        '--no-messages',
        '-l',
        '--fixed-strings',
        pattern,
        ...globs.flatMap((g) => ['-g', g]),
        ...extra,
        '.',
      ],
      { cwd: REPO, encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter((line) => line !== '');
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// What the schema declares.
// ---------------------------------------------------------------------------
const schemaText = readFileSync(path.join(REPO, SCHEMA), 'utf8');
const declared = new Map();
for (const line of schemaText.split('\n')) {
  const match = /^\s+([A-Z][A-Z0-9_]{2,}):\s*(.*)$/.exec(line);
  if (match === null) continue;
  const [, name, rest] = match;
  if (declared.has(name)) continue;
  declared.set(name, {
    name,
    // A best-effort classification from the declaration itself. It is checked
    // against the deployment topology separately; this is the starting point,
    // not the authority.
    optional: /\.optional\(\)|\.default\(/.test(rest) || /emptyAsUndefined/.test(rest),
    secretShaped:
      /^(.*_)?(SECRET|SECRET_KEY|PASSWORD|API_KEY|KEYS|ACCESS_KEY_ID)$/.test(name) ||
      /secret\b/.test(rest),
  });
}

// ---------------------------------------------------------------------------
// What code reads. The application reads configuration through typed getters
// over a validated object (`this.env.X`), never `process.env` directly, so a
// name appearing anywhere in source outside the schema counts as consumed.
// ---------------------------------------------------------------------------
const unconsumed = [];
const supplyOnly = [];
for (const [name, info] of declared) {
  const inCode = ripgrep(name, CODE_GLOBS).filter((file) => !file.endsWith(SCHEMA));
  const inDeployment = ripgrep(name, DEPLOYMENT_GLOBS);
  info.code = inCode;
  info.deployment = inDeployment;
  if (inCode.length === 0) {
    if (inDeployment.length > 0) supplyOnly.push(name);
    else unconsumed.push(name);
  }
}

// ---------------------------------------------------------------------------
// What code reads that the schema does not declare.
//
// `process.env.X` in application code, and `os.environ`/`os.getenv` in the
// document engine. A handful of names are legitimately outside the schema and
// are listed rather than silently skipped.
// ---------------------------------------------------------------------------
const OUTSIDE_SCHEMA = new Map([
  ['NODE_ENV', 'the runtime’s own, declared in the base schema and also read directly by tooling'],
  ['CI', 'set by the CI runner, never by a deployment'],
  ['PORT', 'the document engine’s listen port, supplied by the container runtime'],
  ['DATABASE_ADMIN_URL', 'migration/preflight tooling only; declared in the database schema'],
  ['PALCERT_ENGINE_LOG_LEVEL', 'document engine logging'],
]);

/**
 * Test scaffolding is not the production configuration surface.
 *
 * It is still inventoried — a variable that switches off a security control
 * for a test is worth knowing about, and the taxonomy this checkpoint works
 * to has a "development/test-only" class for exactly that. What it must not
 * do is fail the reconciliation: a test opt-in has no business in the
 * production schema, and putting it there would mean a deployment could set
 * it.
 */
const TEST_ONLY = [
  '**/test/**',
  '**/tests/**',
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/*.e2e-spec.ts',
];

function readsFromCode(testScope) {
  const found = new Map();
  const patterns = [
    [
      String.raw`process\.env\.([A-Z][A-Z0-9_]{2,})`,
      ['apps/**/*.ts', 'apps/**/*.tsx', 'packages/**/*.ts'],
    ],
    [
      String.raw`process\.env\[['"]([A-Z][A-Z0-9_]{2,})['"]\]`,
      ['apps/**/*.ts', 'apps/**/*.tsx', 'packages/**/*.ts'],
    ],
    [String.raw`os\.environ(?:\.get)?\(?\[?['"]([A-Z][A-Z0-9_]{2,})['"]`, ['services/**/*.py']],
    [String.raw`os\.getenv\(['"]([A-Z][A-Z0-9_]{2,})['"]`, ['services/**/*.py']],
  ];
  const scope = testScope
    ? TEST_ONLY.flatMap((g) => ['-g', g])
    : TEST_ONLY.flatMap((g) => ['-g', `!${g}`]);
  for (const [pattern, globs] of patterns) {
    let output = '';
    try {
      output = execFileSync(
        'rg',
        [
          '--no-messages',
          '--no-heading',
          '-o',
          '-r',
          '$1',
          pattern,
          ...globs.flatMap((g) => ['-g', g]),
          ...scope,
          '.',
        ],
        { cwd: REPO, encoding: 'utf8' },
      );
    } catch {
      output = '';
    }
    for (const line of output.split('\n')) {
      const name = line.split(':').pop()?.trim();
      if (name !== undefined && name !== '') found.set(name, true);
    }
  }
  return [...found.keys()].sort();
}

const interesting = (name) =>
  !declared.has(name) && !OUTSIDE_SCHEMA.has(name) && !name.startsWith('NEXT_PUBLIC_');

const undeclared = readsFromCode(false).filter(interesting);
const testOnly = readsFromCode(true)
  .filter(interesting)
  .filter((n) => !undeclared.includes(n));

// ---------------------------------------------------------------------------
// Per-process reconciliation.
//
// "Declared somewhere in the schema file" is not the same as "declared in the
// schema *this process* validates against", and the difference is where a real
// defect hid: the Next.js web server read `METRICS_ENABLED` and
// `METRICS_TOKEN`, both declared in the API schema and neither in
// `webEnvSchema`, so neither was validated in the process that read them —
// and the hand-written parse accepted any string (Phase 20 Checkpoint 7).
//
// The API, the worker and the migrate job all validate `apiEnvSchema` at boot,
// so they share one surface. The web server has no startup hook where a schema
// could run, so its direct reads are listed explicitly, each with the reason
// it is allowed to be one.
// ---------------------------------------------------------------------------
function schemaBlock(name) {
  const start = schemaText.indexOf(`export const ${name} = `);
  if (start === -1) return new Set();
  const rest = schemaText.slice(start);
  const end = rest.indexOf('\nexport type');
  const body = end === -1 ? rest : rest.slice(0, end);
  return new Set([...body.matchAll(/^\s+([A-Z][A-Z0-9_]{2,}):/gm)].map((match) => match[1]));
}

/**
 * Reads the Next.js server makes directly, and why each one is acceptable
 * there. Anything else the web app reads is a finding.
 */
const WEB_DIRECT_READS = new Map([
  ['METRICS_ENABLED', 'parsed with the shared strict parser at the point of use'],
  ['METRICS_TOKEN', 'compared verbatim; absent or empty means no token'],
  ['APP_VERSION', 'build label, for the build-info gauge'],
  ['APP_COMMIT', 'build label, for the build-info gauge'],
  ['APP_BUILT_AT', 'build label, for the health response'],
  ['NODE_ENV', 'the runtime’s own'],
]);

const webSchema = schemaBlock('webEnvSchema');
const webReads = (() => {
  let output = '';
  try {
    output = execFileSync(
      'rg',
      [
        '--no-messages',
        '--no-heading',
        '-o',
        '-r',
        '$1',
        String.raw`process\.env(?:\.|\[['"])([A-Z][A-Z0-9_]{2,})`,
        '-g',
        'apps/web/src/**/*.ts',
        '-g',
        'apps/web/src/**/*.tsx',
        '-g',
        '!**/*.spec.ts',
        '-g',
        '!**/*.spec.tsx',
        '-g',
        '!**/test/**',
        '.',
      ],
      { cwd: REPO, encoding: 'utf8' },
    );
  } catch {
    output = '';
  }
  return [
    ...new Set(
      output
        .split('\n')
        .map((line) => line.split(':').pop()?.trim())
        .filter(Boolean),
    ),
  ].sort();
})();

const webUnaccounted = webReads.filter(
  (name) => !webSchema.has(name) && !WEB_DIRECT_READS.has(name) && !name.startsWith('NEXT_PUBLIC_'),
);

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
if (process.argv.includes('--json')) {
  console.log(
    JSON.stringify(
      {
        declared: [...declared.values()],
        unconsumed,
        supplyOnly,
        undeclared,
        testOnly,
        webReads,
        webUnaccounted,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`audit-config: ${declared.size} variables declared in ${SCHEMA}`);
  console.log(
    `audit-config: ${declared.size - unconsumed.length - supplyOnly.length} consumed by code`,
  );
  if (supplyOnly.length > 0) {
    console.log(`audit-config: ${supplyOnly.length} supplied by deployment but not read by code:`);
    for (const name of supplyOnly) console.log(`audit-config:   ${name}`);
  }
  if (unconsumed.length > 0) {
    console.log(`audit-config: ${unconsumed.length} declared and read by nothing at all:`);
    for (const name of unconsumed) console.log(`audit-config:   ${name}`);
  }
  if (undeclared.length > 0) {
    console.log(`audit-config: ${undeclared.length} read by PRODUCTION code but not declared:`);
    for (const name of undeclared) console.log(`audit-config:   ${name}`);
  }
  if (testOnly.length > 0) {
    console.log(
      `audit-config: ${testOnly.length} read only by test scaffolding (not a production surface):`,
    );
    for (const name of testOnly) console.log(`audit-config:   ${name}`);
  }
  console.log(`audit-config: the web server reads ${webReads.length} variables directly:`);
  for (const name of webReads) {
    const why = webSchema.has(name)
      ? 'validated by webEnvSchema'
      : name.startsWith('NEXT_PUBLIC_')
        ? 'public build-time value'
        : (WEB_DIRECT_READS.get(name) ?? '**UNACCOUNTED**');
    console.log(`audit-config:   ${name}: ${why}`);
  }
}

if (webUnaccounted.length > 0) {
  console.error(
    `audit-config: the web server reads ${webUnaccounted.length} variable(s) its own schema does not ` +
      'validate and that are not documented direct reads: ' +
      webUnaccounted.join(', '),
  );
}

if (
  unconsumed.length > 0 ||
  supplyOnly.length > 0 ||
  undeclared.length > 0 ||
  webUnaccounted.length > 0
) {
  console.error('audit-config: configuration inventory is not reconciled');
  process.exit(65);
}
console.log(
  'audit-config: every declared variable is consumed, and every consumed variable is declared',
);
