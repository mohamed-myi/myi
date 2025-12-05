// Test environment configuration - Loaded before any tests run
// WHY: Ensures tests have valid env vars even if .env file doesn't exist
// Uses real env vars if available (for integration tests), falls back to mock values
process.env.NODE_ENV = 'test'; // Disables background intervals, enables test-specific behavior
process.env.SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || 'test-client'; // 32-char Spotify client ID
process.env.SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || 'test-secret'; // Spotify client secret
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session'; // Express session secret
process.env.CALLBACK_URL = process.env.CALLBACK_URL || 'http://localhost:3000/callback'; // OAuth callback URL

