import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AbandonedPhaseError, PhaseTracker } from './support/lifecycle';

/**
 * The e2e harness's own lifecycle guarantees (see support/lifecycle.ts).
 *
 * A setup hook that overran its deadline on a slow runner kept creating users
 * while the next test truncated the tables, and the run failed on a foreign-key
 * violation instead of on the timeout. These tests pin the fix: an abandoned
 * phase is refused new work, and its in-flight work is drained before the next
 * reset.
 */
describe('Test harness lifecycle (e2e)', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function newTracker(reports: string[] = []): PhaseTracker {
    return new PhaseTracker({
      slowPhaseMs: Number.POSITIVE_INFINITY,
      report: (message) => reports.push(message),
      testName: () => undefined,
    });
  }

  it('refuses new work from a phase that was still running when the next began', async () => {
    const reports: string[] = [];
    const tracker = newTracker(reports);
    let wake!: () => void;
    const asleep = new Promise<void>((resolve) => (wake = resolve));

    const abandoned = tracker.run('beforeEach', async () => {
      await asleep;
      tracker.beginOperation('HTTP request');
    });
    await tracker.run('test', async () => {
      tracker.beginOperation('database query')();
    });
    wake();

    await expect(abandoned).rejects.toBeInstanceOf(AbandonedPhaseError);
    expect(reports.join('\n')).toContain('beforeEach was abandoned');
    // Teardown that must run regardless is never refused.
    expect(() => tracker.outside(() => tracker.assertLive('closing the app'))).not.toThrow();
  });

  it('leaves work started by a phase that settled normally alone', async () => {
    const tracker = newTracker();
    let background!: Promise<void>;
    await tracker.run('beforeAll', async () => {
      // e.g. a queue consumer started during boot keeps running afterwards.
      background = sleep(20).then(() => tracker.beginOperation('database query')());
    });
    await tracker.run('test', async () => background);
  });

  it('drains in-flight work of an abandoned phase, and names it if it never finishes', async () => {
    const tracker = newTracker();
    let finish!: () => void;
    let wake!: () => void;
    const asleep = new Promise<void>((resolve) => (wake = resolve));
    const abandoned = tracker.run('beforeEach', async () => {
      finish = tracker.beginOperation('HTTP request');
      await asleep;
    });
    tracker.run('next beforeEach', () => undefined);

    await expect(tracker.waitForAbandonedWork(50)).rejects.toThrow(
      'abandoned work still in flight after 50 ms: beforeEach (1)',
    );

    let drained = false;
    const drain = tracker.waitForAbandonedWork(5_000).then(() => (drained = true));
    await sleep(50);
    expect(drained).toBe(false);
    finish();
    await drain;
    expect(drained).toBe(true);
    wake();
    await abandoned;
  });

  it('fences off a real setup hook Jest abandoned, so the next test starts clean', () => {
    const apiRoot = path.resolve(__dirname, '..');
    const workDir = mkdtempSync(path.join(tmpdir(), 'palcert-lifecycle-'));
    const outcomeFile = path.join(workDir, 'outcome.json');
    const resultsFile = path.join(workDir, 'results.json');
    try {
      const child = spawnSync(
        process.execPath,
        [
          require.resolve('jest/bin/jest'),
          '--config',
          path.join(apiRoot, 'jest-e2e.config.js'),
          // The config's bail exits before results are written, and would also
          // hide a handle that keeps the process alive.
          '--bail=0',
          '--json',
          `--outputFile=${resultsFile}`,
          '--testRegex=abandoned-hook\\.fixture\\.ts$',
          '--runTestsByPath',
          path.join(apiRoot, 'test', 'fixtures', 'abandoned-hook.fixture.ts'),
        ],
        {
          cwd: apiRoot,
          encoding: 'utf8',
          env: { ...process.env, PALCERT_LIFECYCLE_FIXTURE_OUTCOME: outcomeFile },
          // Exiting on its own proves no handle outlived the abandoned hook.
          // The bound only catches a child that never exits; it is generous
          // because a cold child Jest on a busy shared runner is slow to boot.
          timeout: 300_000,
        },
      );
      const transcript = `${child.stdout}\n${child.stderr}`;
      expect({ signal: child.signal, status: child.status }).toEqual({ signal: null, status: 1 });

      const results = JSON.parse(readFileSync(resultsFile, 'utf8')) as {
        testResults: Array<{
          assertionResults: Array<{ title: string; status: string; failureMessages: string[] }>;
        }>;
      };
      const tests = results.testResults.flatMap((suite) => suite.assertionResults);
      const byTitle = (title: string) => tests.find((test) => test.title === title);
      expect(byTitle('fails at its own deadline')?.status).toBe('failed');
      expect(byTitle('fails at its own deadline')?.failureMessages.join('\n')).toContain(
        'Exceeded timeout of 1000 ms for a hook',
      );
      expect(byTitle('owns a database the abandoned setup can no longer write into')?.status).toBe(
        'passed',
      );

      expect(JSON.parse(readFileSync(outcomeFile, 'utf8'))).toEqual({
        http: 'refused',
        database: 'refused',
        usersSeenByNextTest: '0',
      });
      expect(transcript).toContain('[test-lifecycle] beforeEach of "abandoned hook fixture');
      expect(transcript).not.toContain('foreign key constraint');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 330_000);
});
