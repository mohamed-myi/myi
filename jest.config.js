const path = require('path');

module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  setupFiles: ['<rootDir>/tests/setupEnv.js'],
  collectCoverageFrom: ['app.js'],
  clearMocks: true,
  coverageDirectory: 'coverage',
  testSequencer: path.join(__dirname, 'node_modules/@jest/test-sequencer/build/index.js')
};

