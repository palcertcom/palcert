import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Jest abandons a hook or test at its deadline, but it cannot cancel the
 * promise. The abandoned function keeps running into the next test: a
 * `beforeEach` that timed out halfway through creating fixtures carried on
 * signing people in while the following test's `resetState` truncated the
 * tables under it, and the next failure was a foreign-key violation that had
 * nothing to do with the code under test.
 *
 * Every hook and test therefore runs inside its own *phase*, carried through
 * its awaits by AsyncLocalStorage. Jest runs phases one at a time, so a phase
 * still running when the next one begins can only be one Jest has given up on.
 * It is marked abandoned, and from then on its HTTP requests and database
 * queries are refused at the point they would start, so it stops at its next
 * await instead of writing into the next test. Work it already had in flight
 * is counted, and `resetState` waits for that count to reach zero before it
 * truncates anything.
 *
 * Nothing here extends a deadline: a phase that overruns still fails exactly
 * as before. What changes is that its failure stays its own.
 */

export class AbandonedPhaseError extends Error {
  constructor(
    readonly phase: string,
    readonly operation: string,
  ) {
    super(
      `${operation} refused: ${phase} was abandoned by Jest at its deadline, ` +
        'so it may no longer touch state the next test owns',
    );
    this.name = 'AbandonedPhaseError';
  }
}

interface Phase {
  readonly label: string;
  readonly startedAt: number;
  state: 'running' | 'settled' | 'abandoned';
  inFlight: number;
}

export interface PhaseTrackerOptions {
  /** Phases slower than this are reported, so a slow host is visible. */
  readonly slowPhaseMs: number;
  readonly report: (message: string) => void;
  /** The running test's full name, for labels. */
  readonly testName: () => string | undefined;
}

export class PhaseTracker {
  private readonly storage = new AsyncLocalStorage<Phase>();
  private current: Phase | undefined;
  private readonly abandoned = new Set<Phase>();

  constructor(private readonly options: PhaseTrackerOptions) {}

  /** Run `fn` as the next phase; whatever phase was still running is abandoned. */
  run<T>(kind: string, fn: () => T): T {
    const phase = this.begin(kind);
    let result: T;
    try {
      result = this.storage.run(phase, fn);
    } catch (error) {
      this.settle(phase);
      throw error;
    }
    if (isPromiseLike(result)) {
      return Promise.resolve(result).finally(() => this.settle(phase)) as T;
    }
    this.settle(phase);
    return result;
  }

  /**
   * Run a callback-style body as the next phase, settling when `done` fires.
   */
  runWithDone(
    kind: string,
    body: (done: (...args: unknown[]) => void) => unknown,
    done: (...args: unknown[]) => void,
  ): unknown {
    const phase = this.begin(kind);
    try {
      return this.storage.run(phase, () =>
        body((...args: unknown[]) => {
          this.settle(phase);
          done(...args);
        }),
      );
    } catch (error) {
      this.settle(phase);
      throw error;
    }
  }

  /** Run cleanup outside any phase, so it is never refused by the guard. */
  outside<T>(fn: () => T): T {
    return this.storage.exit(fn);
  }

  /** Throw if the calling code belongs to a phase Jest has abandoned. */
  assertLive(operation: string): void {
    const phase = this.storage.getStore();
    if (phase?.state === 'abandoned') throw new AbandonedPhaseError(phase.label, operation);
  }

  /**
   * Count an operation against the calling phase until the returned function
   * runs. Refuses outright when the phase is already abandoned, so the count
   * only ever covers work that started while its phase was live.
   */
  beginOperation(operation: string): () => void {
    this.assertLive(operation);
    const phase = this.storage.getStore();
    if (phase === undefined) return () => undefined;
    phase.inFlight += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      phase.inFlight -= 1;
      this.forgetIfQuiet(phase);
    };
  }

  /**
   * Wait until nothing an abandoned phase started is still in flight.
   *
   * Bounded: if the work never finishes, the caller fails naming it instead of
   * running on top of it.
   */
  async waitForAbandonedWork(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const busy = [...this.abandoned].filter((phase) => phase.inFlight > 0);
      if (busy.length === 0) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `abandoned work still in flight after ${timeoutMs} ms: ` +
            busy.map((phase) => `${phase.label} (${phase.inFlight})`).join(', '),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private begin(kind: string): Phase {
    const previous = this.current;
    const now = Date.now();
    if (previous !== undefined && previous.state === 'running') {
      previous.state = 'abandoned';
      this.abandoned.add(previous);
      this.options.report(
        `${previous.label} was abandoned after ${now - previous.startedAt} ms with ` +
          `${previous.inFlight} operation(s) in flight; its further HTTP and database calls are refused`,
      );
    }
    const testName = this.options.testName();
    const phase: Phase = {
      label: testName === undefined ? kind : `${kind} of "${testName}"`,
      startedAt: now,
      state: 'running',
      inFlight: 0,
    };
    this.current = phase;
    return phase;
  }

  private settle(phase: Phase): void {
    const elapsed = Date.now() - phase.startedAt;
    if (phase.state === 'running') {
      phase.state = 'settled';
      if (elapsed >= this.options.slowPhaseMs) {
        this.options.report(`${phase.label} took ${elapsed} ms`);
      }
    } else if (phase.state === 'abandoned') {
      this.options.report(`${phase.label} finally settled ${elapsed} ms after it began`);
      this.forgetIfQuiet(phase);
    }
  }

  private forgetIfQuiet(phase: Phase): void {
    // It stays abandoned (its continuations are still refused); the drain just
    // stops waiting on it once nothing of it remains in flight.
    if (phase.state === 'abandoned' && phase.inFlight === 0) this.abandoned.delete(phase);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

// One tracker per test file, kept on the global object so the setup file and
// the helpers share it even if a module is ever evaluated twice.
const TRACKER_KEY = Symbol.for('palcert.test.lifecycle');

function tracker(): PhaseTracker {
  const holder = globalThis as unknown as Record<symbol, PhaseTracker | undefined>;
  return (holder[TRACKER_KEY] ??= new PhaseTracker({
    // Read once, here: `createTestContext` swaps in a hermetic environment for
    // the life of a suite, which would otherwise hide the setting mid-file.
    slowPhaseMs: (() => {
      const configured = Number(process.env['PALCERT_TEST_SLOW_PHASE_MS']);
      return Number.isFinite(configured) && configured >= 0 ? configured : 15_000;
    })(),
    // Straight to stderr: Jest's console buffering would print it after the
    // suite, detached from the failure it explains.
    report: (message) => process.stderr.write(`[test-lifecycle] ${message}\n`),
    testName: () =>
      (
        globalThis as { expect?: { getState?: () => { currentTestName?: string } } }
      ).expect?.getState?.().currentTestName,
  }));
}

export function assertPhaseLive(operation: string): void {
  tracker().assertLive(operation);
}

/** `resetState` and teardown call this before touching shared state. */
export function waitForAbandonedWork(timeoutMs: number): Promise<void> {
  return tracker().waitForAbandonedWork(timeoutMs);
}

export function outsidePhase<T>(fn: () => T): T {
  return tracker().outside(fn);
}

type Callable = (this: unknown, ...args: unknown[]) => unknown;

/**
 * Wrap a hook or test body so it runs as a phase.
 *
 * Arity is preserved because Jest reads it: a function declaring a parameter
 * is called with a `done` callback, and the phase then settles when that
 * callback fires rather than when the function returns.
 */
function guard(kind: string, fn: unknown, takesDone: boolean): unknown {
  if (typeof fn !== 'function') return fn;
  const body = fn as Callable;
  const guarded = function (this: unknown, ...args: unknown[]): unknown {
    if (takesDone && body.length > 0 && typeof args[0] === 'function') {
      return tracker().runWithDone(
        kind,
        (done) => body.call(this, done),
        args[0] as (...doneArgs: unknown[]) => void,
      );
    }
    return tracker().run(kind, () => body.apply(this, args));
  };
  Object.defineProperty(guarded, 'length', { value: body.length });
  return guarded;
}

type TestFunction = ((name: string, fn?: unknown, timeout?: number) => unknown) & {
  only?: TestFunction;
  each?: (...table: unknown[]) => (name: string, fn?: unknown, timeout?: number) => unknown;
};

function guardTestFunction(original: TestFunction): TestFunction {
  const wrap = (target: TestFunction): TestFunction => {
    const wrapped = function (this: unknown, name: string, fn?: unknown, timeout?: number) {
      return target.call(this, name, guard('test', fn, true), timeout);
    } as TestFunction;
    Object.assign(wrapped, target);
    if (typeof target.each === 'function') {
      const each = target.each.bind(target);
      wrapped.each = (...table: unknown[]) => {
        const bound = each(...table);
        // Rows arrive as arguments here, so `done` detection stays with Jest.
        return (name: string, fn?: unknown, timeout?: number) =>
          bound(name, guard('test', fn, false), timeout);
      };
    }
    return wrapped;
  };

  const wrapped = wrap(original);
  if (typeof original.only === 'function') wrapped.only = wrap(original.only);
  return wrapped;
}

type HookFunction = (fn: unknown, timeout?: number) => unknown;

/**
 * Install the guard: phase every hook and test, and refuse HTTP requests and
 * database queries from abandoned phases.
 *
 * Called once per test file from the e2e `setupFilesAfterEnv`.
 */
export function installLifecycleGuard(patches: {
  readonly supertestTest: { prototype: object };
  readonly prismaClient: { prototype: object };
}): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const hook of ['beforeAll', 'beforeEach', 'afterEach', 'afterAll']) {
    const original = globals[hook] as HookFunction;
    globals[hook] = (fn: unknown, timeout?: number) => original(guard(hook, fn, true), timeout);
  }
  for (const name of ['it', 'test']) {
    globals[name] = guardTestFunction(globals[name] as TestFunction);
  }

  patchSupertest(patches.supertestTest);
  patchPrisma(patches.prismaClient);
}

const PATCHED = Symbol.for('palcert.test.lifecycle.patched');

function patchSupertest(Test: { prototype: object }): void {
  const prototype = Test.prototype as { end: (fn: unknown) => unknown; [PATCHED]?: true };
  if (typeof prototype.end !== 'function') {
    throw new Error('test lifecycle guard: supertest Test no longer has end()');
  }
  if (prototype[PATCHED]) return;
  const end = prototype.end;
  prototype.end = function (
    this: { _server?: { _handle?: unknown; close: () => void } },
    fn: unknown,
  ) {
    const callback = typeof fn === 'function' ? (fn as (...args: unknown[]) => void) : undefined;
    let finished: () => void;
    try {
      finished = tracker().beginOperation('HTTP request');
    } catch (error) {
      // The request listened on an ephemeral port when it was built; release
      // it, or the refused request becomes an open handle.
      if (this._server?._handle) this._server.close();
      process.nextTick(() => callback?.(error));
      return this;
    }
    return end.call(this, (...args: unknown[]) => {
      finished();
      callback?.(...args);
    });
  };
  prototype[PATCHED] = true;
}

/**
 * Every Prisma operation — model calls, raw SQL, both sides of a transaction —
 * funnels through the client's `_request`, and it runs when the operation is
 * awaited, inside the awaiting phase. That is the one place a dead phase's
 * query can be refused before it reaches the database, whichever client
 * (owner, request path, or the application's own) it was issued on.
 */
function patchPrisma(PrismaClient: { prototype: object }): void {
  let prototype = PrismaClient.prototype as Record<string | symbol, unknown> | null;
  while (prototype !== null && !Object.prototype.hasOwnProperty.call(prototype, '_request')) {
    prototype = Object.getPrototypeOf(prototype) as Record<string | symbol, unknown> | null;
  }
  if (prototype === null || typeof prototype['_request'] !== 'function') {
    // A Prisma upgrade moved the funnel. Fail loudly rather than run every
    // suite with the guard silently off.
    throw new Error('test lifecycle guard: PrismaClient no longer exposes _request');
  }
  if (prototype[PATCHED]) return;
  const request = prototype['_request'] as (this: unknown, params: unknown) => unknown;
  prototype['_request'] = function (this: unknown, params: unknown) {
    const finished = tracker().beginOperation('database query');
    let pending: unknown;
    try {
      pending = request.call(this, params);
    } catch (error) {
      finished();
      throw error;
    }
    Promise.resolve(pending).then(finished, finished);
    return pending;
  };
  prototype[PATCHED] = true;
}
