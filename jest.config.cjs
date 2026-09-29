module.exports = {
  ...require('./jest.shared.cjs'),
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/**/*.d.ts'],
  coverageDirectory: '<rootDir>/coverage',
};
