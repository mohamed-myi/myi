// Test environment setup - ensures valid env vars
process.env.NODE_ENV = 'test';
process.env.SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || 'test-client';
process.env.SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || 'test-secret';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.CALLBACK_URL = process.env.CALLBACK_URL || 'http://localhost:3000/callback';

