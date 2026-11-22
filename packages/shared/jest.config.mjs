/** Jest config for the shared domain package (ESM + TS), mirroring packages/contracts. */
export default {
  rootDir: '.',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleFileExtensions: ['ts', 'js', 'mjs', 'json'],
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: '<rootDir>/tsconfig.json',
        diagnostics: true,
      },
    ],
  },
  moduleNameMapper: {
    // The workspace dependency `contracts` exposes its TS sources; map the
    // package specifier (and its `.js` specifiers) back to the source files.
    '^contracts/(.*)\\.js$': '<rootDir>/../contracts/$1.ts',
    '^contracts/(.*)$': '<rootDir>/../contracts/$1',
    '^contracts/artifacts/(.*)\\.artifact\\.js$': '<rootDir>/../contracts/artifacts/$1.artifact.ts',
    // TS imports with `.js` specifiers (NodeNext); map back to `.ts`.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transformIgnorePatterns: ['node_modules/(?!(cashscript|cashc|@cashscript|@bitauth)/)'],
  testTimeout: 120_000,
};
