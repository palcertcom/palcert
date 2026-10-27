/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: '.*\\.e2e-spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  testTimeout: 30000,
  // Suites share one database and queue, so exactly one may run at a time.
  // Use a child worker rather than --runInBand: recycle its retained Nest /
  // ts-jest heap between suites instead of accumulating it for the whole run.
  maxWorkers: 1,
  workerIdleMemoryLimit: '768MB',
  // Stop on the first failed suite. The lifecycle guard keeps an abandoned
  // hook out of the next test; bail keeps one failure readable at the top.
  bail: 1,
  // Refuses to start against a database behind the code. See test/global-setup.ts.
  globalSetup: '<rootDir>/test/global-setup.ts',
  // Runs every hook and test as a phase, and refuses HTTP and database calls
  // from one Jest abandoned at its deadline. See test/support/lifecycle.ts.
  setupFilesAfterEnv: ['<rootDir>/test/support/lifecycle-setup.ts'],
};
