import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The production-like stack's boundary, asserted rather than documented
 * (Phase 20 Checkpoint 2).
 *
 * Checkpoint 20.1 found no deployment definition at all, and the development
 * compose file publishing PostgreSQL, Redis and the object store on localhost.
 * The release stack encodes the opposite: one published surface, everything
 * else reachable only from inside. That property is one careless `ports:` entry
 * away from being untrue, and the mistake would be invisible — the stack would
 * still work perfectly.
 *
 * These tests read the manifest rather than running it, so they hold in CI
 * without Docker.
 */
const MANIFEST_PATH = new URL('../../../docker/docker-compose.release.yml', import.meta.url);
const source = readFileSync(MANIFEST_PATH, 'utf8');

const PROXY_PATH = new URL('../../../docker/release-proxy.conf', import.meta.url);
const proxy = readFileSync(PROXY_PATH, 'utf8');

const WORKFLOW_PATH = new URL('../../../.github/workflows/ci.yml', import.meta.url);
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

/**
 * Every variable the topology refuses to start without.
 *
 * `${FOO:?message}` is compose's "required, and here is what to tell the
 * operator". Collecting them mechanically is the point: a variable added to
 * the topology later is picked up here without anyone remembering to add it.
 */
function requiredVariables(): string[] {
  // Comment lines are skipped: the file's own header explains the syntax with
  // a `${VAR:?message}` example, and a documentation placeholder is not a
  // variable any environment has to supply.
  const statements = source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  return [
    ...new Set([...statements.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((match) => match[1]!)),
  ].sort();
}

/**
 * The service blocks, without a YAML parser.
 *
 * Deliberately not a dependency: adding one to the configuration package so a
 * test can read a compose file would put a parser in the production dependency
 * graph of every image. The structure needed here is shallow — the names under
 * `services:` and the text of each block — and indentation is enough to find
 * it.
 */
function serviceBlocks(): Map<string, string> {
  const blocks = new Map<string, string>();
  const lines = source.split('\n');

  let inServices = false;
  let current: string | null = null;
  let body: string[] = [];

  const flush = () => {
    if (current !== null) blocks.set(current, body.join('\n'));
    body = [];
  };

  for (const line of lines) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (!inServices) continue;

    // A new top-level key ends the services section.
    if (/^[a-zA-Z]/.test(line)) {
      flush();
      current = null;
      inServices = false;
      continue;
    }

    const started = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
    if (started) {
      flush();
      current = started[1]!;
      continue;
    }
    if (current !== null) body.push(line);
  }
  flush();
  return blocks;
}

const services = serviceBlocks();

/** Whether a service block declares a host port mapping. */
function publishesPorts(name: string): boolean {
  const block = services.get(name);
  if (block === undefined) throw new Error(`no such service in the manifest: ${name}`);
  return /^\s{4}ports:\s*$/m.test(block);
}

/** Everything that must never be reachable from outside the stack. */
const INTERNAL = [
  'postgres',
  'redis',
  'minio',
  'clamav',
  'document-engine',
  'worker',
  'migrate',
  'storage-init',
  'certs',
];

describe('release stack topology', () => {
  it('finds every service, so the rest of this file is not vacuous', () => {
    expect([...services.keys()].sort()).toEqual([
      'api',
      'certs',
      'clamav',
      'document-engine',
      'migrate',
      'migrate-check',
      'minio',
      'postgres',
      'proxy',
      'redis',
      'storage-init',
      'web',
      'worker',
    ]);
  });

  it('publishes exactly one service to the host', () => {
    const published = [...services.keys()].filter((name) => publishesPorts(name));

    // The proxy is the boundary. Anything else here is a service somebody
    // exposed to the host by accident.
    expect(published).toEqual(['proxy']);
  });

  it.each(INTERNAL)('does not publish %s', (name) => {
    expect(publishesPorts(name)).toBe(false);
  });

  it('does not publish the object store’s administrative console', () => {
    // MinIO's console is an administrative interface. The development compose
    // starts it with `--console-address :9001`; a release stack must not.
    // Comments stripped first: the block explains *why* the console is absent,
    // and matching the explanation instead of the configuration would make
    // this test fail for saying the right thing.
    const minio = (services.get('minio') ?? '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');

    expect(minio).not.toContain('console-address');
    expect(minio).not.toContain('9001');
  });

  it('keeps every credential out of the manifest', () => {
    // Values come from the environment. `${VAR:?...}` fails the run when one
    // is missing, which is louder and safer than a default nobody changed.
    for (const secret of [
      'POSTGRES_PASSWORD',
      'POSTGRES_APP_PASSWORD',
      'STORAGE_SECRET_ACCESS_KEY',
      'AUTH_MFA_SECRET_KEY',
      'CERTIFICATE_VERIFICATION_SECRET_KEY',
      'API_CLIENT_REVEAL_SECRET_KEY',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
    ]) {
      // Each must appear only as a required interpolation, never as a literal.
      expect(source).toContain(`\${${secret}:?`);
    }

    // Nothing that looks like real key material.
    expect(source).not.toMatch(/sk_live_|whsec_[A-Za-z0-9]{20,}/);
  });

  it('runs one migration step, then gates the application on its result', () => {
    // Not every replica racing to migrate at startup: one job, and one check
    // of what that job actually achieved.
    expect(services.has('migrate')).toBe(true);
    expect(services.has('migrate-check')).toBe(true);

    // The check waits for the migration job.
    expect(services.get('migrate-check')).toMatch(
      /migrate: \{ condition: service_completed_successfully \}/,
    );

    // And the API and the worker wait for the *check*, not for the job.
    //
    // `migrate` exiting 0 says the job ran, not that this database is at this
    // build's level: an image can be deployed whose migrations never reached
    // this database, and the application will start, pass its readiness probe,
    // and fail only on the paths that needed the missing object. Checkpoint
    // 20.3 shipped exactly that and its end-to-end suite reported green.
    for (const name of ['api', 'worker']) {
      expect(services.get(name)).toMatch(
        /migrate-check: \{ condition: service_completed_successfully \}/,
      );
    }
    const waiters = source.match(/migrate-check: \{ condition: service_completed_successfully \}/g);
    expect(waiters?.length).toBeGreaterThanOrEqual(2);
  });

  it('is startable by every environment that claims to configure it', () => {
    // Checkpoint 20.4 made the webhook keyring required here, and that broke
    // the continuous-integration job: its release environment was written
    // before the requirement existed, so `docker compose up` refused with
    // "required variable WEBHOOK_ENCRYPTION_KEYS is missing a value" and the
    // image gate could not run at all.
    //
    // The fix is a line in a workflow. What stops it happening again is this:
    // the required set is read out of the topology rather than listed, so the
    // next variable someone makes required is checked the moment they add it.
    const required = requiredVariables();
    expect(required.length).toBeGreaterThan(5);

    const missing = required.filter((name) => !workflow.includes(`${name}=`));
    expect(missing).toEqual([]);
  });

  it('carries every secret a restored installation needs to start', () => {
    // Checkpoint 20.4's recovery drill found the webhook keyring missing from
    // this topology entirely. It went unnoticed because earlier release stacks
    // ran against empty databases: with no webhook rows, nothing needed a key.
    // Restore a database that actually has an endpoint in it and the API
    // refuses to start — correctly, because a webhook URL and signing secret
    // are unreadable without the exact key id that sealed them.
    for (const variable of [
      'AUTH_MFA_SECRET_KEY',
      'CERTIFICATE_VERIFICATION_SECRET_KEY',
      'API_CLIENT_REVEAL_SECRET_KEY',
      'WEBHOOK_ENCRYPTION_KEYS',
      'WEBHOOK_ENCRYPTION_ACTIVE_KID',
    ]) {
      expect(source).toContain(`${variable}: \${${variable}:?`);
    }
  });

  it('keeps telemetry off the only published surface', () => {
    // Phase 20 Checkpoint 3. Every service exposes `/metrics` on the
    // deployment network, where a scraper reaches it directly. The proxy is
    // the one thing published to the outside, and it must refuse that path —
    // otherwise its catch-all would proxy an external `/metrics` straight to
    // the web app, which is how a metrics endpoint becomes a public
    // description of what the system is doing.
    //
    // `^~` so `/metrics/anything` is covered too, and 404 rather than 403 so
    // the outside cannot tell the endpoint exists at all.
    expect(proxy).toMatch(/location \^~ \/metrics \{[^}]*return 404;/);
    expect(proxy).not.toMatch(/location[^\n]*\/metrics[^\n]*\{[^}]*proxy_pass/);
  });

  it('gives every PalCert-owned service the same telemetry switches', () => {
    for (const service of ['web', 'document-engine']) {
      const block = services.get(service) ?? '';
      expect(block).toMatch(/METRICS_ENABLED:/);
      expect(block).toMatch(/METRICS_TOKEN:/);
    }
    // The API and the worker share the application environment anchor.
    expect(source).toMatch(/^ {2}METRICS_ENABLED: \$\{METRICS_ENABLED:-true\}$/m);
  });

  it('does not let a deployment overwrite an image’s release identity', () => {
    // The commit and build time are baked into the image. A deployment that
    // could set them could lie about which build is running, and an earlier
    // draft did exactly that with an empty default.
    expect(source).not.toMatch(/^\s+APP_COMMIT:/m);
    expect(source).not.toMatch(/^\s+APP_BUILT_AT:/m);
  });
});

/**
 * How a browser's document reaches object storage (Phase 20 Checkpoint 9).
 *
 * Nobody could upload a document through the interface of this stack: the
 * presigned URL named `https://localhost:9000`, which nothing published and
 * the web app's `connect-src 'self'` would have refused anyway; and MinIO had
 * no KMS, so the SSE that production insists on was refused with a 501. The
 * browser checks in `qa/release-checks.mjs` prove the repaired path end to
 * end; these hold its shape where a careless edit would undo it.
 */
describe('release stack storage path', () => {
  /** A service block's `networks: [...]` list. */
  const networksOf = (name: string): string[] =>
    (/^\s{4}networks: \[([^\]]*)\]/m.exec(services.get(name) ?? '')?.[1] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');

  it('signs browser URLs for the web origin by default', () => {
    expect(source).toMatch(
      /^ {2}STORAGE_PUBLIC_ENDPOINT: \$\{STORAGE_PUBLIC_ENDPOINT:-\$\{APP_PUBLIC_WEB_URL:-https:\/\/localhost:8443\}\}$/m,
    );
  });

  it('lets the proxy reach the object store and nothing else stateful', () => {
    const onStorage = [...services.keys()].filter((name) => networksOf(name).includes('storage'));
    expect(onStorage.sort()).toEqual(['minio', 'proxy']);
    expect(networksOf('proxy').sort()).toEqual(['edge', 'storage']);
    for (const name of ['postgres', 'redis', 'clamav', 'document-engine']) {
      expect(networksOf(name)).not.toContain('storage');
      expect(networksOf(name)).not.toContain('edge');
    }
  });

  it('routes only object paths in the three buckets, for presigned requests only', () => {
    const route =
      /location ~ \^\/\(palcert-documents\|palcert-quarantine\|palcert-derived\)\/\.\+ \{([\s\S]*?)\n {4}\}/.exec(
        proxy,
      )?.[1] ?? '';
    expect(route).not.toBe('');
    expect(route).toMatch(/limit_except GET PUT \{\s*deny all;\s*\}/);
    expect(route).toMatch(/proxy_pass https:\/\/minio:9000;/);
    // SigV4 signs the host with its port; `$host` would drop it.
    expect(route).toMatch(/proxy_set_header Host \$http_host;/);
    expect(route).toMatch(/proxy_set_header Authorization "";/);
    expect(route).toMatch(/proxy_set_header Cookie "";/);
    expect(route).toMatch(/proxy_ssl_verify on;/);
    expect(route).toMatch(
      /Content-Security-Policy "default-src 'none'; frame-ancestors 'none'; sandbox"/,
    );
    expect(route).toMatch(/X-Content-Type-Options nosniff/);
  });

  it('gives the object store an SSE key only it can read', () => {
    expect(services.get('minio')).toMatch(/MINIO_KMS_SECRET_KEY_FILE: \/kms\/key/);
    const mounting = [...services.keys()].filter((name) =>
      /^\s+- storage-kms:/m.test(services.get(name) ?? ''),
    );
    expect(mounting.sort()).toEqual(['certs', 'minio']);
    expect(services.get('minio')).toMatch(/- storage-kms:\/kms:ro/);
  });

  it('encrypts every bucket at rest by default, including what a restore writes', () => {
    // PalCert sends SSE on each write; the restore tooling does not, so the
    // bucket default is what keeps restored objects encrypted.
    expect(services.get('storage-init')).toMatch(
      /mc --insecure encrypt set sse-s3 "release\/\$\$bucket"/,
    );
  });
});
