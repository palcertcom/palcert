import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * Prove the database is at this build's migration level before a single test
 * runs (Phase 20 Checkpoint 4).
 *
 * Checkpoint 20.3 reported a green end-to-end run against a database that was
 * missing that checkpoint's own migration. Four tests that should have failed
 * were recorded as evidence that the work was done. The suite had no way to
 * know, because nothing compared the migrations on disk with the migrations
 * in the database.
 *
 * Running once per Jest invocation rather than per suite: the schema cannot
 * change under a run, and a directory scan in `beforeEach` would be a cost
 * paid thousands of times to learn the same thing.
 */
export default function globalSetup(): void {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const checker = path.join(repoRoot, 'packages', 'database', 'scripts', 'check-migrations.mjs');
  const url =
    process.env['DATABASE_ADMIN_URL'] ??
    'postgresql://palcert:palcert_local_dev@localhost:5432/palcert';

  try {
    const output = execFileSync(process.execPath, [checker, '--url', url], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    process.stdout.write(`${output.trim()}\n`);
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string; status?: number };
    process.stderr.write(`${(details.stderr ?? '').trim()}\n`);
    throw new Error(
      'The end-to-end database is not at this build’s migration level, so a green run ' +
        'would not mean anything. Apply migrations (pnpm db:deploy) and try again.',
    );
  }
}
