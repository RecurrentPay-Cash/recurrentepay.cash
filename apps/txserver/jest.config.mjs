/** Jest config for the txserver (ESM + TS), mirroring packages/contracts. */
export default {
  rootDir: '.',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleFileExtensions: ['ts', 'js', 'mjs', 'json'],
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  transform: {
    '^.+\\.(ts|js|mjs)$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: '<rootDir>/tsconfig.json',
        diagnostics: true,
      },
    ],
  },
  moduleNameMapper: {
    // The workspace dependency `shared` exposes its TS sources.
    '^shared/(.*)\\.js$': '<rootDir>/../../packages/shared/src/$1.ts',
    '^shared$': '<rootDir>/../../packages/shared/src/index.ts',
    '^contracts/(.*)\\.js$': '<rootDir>/../../packages/contracts/$1.ts',
    '^contracts/(.*)$': '<rootDir>/../../packages/contracts/$1',
    // The compiled artifact is a `.ts` module; map its `.js` specifier.
    '^contracts/artifacts/(.*)\\.artifact\\.js$': '<rootDir>/../../packages/contracts/artifacts/$1.artifact.ts',
    // TS imports with `.js` specifiers (NodeNext); map back to `.ts`.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transformIgnorePatterns: ['node_modules/(?!(cashscript|cashc|@cashscript|@bitauth|@electrum-cash)/)'],
  testTimeout: 120_000,
};
