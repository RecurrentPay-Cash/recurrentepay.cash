/** Jest config for the CashScript contract test suite (ESM + TS). */
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
    // TS imports the generated artifacts with a `.js` specifier (NodeNext); map it back to `.ts`.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transformIgnorePatterns: ['node_modules/(?!(cashscript|cashc|@cashscript|@bitauth)/)'],
  testTimeout: 120_000,
};
