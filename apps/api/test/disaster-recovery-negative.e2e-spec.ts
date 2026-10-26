import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildRecoveryFixture } from './support/recovery-fixture';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * How recovery fails (Phase 20 Checkpoint 4).
 *
 * A backup tool is judged on the day it is asked to do something it cannot,
 * and the only acceptable behaviour then is to stop and say why. Every case
 * here is a way an archive or a destination can be wrong, and every assertion
 * is about the refusal: it must be non-zero, it must name the problem, and it
 * must happen *before* anything is written.
 *
 * Runs against one real archive taken once, then corrupted in copies — so the
 * failures are the tool's reaction to genuinely broken input rather than to a
 * hand-written fake of it.
 */
const API_DIR = path.resolve(__dirname, '..');
const REPO = path.resolve(__dirname, '..', '..', '..');
const SOURCE_DB =
  process.env['DATABASE_ADMIN_URL'] ??
  'postgresql://palcert:palcert_local_dev@localhost:5432/palcert';
const MAINTENANCE_DB = SOURCE_DB.replace(/\/[^/?]+(\?.*)?$/, '/postgres');

const env = {
  DATABASE_ADMIN_URL: SOURCE_DB,
  STORAGE_ENDPOINT: process.env['STORAGE_ENDPOINT'] ?? 'http://127.0.0.1:9000',
  STORAGE_REGION: 'us-east-1',
  STORAGE_ACCESS_KEY_ID: process.env['STORAGE_ACCESS_KEY_ID'] ?? 'test-access-key',
  STORAGE_SECRET_ACCESS_KEY: process.env['STORAGE_SECRET_ACCESS_KEY'] ?? 'test-secret-key',
  STORAGE_BUCKET: process.env['STORAGE_BUCKET'] ?? 'palcert-test-documents',
  STORAGE_QUARANTINE_BUCKET: process.env['STORAGE_QUARANTINE_BUCKET'] ?? 'palcert-test-quarantine',
  STORAGE_DERIVED_BUCKET: process.env['STORAGE_DERIVED_BUCKET'] ?? 'palcert-test-derived',
  STORAGE_FORCE_PATH_STYLE: 'true',
};

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runTool(script: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): RunResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      [path.join(API_DIR, 'scripts', script), ...args],
      {
        encoding: 'utf8',
        env: { ...process.env, ...env, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const details = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: details.status ?? 1,
      stdout: details.stdout ?? '',
      stderr: details.stderr ?? '',
    };
  }
}

/**
 * A Prisma connection URL as libpq will accept it.
 *
 * `DATABASE_ADMIN_URL` carries `?schema=public`, which Prisma understands and
 * libpq does not: psql rejects it outright with "invalid URI query parameter".
 * The backup and restore tooling has always normalised this (`toLibpqUrl` in
 * scripts/lib/pg-tools.mjs); this helper passed the URL through unchanged and
 * so could only ever work against a URL that happened not to carry it.
 */
function libpqUrl(url: string): string {
  return url.replace(/[?&]schema=[^&]*/g, '').replace(/\?$/, '');
}

function psql(url: string, sql: string): string {
  return execFileSync(
    'psql',
    [
      libpqUrl(url),
      '--no-psqlrc',
      '--quiet',
      '--tuples-only',
      '--no-align',
      '--set=ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { encoding: 'utf8' },
  ).trim();
}

describe('Disaster recovery — how it refuses (e2e)', () => {
  let workDir: string;
  let goodBackup: string;
  let context: TestContext;

  beforeAll(async () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'palcert-dr-neg-'));

    // The baseline archive is built from a fixture this suite creates, rather
    // than from whatever the database happens to hold.
    //
    // It used to back up the live state directly, which meant the object
    // manifest contained objects only if some earlier suite had left document
    // rows behind. The two tests that corrupt an object then passed or failed
    // according to suite ordering — and they failed on a run where nothing
    // had, with `manifest[0]` undefined rather than anything about backups.
    // A negative test that depends on another test's leftovers is not
    // testing what it claims to.
    context = await createTestContext();
    await resetState(context);
    await buildRecoveryFixture(context);

    const result = runTool('backup.mjs', ['--out', path.join(workDir, 'backups')]);
    if (result.status !== 0) throw new Error(`could not take a baseline backup: ${result.stderr}`);
    goodBackup = /backup: written to (.+)/.exec(result.stdout)![1]!.trim();

    // If this is ever empty the object cases below are vacuous, so say so here
    // rather than letting them fail later on an undefined array element.
    const objects = readFileSync(path.join(goodBackup, 'objects', 'manifest.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);
    if (objects.length === 0) {
      throw new Error('the baseline backup contains no objects; the object cases cannot run');
    }
  }, 900_000);

  afterAll(async () => {
    await destroyTestContext(context);
    rmSync(workDir, { recursive: true, force: true });
  });

  /** A throwaway copy of the good archive, for one test to break. */
  function copyOfBackup(name: string): string {
    const destination = path.join(workDir, name);
    cpSync(goodBackup, destination, { recursive: true });
    return destination;
  }

  function readManifest(dir: string): Record<string, unknown> {
    return JSON.parse(readFileSync(path.join(dir, 'backup.json'), 'utf8'));
  }
  function writeManifest(dir: string, manifest: Record<string, unknown>): void {
    writeFileSync(path.join(dir, 'backup.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  it('refuses an archive whose database dump is missing', () => {
    const dir = copyOfBackup('missing-dump');
    rmSync(path.join(dir, 'database', 'palcert.dump'));

    const verify = runTool('verify-backup.mjs', ['--from', dir]);
    expect(verify.status).toBe(65);
    expect(verify.stderr).toContain('component databaseDump is missing');

    const restore = runTool('restore.mjs', ['--from', dir, '--to-database', SOURCE_DB]);
    expect(restore.status).toBe(65);
    expect(restore.stderr).toContain('missing from the archive');
  }, 120_000);

  it('refuses an archive whose database dump was truncated in transfer', () => {
    const dir = copyOfBackup('truncated-dump');
    const dump = path.join(dir, 'database', 'palcert.dump');
    truncateSync(dump, Math.floor(statSync(dump).size / 2));

    const verify = runTool('verify-backup.mjs', ['--from', dir]);
    expect(verify.status).toBe(65);
    // Named as truncated rather than merely "corrupt": an operator can do
    // something about a transfer that was cut short.
    expect(verify.stderr).toContain('truncated');
  }, 120_000);

  it('refuses an archive whose dump is the right length but corrupt', () => {
    const dir = copyOfBackup('corrupt-dump');
    const dump = path.join(dir, 'database', 'palcert.dump');
    const bytes = readFileSync(dump);
    bytes[Math.floor(bytes.length / 2)] = bytes[Math.floor(bytes.length / 2)]! ^ 0xff;
    writeFileSync(dump, bytes);

    const verify = runTool('verify-backup.mjs', ['--from', dir]);
    expect(verify.status).toBe(65);
    expect(verify.stderr).toContain('corrupt');
  }, 120_000);

  it('refuses an archive with no object manifest', () => {
    const dir = copyOfBackup('missing-object-manifest');
    rmSync(path.join(dir, 'objects', 'manifest.jsonl'));

    const verify = runTool('verify-backup.mjs', ['--from', dir]);
    expect(verify.status).toBe(65);
    expect(verify.stderr).toContain('objectManifest is missing');
  }, 120_000);

  it('refuses an archive whose manifest checksum no longer matches', () => {
    const dir = copyOfBackup('bad-manifest-checksum');
    const manifestPath = path.join(dir, 'objects', 'manifest.jsonl');
    writeFileSync(manifestPath, `${readFileSync(manifestPath, 'utf8')}\n`);

    const verify = runTool('verify-backup.mjs', ['--from', dir]);
    expect(verify.status).toBe(65);
    expect(verify.stderr.toLowerCase()).toMatch(/truncated|corrupt|objectmanifest/);
  }, 120_000);

  it('refuses an archive missing an object its manifest lists', () => {
    const dir = copyOfBackup('missing-object');
    const manifest = readFileSync(path.join(dir, 'objects', 'manifest.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { zone: string; key: string });
    const victim = manifest[0]!;
    rmSync(path.join(dir, 'objects', 'data', victim.zone, victim.key));

    const verify = runTool('verify-backup.mjs', ['--from', dir]);
    expect(verify.status).toBe(65);
    expect(verify.stderr).toContain('is listed but absent');
  }, 120_000);

  it('refuses an object whose bytes no longer hash to what was recorded', () => {
    const dir = copyOfBackup('bad-object-checksum');
    const manifest = readFileSync(path.join(dir, 'objects', 'manifest.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { zone: string; key: string; sizeBytes: number });
    const victim = manifest[0]!;
    const victimPath = path.join(dir, 'objects', 'data', victim.zone, victim.key);
    const bytes = readFileSync(victimPath);
    bytes[0] = bytes[0]! ^ 0xff;
    // Same length, different content: only a deep verify can see this, which
    // is exactly why `--deep` exists and why a scheduled job should use it.
    writeFileSync(victimPath, bytes);

    expect(runTool('verify-backup.mjs', ['--from', dir]).status).toBe(0);
    const deep = runTool('verify-backup.mjs', ['--from', dir, '--deep']);
    expect(deep.status).toBe(65);
    expect(deep.stderr).toContain('fails its checksum');
  }, 120_000);

  it('refuses a backup format version it does not understand', () => {
    const dir = copyOfBackup('future-format');
    const manifest = readManifest(dir);
    manifest['formatVersion'] = 999;
    writeManifest(dir, manifest);

    const verify = runTool('verify-backup.mjs', ['--from', dir]);
    expect(verify.status).toBe(65);
    expect(verify.stderr).toContain('is not supported by this build');
  }, 120_000);

  it('refuses to restore a backup that recorded a dangling reference', () => {
    const dir = copyOfBackup('unclean-backup');
    const manifest = readManifest(dir);
    manifest['reconciliation'] = { missingReferenced: 3, checksumMismatches: 0, details: {} };
    writeManifest(dir, manifest);

    const restore = runTool('restore.mjs', ['--from', dir, '--to-database', SOURCE_DB]);
    expect(restore.status).toBe(65);
    expect(restore.stderr).toContain('--allow-unclean-backup');
  }, 120_000);

  it('refuses a destination that already holds a PalCert schema', () => {
    // The source database is very much not clean. Restoring on top of live
    // data is how a recovery turns one outage into two.
    const restore = runTool('restore.mjs', ['--from', goodBackup, '--to-database', SOURCE_DB]);
    expect(restore.status).toBe(65);
    expect(restore.stderr).toContain('must go into a clean database');
    // And it refused before writing: the source still has its tables.
    expect(
      Number(psql(SOURCE_DB, "SELECT count(*) FROM pg_tables WHERE schemaname='public';")),
    ).toBeGreaterThan(80);
  }, 120_000);

  it('refuses a destination it cannot reach', () => {
    const restore = runTool('restore.mjs', [
      '--from',
      goodBackup,
      '--to-database',
      SOURCE_DB.replace(/\/[^/?]+(\?.*)?$/, '/palcert_no_such_database'),
    ]);
    expect(restore.status).toBe(69);
    expect(restore.stderr).toContain('cannot reach the destination database');
  }, 120_000);

  it('refuses to open traffic on a database whose migration history is stale', () => {
    // The Checkpoint-20.3 failure mode, as a test. A restored database one
    // migration behind the code starts, serves, and fails only on the paths
    // that needed the missing object.
    const staleDb = SOURCE_DB.replace(/\/[^/?]+(\?.*)?$/, '/palcert_stale_drill');
    psql(MAINTENANCE_DB, 'DROP DATABASE IF EXISTS palcert_stale_drill;');
    psql(MAINTENANCE_DB, 'CREATE DATABASE palcert_stale_drill OWNER palcert;');
    try {
      // Objects are skipped: this case is about the migration history alone,
      // and uploading the closure a second time would prove nothing here.
      const restore = runTool('restore.mjs', [
        '--from',
        goodBackup,
        '--to-database',
        staleDb,
        '--skip-objects',
      ]);
      expect(restore.status).toBe(0);

      // Remove the newest migration from the restored history, as a restore
      // from an older archive would leave it.
      const newest = psql(
        staleDb,
        'SELECT migration_name FROM _prisma_migrations ORDER BY migration_name DESC LIMIT 1;',
      );
      psql(staleDb, `DELETE FROM _prisma_migrations WHERE migration_name='${newest}';`);

      const check = runTool2(staleDb);
      expect(check.status).toBe(3);
      expect(check.stderr).toContain('is not applied');

      const verify = runTool('verify-restore.mjs', [
        '--database',
        staleDb,
        '--migrations',
        path.join(REPO, 'packages', 'database', 'prisma', 'migrations'),
      ]);
      expect(verify.status).toBe(65);
      expect(verify.stdout).toContain('FAIL migration history matches the code');
    } finally {
      psql(MAINTENANCE_DB, 'DROP DATABASE IF EXISTS palcert_stale_drill;');
    }
  }, 300_000);

  it('refuses to back up with a role that cannot read every row', () => {
    // A backup role without bypass capability does not quietly produce an
    // archive with 64 empty tables; PostgreSQL stops it and names the reason.
    const probe = 'palcert_neg_probe';
    const database = new URL(SOURCE_DB.replace(/[?&]schema=[^&]*/g, '')).pathname.replace(
      /^\//,
      '',
    );
    const cleanup = (): void => {
      for (const sql of [
        `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${probe};`,
        `REVOKE ALL ON SCHEMA public FROM ${probe};`,
        `REVOKE ALL ON DATABASE "${database}" FROM ${probe};`,
        `DROP ROLE IF EXISTS ${probe};`,
      ]) {
        try {
          psql(SOURCE_DB, sql);
        } catch {
          // The role may not exist; that is the desired end state anyway.
        }
      }
    };
    cleanup();
    psql(SOURCE_DB, `CREATE ROLE ${probe} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'probe';`);
    psql(SOURCE_DB, `GRANT CONNECT ON DATABASE "${database}" TO ${probe};`);
    psql(SOURCE_DB, `GRANT USAGE ON SCHEMA public TO ${probe};`);
    psql(SOURCE_DB, `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${probe};`);
    try {
      const probeUrl = new URL(SOURCE_DB.replace(/[?&]schema=[^&]*/g, ''));
      probeUrl.username = probe;
      probeUrl.password = 'probe';
      const result = runTool('backup.mjs', ['--out', path.join(workDir, 'no-bypass')], {
        DATABASE_ADMIN_URL: probeUrl.toString(),
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toMatch(/row-level security/i);
    } finally {
      cleanup();
    }
  }, 180_000);

  it('refuses when the object store will not serve it', () => {
    // Credential *rejection* specifically cannot be exercised here: the local
    // S3 mock accepts any credentials, so a wrong secret would produce a green
    // test that proves nothing. What is provable, and what matters, is that
    // the tool stops rather than writing a partial archive when the store
    // refuses — so the store is made genuinely unreachable instead.
    const result = runTool('backup.mjs', ['--out', path.join(workDir, 'unreachable-store')], {
      STORAGE_ENDPOINT: 'http://127.0.0.1:9',
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/test-secret-key/);
  }, 180_000);

  it('refuses when a bucket it was pointed at does not exist', () => {
    const result = runTool('backup.mjs', ['--out', path.join(workDir, 'no-bucket')], {
      STORAGE_DERIVED_BUCKET: 'palcert-bucket-that-does-not-exist',
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/bucket/i);
  }, 180_000);

  it('refuses when required configuration is absent', () => {
    const result = runTool('backup.mjs', ['--out', path.join(workDir, 'no-config')], {
      STORAGE_BUCKET: '',
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toContain('Missing object-store configuration');
  }, 60_000);
});

function runTool2(url: string): RunResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      [path.join(REPO, 'packages', 'database', 'scripts', 'check-migrations.mjs'), '--url', url],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const details = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: details.status ?? 1,
      stdout: details.stdout ?? '',
      stderr: details.stderr ?? '',
    };
  }
}
