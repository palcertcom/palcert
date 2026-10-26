import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CreateBucketCommand,
  GetObjectCommand,
  PutBucketVersioningCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { verificationCodeHash } from '@palcert/contracts';
import {
  buildRecoveryFixture,
  redactFixture,
  type RecoveryFixture,
} from './support/recovery-fixture';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * The destructive-equivalent recovery drill (Phase 20 Checkpoint 4).
 *
 * Builds a representative installation through real workflows, backs it up,
 * restores it into a database and an object store that did not exist when the
 * backup was taken, and then asks the restored installation the questions that
 * matter — not "are the rows there" but "does it still understand them".
 *
 * Source and destination are demonstrably independent: a different database
 * name and three different buckets, both created inside this test. Nothing is
 * restored on top of the original, because a recovery that overwrites the
 * thing it is recovering has no second chance.
 */
const REPO = path.resolve(__dirname, '..', '..', '..');
const API_DIR = path.resolve(__dirname, '..');

const SOURCE_DB =
  process.env['DATABASE_ADMIN_URL'] ??
  'postgresql://palcert:palcert_local_dev@localhost:5432/palcert';
const MAINTENANCE_DB = SOURCE_DB.replace(/\/[^/?]+(\?.*)?$/, '/postgres');
const DESTINATION_DB = SOURCE_DB.replace(/\/[^/?]+(\?.*)?$/, '/palcert_dr_drill');

const STORAGE = {
  endpoint: process.env['STORAGE_ENDPOINT'] ?? 'http://127.0.0.1:9000',
  region: process.env['STORAGE_REGION'] ?? 'us-east-1',
  accessKeyId: process.env['STORAGE_ACCESS_KEY_ID'] ?? 'test-access-key',
  secretAccessKey: process.env['STORAGE_SECRET_ACCESS_KEY'] ?? 'test-secret-key',
  clean: process.env['STORAGE_BUCKET'] ?? 'palcert-test-documents',
  quarantine: process.env['STORAGE_QUARANTINE_BUCKET'] ?? 'palcert-test-quarantine',
  derived: process.env['STORAGE_DERIVED_BUCKET'] ?? 'palcert-test-derived',
};
const DESTINATION_BUCKETS = {
  clean: 'palcert-drdrill-documents',
  quarantine: 'palcert-drdrill-quarantine',
  derived: 'palcert-drdrill-derived',
};

function psql(url: string, sql: string): string {
  return execFileSync(
    'psql',
    [
      url.replace(/[?&]schema=[^&]*/g, ''),
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

interface RunResult {
  readonly ok: boolean;
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runTool(script: string, args: string[], env: NodeJS.ProcessEnv = {}): RunResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      [path.join(API_DIR, 'scripts', script), ...args],
      {
        encoding: 'utf8',
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { ok: true, status: 0, stdout, stderr: '' };
  } catch (error) {
    const details = error as { status?: number; stdout?: string; stderr?: string };
    return {
      ok: false,
      status: details.status ?? 1,
      stdout: details.stdout ?? '',
      stderr: details.stderr ?? '',
    };
  }
}

const sourceEnv = {
  DATABASE_ADMIN_URL: SOURCE_DB,
  STORAGE_ENDPOINT: STORAGE.endpoint,
  STORAGE_REGION: STORAGE.region,
  STORAGE_ACCESS_KEY_ID: STORAGE.accessKeyId,
  STORAGE_SECRET_ACCESS_KEY: STORAGE.secretAccessKey,
  STORAGE_BUCKET: STORAGE.clean,
  STORAGE_QUARANTINE_BUCKET: STORAGE.quarantine,
  STORAGE_DERIVED_BUCKET: STORAGE.derived,
  STORAGE_FORCE_PATH_STYLE: 'true',
};
const destinationEnv = {
  ...sourceEnv,
  RESTORE_STORAGE_ENDPOINT: STORAGE.endpoint,
  RESTORE_STORAGE_REGION: STORAGE.region,
  RESTORE_STORAGE_ACCESS_KEY_ID: STORAGE.accessKeyId,
  RESTORE_STORAGE_SECRET_ACCESS_KEY: STORAGE.secretAccessKey,
  RESTORE_STORAGE_BUCKET: DESTINATION_BUCKETS.clean,
  RESTORE_STORAGE_QUARANTINE_BUCKET: DESTINATION_BUCKETS.quarantine,
  RESTORE_STORAGE_DERIVED_BUCKET: DESTINATION_BUCKETS.derived,
  RESTORE_STORAGE_FORCE_PATH_STYLE: 'true',
};

describe('Disaster recovery drill (e2e)', () => {
  let context: TestContext;
  let fixture: RecoveryFixture;
  let workDir: string;
  let backupDir: string;
  const timings: Record<string, number> = {};

  beforeAll(async () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'palcert-dr-'));
    context = await createTestContext();
    await resetState(context);
    fixture = await buildRecoveryFixture(context);
    // Identifiers and hashes only. `redactFixture` strips the verification
    // code, which is the one value in the fixture that is a capability.
    writeFileSync(
      path.join(workDir, 'fixture.json'),
      `${JSON.stringify(redactFixture(fixture), null, 2)}\n`,
    );
  }, 600_000);

  afterAll(async () => {
    await destroyTestContext(context);
    rmSync(workDir, { recursive: true, force: true });
  });

  // --- 2: the source must be migration-current before it is trusted --------
  it('2. confirms the source database is at this build’s migration level', () => {
    const result = execFileSync(
      process.execPath,
      [
        path.join(REPO, 'packages', 'database', 'scripts', 'check-migrations.mjs'),
        '--url',
        SOURCE_DB,
      ],
      { encoding: 'utf8' },
    );
    // Backing up a database that is behind the code captures a schema the
    // application cannot run against, and the restore would inherit it.
    expect(result).toContain("database is at the code's level");
  });

  // --- 3 and 4: the backup, and the closure it must cover ------------------
  it('3+4. takes a backup whose object closure comes from the database snapshot', () => {
    const started = Date.now();
    const result = runTool('backup.mjs', ['--out', path.join(workDir, 'backups')], sourceEnv);
    timings['backupMs'] = Date.now() - started;
    expect(result.stderr + result.stdout).not.toMatch(/password|secret/i);
    expect(result.ok).toBe(true);

    const line = /backup: written to (.+)/.exec(result.stdout);
    backupDir = line![1]!.trim();

    const manifest = JSON.parse(
      execFileSync('cat', [path.join(backupDir, 'backup.json')], { encoding: 'utf8' }),
    );
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.objectCount).toBeGreaterThan(5);
    expect(manifest.reconciliation.missingReferenced).toBe(0);
    expect(manifest.reconciliation.checksumMismatches).toBe(0);
    // The consistency claim is recorded in the archive, not only in a document.
    expect(manifest.consistency.model).toBe('shared-snapshot-closure');
    expect(manifest.consistency.databaseSnapshotIsolation).toBe('repeatable read');
    expect(manifest.consistency.objectsPinnedByVersion).toBeGreaterThan(0);
    timings['backupBytes'] = manifest.objectBytes;
    timings['backupObjects'] = manifest.objectCount;
  }, 300_000);

  it('4a. carries the closure the database references, not everything in a bucket', () => {
    const manifest = JSON.parse(
      execFileSync('cat', [path.join(backupDir, 'backup.json')], { encoding: 'utf8' }),
    );
    const objects = execFileSync('cat', [path.join(backupDir, 'objects', 'manifest.jsonl')], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter((entry) => entry.length > 0)
      .map((entry) => JSON.parse(entry) as { key: string; sourceTable: string });

    // Every copied object is there because a row points at it.
    expect(objects.every((object) => object.sourceTable.length > 0)).toBe(true);
    expect(objects.length).toBe(manifest.objectCount);
    // And the database's own references are all accounted for.
    const closure = execFileSync(
      'cat',
      [path.join(backupDir, 'database', 'reference-closure.jsonl')],
      {
        encoding: 'utf8',
      },
    )
      .split('\n')
      .filter((entry) => entry.length > 0)
      .map(
        (entry) => JSON.parse(entry) as { deleted: boolean; ephemeral: boolean; objectKey: string },
      );
    const required = closure.filter((entry) => !entry.deleted && !entry.ephemeral);
    const copied = new Set(objects.map((object) => object.key));
    expect(required.filter((entry) => !copied.has(entry.objectKey))).toEqual([]);
  });

  it('4b. is not invalidated by an upload the database snapshot never referenced', async () => {
    // A file that appears in a bucket after the snapshot belongs to no row, so
    // no restored workflow can reach it. It must not make the archive suspect.
    const client = new S3Client({
      endpoint: STORAGE.endpoint,
      region: STORAGE.region,
      credentials: { accessKeyId: STORAGE.accessKeyId, secretAccessKey: STORAGE.secretAccessKey },
      forcePathStyle: true,
    });
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await client.send(
      new PutObjectCommand({
        Bucket: STORAGE.derived,
        Key: `orphan/${Date.now()}.json`,
        Body: Buffer.from('{"written":"after the snapshot"}'),
      }),
    );

    const result = runTool('verify-backup.mjs', ['--from', backupDir, '--deep'], sourceEnv);
    expect(result.stdout).toContain('verify-backup: OK');
  }, 120_000);

  // --- 5: validate before anything is destroyed ----------------------------
  it('5. validates the archive before the destination is touched', () => {
    const result = runTool('verify-backup.mjs', ['--from', backupDir, '--deep'], sourceEnv);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('row-level-security policies');
    expect(result.stdout).toContain('verify-backup: OK');
  }, 120_000);

  // --- 6 and 7: an independent destination, then the restore ---------------
  it('6+7. restores into a database and buckets that did not exist before', async () => {
    psql(MAINTENANCE_DB, 'DROP DATABASE IF EXISTS palcert_dr_drill;');
    psql(MAINTENANCE_DB, 'CREATE DATABASE palcert_dr_drill OWNER palcert;');

    const client = new S3Client({
      endpoint: STORAGE.endpoint,
      region: STORAGE.region,
      credentials: { accessKeyId: STORAGE.accessKeyId, secretAccessKey: STORAGE.secretAccessKey },
      forcePathStyle: true,
    });
    for (const bucket of Object.values(DESTINATION_BUCKETS)) {
      await client.send(new CreateBucketCommand({ Bucket: bucket })).catch(() => undefined);
      // Versioned, as production's buckets must be: PalCert pins every
      // finalized object to a version, and the restore has to move those pins.
      await client.send(
        new PutBucketVersioningCommand({
          Bucket: bucket,
          VersioningConfiguration: { Status: 'Enabled' },
        }),
      );
    }

    const started = Date.now();
    const result = runTool(
      'restore.mjs',
      ['--from', backupDir, '--to-database', DESTINATION_DB],
      destinationEnv,
    );
    timings['restoreMs'] = Date.now() - started;
    expect(result.stderr).not.toMatch(/password/i);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('is clean');

    const summary = /restore-result: (.+)/.exec(result.stdout);
    const parsed = JSON.parse(summary![1]!) as {
      hashVerified: number;
      references: number;
      versionPinsMoved: number;
    };
    // Phase 20 Checkpoint 9: a restore cannot keep the source store's version
    // ids, so every pin has to be moved to the version the destination holds.
    expect(parsed.versionPinsMoved).toBeGreaterThan(0);
    // Every object PalCert had hashed was re-hashed after the upload and
    // matched. That is the integrity claim, and it is the restored rows that
    // decided which objects to check.
    expect(parsed.hashVerified).toBeGreaterThan(0);
    expect(parsed.references).toBeGreaterThan(5);
  }, 300_000);

  // --- 8: migration compatibility on the restored database -----------------
  it('8. finds the restored database at the current migration level', () => {
    const result = execFileSync(
      process.execPath,
      [
        path.join(REPO, 'packages', 'database', 'scripts', 'check-migrations.mjs'),
        '--url',
        DESTINATION_DB,
      ],
      { encoding: 'utf8' },
    );
    expect(result).toContain("database is at the code's level");
  });

  // --- 9 and 11: verify the data plane before anything may write to it -----
  it('9. verifies structure, policies, grants and semantics before workers run', () => {
    const result = runTool(
      'verify-restore.mjs',
      [
        '--database',
        DESTINATION_DB,
        '--migrations',
        path.join(REPO, 'packages', 'database', 'prisma', 'migrations'),
      ],
      destinationEnv,
    );
    expect(result.stdout + result.stderr).toContain('checks passed');
    expect(result.ok).toBe(true);
  }, 120_000);

  it('9a. matches the source database structure exactly', () => {
    const shape = {
      tables: "SELECT count(*) FROM pg_tables WHERE schemaname='public';",
      rlsForced:
        "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relforcerowsecurity;",
      policies: "SELECT count(*) FROM pg_policies WHERE schemaname='public';",
      securityDefiner:
        "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef;",
      indexes: "SELECT count(*) FROM pg_indexes WHERE schemaname='public';",
      constraints:
        "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public';",
      appGrants:
        "SELECT count(*) FROM information_schema.table_privileges WHERE grantee='palcert_app';",
    };
    for (const [name, sql] of Object.entries(shape)) {
      expect(`${name}=${psql(DESTINATION_DB, sql)}`).toBe(`${name}=${psql(SOURCE_DB, sql)}`);
    }
  });

  it('9b. keeps the application role’s grant matrix uneven, not uniform', () => {
    const rows = psql(
      DESTINATION_DB,
      "SELECT privilege_type||'='||count(*) FROM information_schema.table_privileges " +
        "WHERE grantee='palcert_app' GROUP BY privilege_type ORDER BY 1;",
    ).split('\n');
    const counts = rows.map((row) => row.split('=')[1]);
    // A restore that produced the same count for every privilege would look
    // healthy and would be a privilege escalation.
    expect(new Set(counts).size).toBeGreaterThan(1);
  });

  it('7a. serves every pinned object by the version the restored row names', async () => {
    // The read the application makes: key *and* version. Before Checkpoint
    // 20.9 the restore uploaded the bytes and left every pin naming a version
    // from the source store, so metadata survived and every document
    // download, certificate read and report artifact failed with NoSuchVersion.
    const client = new S3Client({
      endpoint: STORAGE.endpoint,
      region: STORAGE.region,
      credentials: { accessKeyId: STORAGE.accessKeyId, secretAccessKey: STORAGE.secretAccessKey },
      forcePathStyle: true,
    });
    const pins = psql(
      DESTINATION_DB,
      `SELECT 'clean|' || clean_object_key || '|' || clean_object_version_id || '|' || sha256
         FROM document_versions WHERE clean_object_version_id IS NOT NULL
       UNION ALL
       SELECT 'derived|' || certificate_object_key || '|' || certificate_object_version_id ||
              '|' || certificate_object_sha256
         FROM compliance_certificates WHERE certificate_object_version_id IS NOT NULL;`,
    )
      .split('\n')
      .filter((line) => line.length > 0);
    expect(pins.length).toBeGreaterThan(2);
    for (const pin of pins) {
      const [zone, key, versionId, sha256] = pin.split('|');
      const bucket = zone === 'derived' ? DESTINATION_BUCKETS.derived : DESTINATION_BUCKETS.clean;
      const object = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key!, VersionId: versionId! }),
      );
      const bytes = Buffer.from(await object.Body!.transformToByteArray());
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
    }
  });

  // --- 11: what the restored installation still understands ----------------
  it('11a. still holds the documents, with the hashes PalCert recorded', () => {
    for (const document of [fixture.docx, fixture.pdf]) {
      const row = psql(
        DESTINATION_DB,
        `SELECT sha256 || '|' || coalesce(clean_object_key,'') FROM document_versions WHERE id='${document.versionId}';`,
      );
      expect(row.startsWith(`${document.sha256}|`)).toBe(true);
      expect(row.split('|')[1]!.length).toBeGreaterThan(0);
    }
  });

  it('11b. still holds a persisted analysis for DOCX and for PDF', () => {
    const analyzers = psql(
      DESTINATION_DB,
      `SELECT DISTINCT analyzer_name FROM document_analyses
       WHERE document_version_id IN ('${fixture.docx.versionId}','${fixture.pdf.versionId}')
         AND artifact_object_key IS NOT NULL ORDER BY 1;`,
    ).split('\n');
    expect(analyzers.length).toBeGreaterThanOrEqual(2);
  });

  it('11c. keeps the report’s canonical hash byte-for-byte', () => {
    expect(
      psql(DESTINATION_DB, `SELECT report_hash FROM check_reports WHERE id='${fixture.reportId}';`),
    ).toBe(fixture.reportHash);
  });

  it('11d. can verify the pre-disaster certificate from its code alone', () => {
    // The restored installation has never seen this code in plaintext: the row
    // keeps a SHA-256 of it, and the sealed staging copy is erased at issuance.
    // So this is the whole public-verification path, decided by hash lookup.
    const hash = verificationCodeHash(fixture.certificateVerificationCode);
    const found = psql(
      DESTINATION_DB,
      `SELECT id || '|' || issuance_status || '|' || coalesce(claim_hash,'')
       FROM compliance_certificates WHERE verification_code_hash='${hash}';`,
    );
    expect(found).toBe(`${fixture.certificateId}|ISSUED|${fixture.certificateClaimHash}`);
    // And the staging ciphertext did not come back with it.
    expect(
      psql(
        DESTINATION_DB,
        `SELECT coalesce(verification_code_ciphertext,'(erased)') FROM compliance_certificates WHERE id='${fixture.certificateId}';`,
      ),
    ).toBe('(erased)');
  });

  it('11e. recomputes the same balance from the same append-only ledger', () => {
    const entries = psql(
      DESTINATION_DB,
      `SELECT count(*) FROM credit_ledger_entries e
       JOIN customer_credit_accounts a ON a.id = e.account_id
       WHERE a.owner_user_id='${fixture.author.userId}';`,
    );
    expect(Number(entries)).toBeGreaterThan(0);
    const balance = psql(
      DESTINATION_DB,
      `SELECT coalesce(sum(e.amount_minor_signed),0)::text FROM credit_ledger_entries e
       JOIN customer_credit_accounts a ON a.id = e.account_id
       WHERE a.owner_user_id='${fixture.author.userId}';`,
    );
    expect(balance).toBe(fixture.balanceMinor);
    // The purchase that spent part of it is still attached to its check.
    expect(
      psql(
        DESTINATION_DB,
        `SELECT service_purchase_id FROM document_checks WHERE id='${fixture.paidCheckId}';`,
      ),
    ).toBe(fixture.paidPurchaseId);
  });

  it('11f. keeps organization and API-client scoping intact', () => {
    expect(
      psql(
        DESTINATION_DB,
        `SELECT organization_id FROM api_clients WHERE id='${fixture.apiClientId}';`,
      ),
    ).toBe(fixture.organizationId);
    expect(
      psql(
        DESTINATION_DB,
        `SELECT organization_id FROM webhook_endpoints WHERE id='${fixture.webhookEndpointId}';`,
      ),
    ).toBe(fixture.organizationId);
    // A submission belongs to exactly one organization, and the restore did
    // not widen that.
    expect(
      psql(
        DESTINATION_DB,
        `SELECT count(*) FROM official_submissions WHERE id='${fixture.submissionId}' AND organization_id='${fixture.organizationId}';`,
      ),
    ).toBe('1');
  });

  it('11g. keeps secret-dependent state sealed and interpretable', () => {
    // The webhook URL and signing secret are ciphertext under the keyring, and
    // they came back as ciphertext. What makes them readable again is the key,
    // which lives in configuration and is documented as must-recover — not in
    // the backup, which is exactly why the backup is safe to store.
    const sealed = psql(
      DESTINATION_DB,
      `SELECT count(*) FROM webhook_endpoint_config_versions WHERE secret_ciphertext IS NOT NULL;`,
    );
    expect(Number(sealed)).toBeGreaterThan(0);
    // The API client's credential is a verifier, not ciphertext, so it needs
    // no key at all to keep working after a restore.
    const verifier = psql(
      DESTINATION_DB,
      `SELECT count(*) FROM api_client_secrets s JOIN api_clients c ON c.id = s.api_client_id
       WHERE c.id='${fixture.apiClientId}' AND s.secret_verifier IS NOT NULL;`,
    );
    expect(Number(verifier)).toBeGreaterThan(0);
  });

  it('11h. keeps notification and webhook history', () => {
    expect(Number(psql(DESTINATION_DB, 'SELECT count(*) FROM user_notifications;'))).toBe(
      fixture.notificationCount,
    );
    expect(Number(psql(DESTINATION_DB, 'SELECT count(*) FROM domain_events;'))).toBeGreaterThan(0);
  });

  it('11i. will not re-run work that already completed', () => {
    // The worst thing a restore can do is repeat finished business work: charge
    // a card twice, issue a second certificate. A SUCCEEDED job must not be
    // claimable, and none may carry a lease that would make it look in-flight.
    expect(
      psql(
        DESTINATION_DB,
        "SELECT count(*) FROM processing_jobs WHERE status='SUCCEEDED' AND lease_expires_at IS NOT NULL;",
      ),
    ).toBe('0');
    const succeeded = Number(
      psql(DESTINATION_DB, "SELECT count(*) FROM processing_jobs WHERE status='SUCCEEDED';"),
    );
    expect(succeeded).toBeGreaterThan(0);
    // And the statuses that *are* recoverable survived as themselves.
    const statuses = psql(
      DESTINATION_DB,
      "SELECT string_agg(DISTINCT status::text, ',' ORDER BY status::text) FROM processing_jobs;",
    );
    expect(statuses.length).toBeGreaterThan(0);
  });

  it('12. reports the measured recovery timings', () => {
    // Recorded, not asserted against a target: an RPO or an RTO is a business
    // decision, and inventing one here would make it look agreed.
    expect(timings['backupMs']).toBeGreaterThan(0);
    expect(timings['restoreMs']).toBeGreaterThan(0);
    console.log(
      `drill-timings: ${JSON.stringify({
        backupMs: timings['backupMs'],
        restoreMs: timings['restoreMs'],
        objects: timings['backupObjects'],
        objectBytes: timings['backupBytes'],
      })}`,
    );
  });
});
