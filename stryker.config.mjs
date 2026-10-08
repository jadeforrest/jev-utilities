// StrykerJS mutation testing — the deferred "slow pass" (see ~/.claude/CLAUDE.md).
// Run after merging with `npm run test:mutation`; land findings as a follow-up commit.
// The suite is node:test under tsx, which no Stryker runner plugin supports, so
// the command runner re-runs the whole (fast) suite per mutant.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'command',
  commandRunner: { command: 'npx tsx --test test/*.test.ts' },
  mutate: ['src/**/*.ts', '!src/index.ts'],
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  coverageAnalysis: 'off',
  concurrency: 6,
  timeoutMS: 15000,
  reporters: ['clear-text', 'progress', 'json'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
};
