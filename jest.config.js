const path = require('path');

module.exports = {
  testEnvironment: 'node', // WHY node: Testing backend Express app, not browser JavaScript
  testMatch: ['<rootDir>/tests/**/*.test.js'], // All .test.js files in tests/ directory
  setupFiles: ['<rootDir>/tests/setupEnv.js'], // Load test env vars before tests run (mocks SPOTIFY_CLIENT_ID, etc.)
  collectCoverageFrom: ['app.js'], // Track code coverage for main app file only
  clearMocks: true, // Reset mocks between tests to prevent test pollution
  coverageDirectory: 'coverage', // Output coverage reports to coverage/ directory
  testSequencer: path.join(__dirname, 'node_modules/@jest/test-sequencer/build/index.js') // WHY explicit sequencer: Ensures deterministic test order
};

