import { writeFileSync } from 'node:fs';
import { registerAndVerify } from '../support/auth-client';
import { AbandonedPhaseError } from '../support/lifecycle';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from '../support/test-app';

/**
 * Run only by harness-lifecycle.e2e-spec.ts, in a child Jest, because its
 * first test is meant to fail: its setup overruns the deadline and then keeps
 * trying to write, which is exactly what a slow runner did to the revenue
 * suite. The parent reads the outcome file and the Jest results.
 */

// Read before `createTestContext` replaces the environment for the suite.
const outcomeFile = process.env['PALCERT_LIFECYCLE_FIXTURE_OUTCOME'];
const outcome: Record<string, string> = {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function attempt(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'allowed';
  } catch (error) {
    return error instanceof AbandonedPhaseError ? 'refused' : `failed: ${String(error)}`;
  }
}

describe('abandoned hook fixture', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
    if (outcomeFile !== undefined) writeFileSync(outcomeFile, JSON.stringify(outcome));
  });

  describe('a setup that overruns its deadline', () => {
    beforeEach(async () => {
      await sleep(1_500);
      // Jest gave up on this hook at 1 s. Everything below runs while the next
      // test is resetting the database and making its own fixtures.
      outcome.http = await attempt(() => registerAndVerify(context, 'late@example.test'));
      outcome.database = await attempt(() =>
        context.adminDb.user.create({
          data: {
            email: 'direct@example.test',
            normalizedEmail: 'direct@example.test',
            passwordHash: 'not-a-real-hash',
            passwordAlgorithm: 'argon2id',
          },
        }),
      );
    }, 1_000);

    it('fails at its own deadline', () => {
      // Never reached: the hook above fails first.
    });
  });

  describe('the test after it', () => {
    beforeEach(async () => {
      await resetState(context);
    });

    it('owns a database the abandoned setup can no longer write into', async () => {
      // The abandoned hook wakes inside this window and tries to write.
      await sleep(2_000);
      const users = await context.adminDb.user.count();
      outcome.usersSeenByNextTest = String(users);
      expect(users).toBe(0);
    });
  });
});
