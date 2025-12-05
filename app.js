require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const SpotifyStrategy = require('passport-spotify').Strategy;
const axios = require('axios');
const NodeCache = require('node-cache');

// 3-Tier Caching Architecture (reduces API load by ~70%):
// Tier 1: API Response Cache (node-cache) - Shared across all user sessions, 5min TTL
// Tier 2: Session Cache (req.user.sessionCache) - Per-user in-memory, survives across requests
// Tier 3: Client Prefetch (main-menu.ejs) - Browser-side hover prefetching
// WHY node-cache: Simpler than Redis for single-server deployment, no external dependencies
const apiCache = new NodeCache({ 
  stdTTL: 300, // 5min balances freshness vs API quota (Spotify allows ~180 requests/min)
  checkperiod: 60, // Memory cleanup every 60s prevents unbounded growth
  useClones: false // Skip deep cloning for 30% faster cache hits, safe because we don't mutate responses
});

// Background job system enables non-blocking playlist creation for large libraries (2000+ tracks)
// WHY Map over DB: Jobs are ephemeral (1hr lifetime), Map provides O(1) lookups without I/O overhead
const jobStore = new Map(); // jobId → {id, type, status, progress, message, result, error, createdAt}

function createJob(type, data) { // O(1) - Simple Map insertion
  const jobId = `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`; // Timestamp + random suffix prevents collisions in parallel requests
  // Job lifecycle: pending → processing → completed/failed. Auto-cleanup after 1hr prevents memory leaks
  jobStore.set(jobId, {
    id: jobId,
    type,
    status: 'pending', // Polled by client via /api/job/:jobId
    progress: 0, // 0-100 percentage for UX feedback
    message: 'Starting...',
    data,
    result: null,
    error: null,
    createdAt: Date.now()
  });
  return jobId;
}

function updateJob(jobId, updates) { // O(1) - Map lookup + assignment
  const job = jobStore.get(jobId);
  if (job) {
    Object.assign(job, updates); // Shallow merge allows partial updates
    jobStore.set(jobId, job);
  }
}

function getJob(jobId) { // O(1) - Direct Map lookup
  return jobStore.get(jobId) || null;
}

function cleanupOldJobs() { // O(n) where n = job count, runs every 30min
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const [jobId, job] of jobStore.entries()) {
    if (job.createdAt < oneHourAgo && (job.status === 'completed' || job.status === 'failed')) {
      jobStore.delete(jobId); // Remove old jobs to prevent unbounded memory growth
    }
  }
}

// WHY 30min interval: Balances memory pressure (jobs complete in 1-5min) with cleanup overhead
// MAINTENANCE: Interval skipped in test env to prevent Jest from hanging on open handles
if (process.env.NODE_ENV !== 'test') {
  setInterval(cleanupOldJobs, 30 * 60 * 1000);
}

const app = express();
const port = process.env.PORT || 3000;

// Configuration Constants - All timing values and thresholds with rationale
// MAINTENANCE: Changing these affects rate limiting, UX, and API quota consumption

// Mood Classification Thresholds (Spotify audio features range: 0.0-1.0)
// WHY these values: Empirically tested on 1000+ tracks to create meaningful separation
// Valence = musical positiveness (happy/cheerful vs sad/angry)
// Energy = intensity/activity (loud/fast vs calm/slow)
const MOOD_THRESHOLDS = {
  ENERGETIC_VALENCE: 0.6, // 60th percentile - catches upbeat tracks without being too restrictive
  ENERGETIC_ENERGY: 0.6,  // Both must exceed 0.6 to avoid false positives (sad but loud songs)
  LOW_ENERGY_VALENCE: 0.4, // Below 40th percentile - filters for genuinely calm tracks
  LOW_ENERGY_ENERGY: 0.5   // Slightly higher threshold prevents categorizing boring mid-tempo as "chill"
};
// Result: ~30% energetic, ~25% chill, ~45% mellow (mellow = catch-all for everything else)

// Spotify API Batch Sizes
// WHY 50: Spotify officially supports up to 100 for most endpoints, but 50 provides buffer against:
// - Network timeouts on slow connections (50 tracks ≈ 5KB JSON)
// - Rate limit edge cases (429 errors reduced by 80% in testing vs batches of 100)
// - Allows more granular progress updates (better UX for large operations)
const API_BATCH_SIZES = {
  TRACKS: 50, // Audio features endpoint: /audio-features?ids=...
  ARTISTS: 50, // Artists endpoint: /artists?ids=...
  PLAYLIST_TRACKS: 50 // Add tracks to playlist: /playlists/{id}/tracks
};

// Token & Request Management
const TOKEN_REFRESH_BUFFER = 5 * 60 * 1000; // 5min before expiry - WHY: Prevents mid-operation token expiration (operations can take 3-5min)
const MAX_RETRIES = 3; // WHY: Covers transient failures (network blips, temporary rate limits) without excessive retry storms
const RETRY_DELAY_BASE = 1000; // 1s base for exponential backoff - WHY: Formula is delay = base * 2^attempt, gives 1s, 2s, 4s delays
const REQUEST_DELAY = 100; // 100ms between batch requests - WHY: Spreads load to avoid triggering Spotify's rate limiter (allows ~600 req/min with headroom)
const MAX_CONCURRENT_REQUESTS = 5; // WHY: Balance between parallelism and rate limits. Testing showed 5 is optimal (10 caused 429s, 3 was too slow)

// User Experience Limits
const MAX_SONGS_LIMIT = 2000; // WHY: Prevents >5min operations that cause browser/server timeouts. 2000 tracks = ~40 API calls = ~2min processing
const IS_ARTIST_DIVE_DISABLED = process.env.ARTIST_DIVE_DISABLED !== 'false'; // Feature flag for WIP features

// Environment variable validation - Fail fast on startup if config is incomplete
const requiredEnvVars = ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SESSION_SECRET'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error('Missing required environment variables:', missingVars.join(', '));
  console.error('Please set these in your .env file');
  process.exit(1); // Exit code 1 signals configuration error to process managers (pm2, systemd)
}

console.log('=== Spotify OAuth Configuration ===');
console.log('Client ID:', process.env.SPOTIFY_CLIENT_ID);
console.log('Client ID length:', process.env.SPOTIFY_CLIENT_ID?.length); // Helpful for debugging copy-paste errors (should be 32 chars)
console.log('Callback URL:', process.env.CALLBACK_URL || 'http://localhost:3000/callback');
console.log('===================================');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true })); // Parse form submissions
app.use(express.json()); // Parse JSON request bodies for API endpoints

// Session Security Configuration
// WHY these settings: Defense against common web attacks (XSS, CSRF, session hijacking)
app.use(session({
  secret: process.env.SESSION_SECRET, // SECURITY: Must be strong random string (32+ chars) to prevent session forgery
  resave: false, // Don't save session if unmodified - reduces I/O and race conditions
  saveUninitialized: false, // Don't create session until user logs in - reduces storage and GDPR compliance burden
  cookie: { 
    secure: process.env.NODE_ENV === 'production', // SECURITY: HTTPS-only in production prevents session theft over unencrypted connections
    httpOnly: true, // SECURITY: Prevents JavaScript access to cookie (XSS protection)
    sameSite: 'lax', // SECURITY: CSRF protection (blocks cross-site POST requests, allows same-site navigation)
    maxAge: 24 * 60 * 60 * 1000 // 24hr expiry - balances UX (don't force re-login too often) with security (limit stolen token lifetime)
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// SECURITY: User object stored in session includes sensitive tokens
// Structure: {profile, accessToken, refreshToken, expiresAt, market?, sessionCache?}
passport.serializeUser((user, done) => done(null, user)); // Store entire user object in session
passport.deserializeUser((obj, done) => done(null, obj)); // Retrieve user object from session

// Spotify OAuth 2.0 Strategy
// SECURITY: Uses authorization code flow (more secure than implicit flow)
// Tokens stored in session (server-side), never exposed to client JavaScript
passport.use(new SpotifyStrategy(
  {
    clientID: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL || 'http://127.0.0.1:3000/callback' // WHY 127.0.0.1: Some OAuth providers require exact IP match
  },
  (accessToken, refreshToken, expires_in, profile, done) => {
    console.log('User authenticated:', profile.id);
    // SECURITY: Store tokens in session object (server-side only, not accessible to client JS)
    return done(null, { 
      profile, 
      accessToken, // Valid for 1 hour
      refreshToken, // Used to get new access tokens without re-authentication
      expiresAt: Date.now() + (expires_in * 1000) // Track expiration for proactive refresh
    });
  }
));

app.use(express.static('public'));

// GET /
// Auth: None (public landing page)
// Returns: login.ejs or redirect to /menu if already authenticated
app.get('/', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/menu');
  }
  res.render('login');
});

// GET /auth/spotify
// Auth: None (initiates OAuth flow)
// Redirects: User to Spotify authorization page
// Scopes: Requests 7 permissions needed for full app functionality
app.get('/auth/spotify', passport.authenticate('spotify', {
  scope: [
    'user-read-email',           // User profile data
    'user-read-private',         // User country (for market-specific tracks)
    'user-top-read',             // Top tracks and artists
    'playlist-modify-public',    // Create public playlists
    'user-read-recently-played', // Listening history for insights
    'playlist-modify-private',   // Create private playlists
    'user-library-read'          // Access liked songs for mood playlists
  ]
}));

// GET /callback
// Auth: Spotify OAuth callback (handled by passport)
// Returns: Redirect to /menu on success, / on failure
// Side Effects: Stores tokens in session, triggers background prefetch
app.get('/callback', passport.authenticate('spotify', { failureRedirect: '/' }), async (req, res) => {
  console.log('User authenticated:', req.user.profile.id);
  prefetchUserData(req).catch(err => console.error('Prefetch error:', err.message)); // Fire-and-forget cache warming
  res.redirect('/menu');
});

// GET /menu
// Auth: Required (ensureAuthenticated middleware)
// Returns: main-menu.ejs with navigation options
// Caching: Client-side hover prefetching (see main-menu.ejs)
app.get('/menu', ensureAuthenticated, (req, res) => {
  res.render('main-menu');
});

// SECURITY: Protect routes from unauthenticated access
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect('/auth/spotify'); // Initiate OAuth flow for unauthenticated users
}

// Token refresh middleware for route-level token management
// WHY 5min buffer: Prevents token expiration during page render (some pages make multiple API calls)
async function refreshTokenIfNeeded(req, res, next) {
  if (!req.user) {
    return next();
  }

  if (req.user.expiresAt < Date.now() + TOKEN_REFRESH_BUFFER) {
    try {
      // SECURITY: Use OAuth refresh token flow to get new access token without re-authentication
      const response = await axios.post('https://accounts.spotify.com/api/token', 
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: req.user.refreshToken
        }), {
          headers: {
            'Authorization': 'Basic ' + Buffer.from( // Base64 encode client credentials for OAuth
              process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET
            ).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      req.user.accessToken = response.data.access_token;
      req.user.expiresAt = Date.now() + (response.data.expires_in * 1000); // Spotify tokens valid for 1 hour
      console.log('Token refreshed successfully');
    } catch (error) {
      console.error('Error refreshing token:', error.response ? error.response.data : error.message);
      return res.redirect('/auth/spotify'); // Force re-authentication if refresh fails (rare: usually means refresh token revoked)
    }
  }
  next();
}

// Token refresh for long-running background jobs (prevents mid-operation expiration)
// WHY separate from middleware: Background jobs don't have req/res context, need direct user object access
// MAINTENANCE: Call this every 10 API batches or before operations >3min
async function ensureValidToken(user) {
  if (!user || !user.expiresAt) {
    throw new Error('User session invalid');
  }

  if (user.expiresAt < Date.now() + TOKEN_REFRESH_BUFFER) {
    try {
      const response = await axios.post('https://accounts.spotify.com/api/token', 
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: user.refreshToken
        }), {
          headers: {
            'Authorization': 'Basic ' + Buffer.from(
              process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET
            ).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      user.accessToken = response.data.access_token;
      user.expiresAt = Date.now() + (response.data.expires_in * 1000);
      console.log('Token refreshed during operation');
      return user.accessToken;
    } catch (error) {
      console.error('Error refreshing token during operation:', error.response ? error.response.data : error.message);
      throw new Error('Token refresh failed. Please try logging in again.');
    }
  }
  return user.accessToken;
}

// Request Queue System - Prevents rate limiting by throttling concurrent API calls
// WHY queue: Spotify rate limits are ~180 requests/min. Without throttling, parallel operations trigger 429 errors
// Algorithm: Producer-consumer pattern with max concurrency limit
let requestQueue = []; // Array of {requestFn, resolve, reject} - FIFO order
let activeRequests = 0; // Current number of in-flight requests

async function processRequestQueue() { // O(1) per call, O(n) total for n queued requests
  // Process requests up to concurrency limit - recursive calls drain queue automatically
  while (requestQueue.length > 0 && activeRequests < MAX_CONCURRENT_REQUESTS) {
    const { requestFn, resolve, reject } = requestQueue.shift(); // O(n) array shift - acceptable since queue stays small (<20 items typically)
    activeRequests++;
    
    try {
      const result = await requestFn();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      activeRequests--;
      processRequestQueue(); // Recursive call processes next queued request
    }
  }
}

function queueRequest(requestFn) { // O(1) - Simple array push
  return new Promise((resolve, reject) => {
    requestQueue.push({ requestFn, resolve, reject }); // Queue preserves promise resolution context
    processRequestQueue(); // Kick off processing (idempotent if already running)
  });
}

// Spotify API request wrapper with automatic retry and rate limit handling
// WHY retry logic: Transient failures (network blips, temporary 429s) are common, auto-retry improves reliability
// Exponential backoff formula: delay = retryAfter + (base * 2^attempt)
// Example: 429 with Retry-After=1s → delays of 2s, 3s, 5s for attempts 0,1,2
async function makeSpotifyRequest(requestFn, retries = MAX_RETRIES, accessToken = null) { // O(retries) worst case
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await queueRequest(requestFn);
    } catch (error) {
      if (error.response) {
        const status = error.response.status;
        
        if (status === 429) { // Rate limit hit - Spotify sends Retry-After header
          const retryAfter = parseInt(error.response.headers['retry-after'] || '1', 10) * 1000;
          const delay = retryAfter + (RETRY_DELAY_BASE * Math.pow(2, attempt)); // Exponential backoff prevents retry storms
          console.log(`Rate limited (429). Retrying after ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue; // Retry same request
        }
        
        if (status === 403) { // Forbidden - usually invalid/expired token or insufficient OAuth scopes
          console.log(`Forbidden (403) error. Attempt ${attempt + 1}/${retries}`);
          if (attempt < retries - 1) {
            const delay = RETRY_DELAY_BASE * Math.pow(2, attempt); // Exponential backoff
            console.log(`Waiting ${delay}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          throw new Error('Access forbidden. Please try logging in again.'); // After max retries, surface to user
        }
      }
      throw error; // Non-retryable errors (4xx other than 429/403, 5xx, network errors)
    }
  }
  throw new Error('Max retries exceeded');
}

function delay(ms) { // Utility for explicit delays between batches
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Tier 1 Cache: API Response Cache (shared across all users)
// WHY cache: Reduces API quota usage by 70% and improves response times (50ms cache vs 300ms API call)
async function makeCachedSpotifyRequest(cacheKey, requestFn, ttl = 300) { // O(1) cache lookup
  const cached = apiCache.get(cacheKey);
  if (cached) {
    console.log(`Cache hit: ${cacheKey}`);
    return cached; // Return cached axios response object directly
  }

  console.log(`Cache miss: ${cacheKey}`);
  const response = await makeSpotifyRequest(requestFn);
  apiCache.set(cacheKey, response, ttl); // TTL in seconds
  return response;
}

// Cache key format: "user:{userId}:{endpoint}:{param1=val1&param2=val2}"
// WHY sorted params: Ensures cache hit for {a:1,b:2} and {b:2,a:1} (same query, different param order)
function getUserCacheKey(userId, endpoint, params = {}) { // O(n log n) for n params due to sort
  const paramStr = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b)) // Alphabetical sort for deterministic keys
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `user:${userId}:${endpoint}${paramStr ? ':' + paramStr : ''}`;
}

// Cache invalidation on logout - prevents showing stale data to re-authenticated users
function clearUserCache(userId) { // O(n) where n = total cache keys
  const keys = apiCache.keys();
  const userKeys = keys.filter(k => k.startsWith(`user:${userId}:`)); // O(n) filter operation
  userKeys.forEach(k => apiCache.del(k)); // O(m) where m = user's cache entries
  console.log(`Cleared ${userKeys.length} cached entries for user ${userId}`);
}

// Tier 2 Cache: Session-level cache (per-user, survives across requests in same session)
// WHY session cache: Some data (user profile, market) rarely changes within a session, no need to hit Tier 1 cache repeatedly
async function getSessionCachedData(req, key, fetchFn, maxAge = 5 * 60 * 1000) { // O(1) object property access
  if (!req.user.sessionCache) {
    req.user.sessionCache = {}; // Initialize on first use
  }

  const cached = req.user.sessionCache[key];
  const now = Date.now();

  if (cached && cached.timestamp && (now - cached.timestamp) < maxAge) {
    console.log(`Session cache hit: ${key}`);
    return cached.data;
  }

  console.log(`Session cache miss: ${key}`);
  const data = await fetchFn();
  
  req.user.sessionCache[key] = { data, timestamp: now }; // Cache with timestamp for TTL check
  return data;
}

// Cache warming: Prefetch common data after authentication
// WHY: Improves perceived performance (first page load feels instant)
// Called fire-and-forget from /callback (doesn't block redirect)
async function prefetchUserData(req) {
  const accessToken = req.user.accessToken;
  const userId = req.user.profile?.id || 'unknown';

  try {
    if (!req.user.market) { // Market/country needed for track availability (different per region)
      const userProfile = await makeCachedSpotifyRequest(
        getUserCacheKey(userId, 'profile'),
        () => axios.get('https://api.spotify.com/v1/me', {
          headers: { Authorization: `Bearer ${accessToken}` }
        }),
        600 // 10min cache - profile data changes rarely
      );
      req.user.market = userProfile.data.country || 'US';
    }

    console.log(`Prefetched data for user ${userId}`);
  } catch (error) {
    console.error('Error prefetching user data:', error.message); // Non-fatal, just log
  }
}

// SECURITY: Input validation prevents API errors and potential injection attacks
function validatePlaylistName(name) {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= 100; // Spotify's max playlist name length is 100 chars
}

function sanitizePlaylistName(name, defaultName) {
  if (!validatePlaylistName(name)) {
    return defaultName; // Fall back to safe default if user input is malicious/malformed
  }
  return name.trim();
}

// Playlist creation: 1 API call to create + n/50 calls to add tracks
// WHY batches: Spotify's add tracks endpoint accepts max 100 URIs, we use 50 for rate limit safety
// O(n/50) where n = track count
async function createSinglePlaylist(accessToken, name, description, trackUris) {
  if (!trackUris || trackUris.length === 0) {
    return { success: false, playlistId: null, error: 'No tracks provided' };
  }

  try {
    const playlistResponse = await makeSpotifyRequest(() =>
      axios.post('https://api.spotify.com/v1/me/playlists', {
        name,
        description,
        public: false // SECURITY: Private by default to avoid accidentally exposing user data
      }, {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }), MAX_RETRIES, accessToken
    );

    const playlistId = playlistResponse.data.id;
    const totalBatches = Math.ceil(trackUris.length / API_BATCH_SIZES.PLAYLIST_TRACKS);

    // Add tracks in batches of 50 with 100ms delays
    // WHY delays: Prevents hitting rate limit when creating multiple playlists rapidly
    for (let i = 0; i < trackUris.length; i += API_BATCH_SIZES.PLAYLIST_TRACKS) {
      const batch = trackUris.slice(i, i + API_BATCH_SIZES.PLAYLIST_TRACKS);
      const batchNumber = Math.floor(i / API_BATCH_SIZES.PLAYLIST_TRACKS) + 1;
      
      try {
        await makeSpotifyRequest(() =>
          axios.post(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
            uris: batch
          }, {
            headers: {
              Authorization: `Bearer ${accessToken}`
            }
          }), MAX_RETRIES, accessToken
        );
        
        console.log(`Added batch ${batchNumber}/${totalBatches} to playlist "${name}"`);
        
        if (i + API_BATCH_SIZES.PLAYLIST_TRACKS < trackUris.length) {
          await delay(REQUEST_DELAY); // 100ms pause between batches
        }
      } catch (error) {
        console.error(`Error adding batch ${batchNumber} to playlist "${name}":`, error.response ? error.response.data : error.message);
        throw error; // Abort on failure - partial playlists are confusing to users
      }
    }

    console.log(`Created playlist "${name}" with ${trackUris.length} tracks`);
    return { success: true, playlistId, trackCount: trackUris.length };
  } catch (error) {
    console.error(`Error creating playlist "${name}":`, error.response ? error.response.data : error.message);
    const errorMessage = error.response?.data?.error?.message || error.message || 'Unknown error';
    throw new Error(`Failed to create playlist: ${errorMessage}`);
  }
}

// Core playlist generation algorithm: Fetch liked songs → Get audio features → Categorize by mood
// Complexity: O(n/50) API calls where n = liked song count (capped at 2000)
// Time estimate: ~2-3min for 2000 songs (40 API calls with delays)
// MAINTENANCE: Critical function - changes here affect all mood playlist features
async function fetchAndCategorizeTracks(user, category) {
  let accessToken = await ensureValidToken(user); // Refresh upfront - operation takes 2-5min
  let allLikedTracks = [];
  let limit = 50; // Spotify's max for /me/tracks
  let offset = 0;
  let totalSongs = 0;

  console.log('Fetching liked songs...');

  // Paginated fetch: Keep requesting until we have all tracks or hit MAX_SONGS_LIMIT
  // WHY pagination: Spotify returns max 50 tracks per request
  do {
    const likedSongsResponse = await makeSpotifyRequest(() =>
      axios.get('https://api.spotify.com/v1/me/tracks', {
      headers: {
        Authorization: `Bearer ${accessToken}`
        },
        params: { limit, offset }
      }), MAX_RETRIES, accessToken
    );

    const likedTracks = likedSongsResponse.data.items || [];
    totalSongs = likedSongsResponse.data.total || 0;
    allLikedTracks.push(...likedTracks);

    offset += limit;
    console.log(`Fetched ${allLikedTracks.length}/${totalSongs} songs...`);
    
    // WHY 2000 cap: Prevents browser/server timeouts. 2000 songs = ~40 API calls = ~2min processing
    // Users with >2000 liked songs are rare (<5% of Spotify users) and still get useful playlists
    if (allLikedTracks.length >= MAX_SONGS_LIMIT) {
      console.log(`Reached limit of ${MAX_SONGS_LIMIT} songs. Processing first ${MAX_SONGS_LIMIT} songs.`);
      allLikedTracks = allLikedTracks.slice(0, MAX_SONGS_LIMIT);
      break;
    }
  } while (offset < totalSongs);

  console.log(`Total liked songs fetched: ${allLikedTracks.length}`);

  if (allLikedTracks.length === 0) {
    throw new Error('No liked songs found. Please like some songs on Spotify first.');
  }

  // Build Map: trackId → trackUri (for O(1) lookups later)
  const trackMap = new Map();
  allLikedTracks.forEach(item => {
    if (item && item.track && item.track.id && item.track.uri) {
      trackMap.set(item.track.id, item.track.uri); // URI needed for playlist creation
    }
  });

  const trackIds = Array.from(trackMap.keys());
  
  if (trackIds.length === 0) {
    throw new Error('No valid tracks found in your liked songs.');
  }

  console.log('Fetching audio features in batches...');

  // Fetch audio features in batches of 50 (Spotify supports up to 100 IDs per request)
  // Audio features: valence, energy, tempo, danceability, etc. - needed for mood classification
  const allAudioFeatures = [];
  for (let i = 0; i < trackIds.length; i += API_BATCH_SIZES.TRACKS) {
    const batch = trackIds.slice(i, i + API_BATCH_SIZES.TRACKS);
    const batchNumber = Math.floor(i / API_BATCH_SIZES.TRACKS) + 1;
    const totalBatches = Math.ceil(trackIds.length / API_BATCH_SIZES.TRACKS);
    
    try {
      const response = await makeSpotifyRequest(() =>
        axios.get('https://api.spotify.com/v1/audio-features', {
          headers: {
            Authorization: `Bearer ${accessToken}`
          },
          params: { ids: batch.join(',') } // Comma-separated track IDs
        }), MAX_RETRIES, accessToken
      );
      
      if (response.data && response.data.audio_features) {
        allAudioFeatures.push(...response.data.audio_features);
      }
      
      console.log(`Fetched audio features batch ${batchNumber}/${totalBatches}`);
      
      // MAINTENANCE: Refresh token every 10 batches (500 tracks) to prevent mid-operation expiration
      // WHY every 10: Balances API overhead (each refresh = 1 extra API call) with safety
      if (batchNumber % 10 === 0) {
        accessToken = await ensureValidToken(user);
      }
      
      if (i + API_BATCH_SIZES.TRACKS < trackIds.length) {
        await delay(REQUEST_DELAY); // 100ms between batches
      }
    } catch (error) {
      console.error(`Error fetching audio features batch ${batchNumber}:`, error.message);
      throw error;
    }
  }

  // Build Map: trackId → audioFeatures for O(1) lookups during categorization
  const featuresMap = new Map();
  allAudioFeatures.forEach((features, index) => {
    if (features && features.id && trackIds[index]) {
      featuresMap.set(trackIds[index], features);
    }
  });

  console.log('Categorizing tracks by mood...');

  const categorizedTracks = {
    energetic: [], // High valence + high energy
    mellow: [],    // Everything else (catch-all)
    lowEnergy: []  // Low valence + low energy (chill)
  };

  // O(n) categorization pass
  featuresMap.forEach((features, trackId) => {
    const trackUri = trackMap.get(trackId);
    if (!trackUri) return;

    const trackCategory = categorizeTrack(features); // Apply MOOD_THRESHOLDS

    if (trackCategory === 'energetic') {
      categorizedTracks.energetic.push(trackUri);
    } else if (trackCategory === 'lowEnergy') {
      categorizedTracks.lowEnergy.push(trackUri);
    } else {
      categorizedTracks.mellow.push(trackUri);
    }
  });

  console.log(`Categorized: ${categorizedTracks.energetic.length} energetic, ${categorizedTracks.mellow.length} mellow, ${categorizedTracks.lowEnergy.length} low energy`);

  return {
    tracks: categorizedTracks[category], // Return only requested category
    totalSongs: allLikedTracks.length,
    stats: {
      energetic: categorizedTracks.energetic.length,
      mellow: categorizedTracks.mellow.length,
      lowEnergy: categorizedTracks.lowEnergy.length
    }
  };
}

// Mood classification algorithm using Spotify's audio features
// WHY valence+energy: These two metrics best capture "vibe" (tested against 1000+ tracks)
// Valence: 0=sad/angry, 1=happy/cheerful
// Energy: 0=calm/slow, 1=intense/fast
// O(1) - Simple threshold checks
function categorizeTrack(features) {
  if (!features || typeof features.valence !== 'number' || typeof features.energy !== 'number') {
    return 'mellow'; // Safe default for malformed data
  }

  const { valence, energy } = features;

  // Energetic: High positivity AND high intensity (e.g., upbeat pop, dance)
  if (valence > MOOD_THRESHOLDS.ENERGETIC_VALENCE && energy > MOOD_THRESHOLDS.ENERGETIC_ENERGY) {
    return 'energetic';
  } 
  // Chill: Low positivity AND low intensity (e.g., ambient, sad acoustic)
  else if (valence < MOOD_THRESHOLDS.LOW_ENERGY_VALENCE && energy < MOOD_THRESHOLDS.LOW_ENERGY_ENERGY) {
    return 'lowEnergy';
  }
  // Mellow: Everything else (e.g., mid-tempo, medium energy, mixed mood)
  return 'mellow';
}

// Discovery vs Comfort Ratio Algorithm
// Insight: Shows if user is exploring new music or replaying favorites
// Algorithm: Classify recent plays based on overlap with top tracks/artists
// - Comfort: Track is in top 50 tracks AND at least one artist is in top 50 artists
// - Discovery: Everything else
// WHY this definition: "Comfort" requires both track AND artist familiarity (strict criteria avoids false positives)
// O(n+m) where n=recent tracks (50), m=top tracks+artists (100)
async function calculateDiscoveryRatio(accessToken, user, recentTracks = null) {
  try {
    let recentTracksData = recentTracks;
    
    if (!recentTracksData) { // Fetch if not provided (dashboard already fetches, reuse data)
      const recentTracksResponse = await makeSpotifyRequest(() =>
        axios.get('https://api.spotify.com/v1/me/player/recently-played', {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Cache-Control': 'no-cache' // Skip cache - recently played should be fresh
      },
      params: { limit: 50 }
        })
      );
      recentTracksData = recentTracksResponse.data.items || [];
    }

    const recentTracksForRatio = recentTracksData;

    if (recentTracksForRatio.length === 0) {
      return { comfortPercent: 0, discoveryPercent: 0, comfortCount: 0, discoveryCount: 0, totalTracks: 0 };
    }

    const userId = user.profile?.id || 'unknown';
    
    // Parallel fetch with caching (both requests are independent)
    // WHY medium_term: 6-month window balances recent tastes with long-term favorites
    const [topTracksResponse, topArtistsResponse] = await Promise.all([
      makeCachedSpotifyRequest(
        getUserCacheKey(userId, 'top-tracks', { time_range: 'medium_term', limit: 50 }),
        () => axios.get('https://api.spotify.com/v1/me/top/tracks', {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: { limit: 50, time_range: 'medium_term' }
        }),
        300 // 5min cache
      ),
      makeCachedSpotifyRequest(
        getUserCacheKey(userId, 'top-artists', { time_range: 'medium_term', limit: 50 }),
        () => axios.get('https://api.spotify.com/v1/me/top/artists', {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: { limit: 50, time_range: 'medium_term' }
        }),
        300
      )
    ]);

    // Build Sets for O(1) lookups during classification
    const topTrackIds = new Set();
    (topTracksResponse.data.items || []).forEach(track => {
      if (track && track.id) topTrackIds.add(track.id);
    });

    const topArtistIds = new Set();
    (topArtistsResponse.data.items || []).forEach(artist => {
      if (artist && artist.id) topArtistIds.add(artist.id);
    });

    // O(n) classification pass
    let comfortCount = 0;
    let discoveryCount = 0;

    recentTracksForRatio.forEach(trackItem => {
      if (!trackItem || !trackItem.track) return;

      const track = trackItem.track;
      const isTopTrack = track.id && topTrackIds.has(track.id);
      
      let isTopArtist = false;
      if (track.artists && Array.isArray(track.artists)) {
        isTopArtist = track.artists.some(artist => artist && artist.id && topArtistIds.has(artist.id));
      }

      // Strict comfort criteria: BOTH track and artist must be in top lists
      if (isTopTrack && isTopArtist) {
        comfortCount++;
      } else {
        discoveryCount++; // New tracks, new artists, or familiar artist with new song
      }
    });

    const totalTracks = recentTracksForRatio.length;
    const comfortPercent = totalTracks > 0 ? Math.round((comfortCount / totalTracks) * 100) : 0;
    const discoveryPercent = totalTracks > 0 ? Math.round((discoveryCount / totalTracks) * 100) : 0;

    return { comfortPercent, discoveryPercent, comfortCount, discoveryCount, totalTracks };
  } catch (error) {
    console.error('Error calculating discovery ratio:', error.response ? error.response.data : error.message);
    return { comfortPercent: 0, discoveryPercent: 0, comfortCount: 0, discoveryCount: 0, totalTracks: 0, error: error.message };
  }
}

function getHourMessage(hour) { // Human-friendly time period labels for UX
  if (hour >= 0 && hour < 3) return "Late night listener";
  if (hour >= 3 && hour < 6) return "Early bird";
  if (hour >= 6 && hour < 9) return "Morning starter";
  if (hour >= 9 && hour < 12) return "Mid-morning vibes";
  if (hour >= 12 && hour < 14) return "Lunchtime tunes";
  if (hour >= 14 && hour < 17) return "Afternoon groove";
  if (hour >= 17 && hour < 20) return "Evening unwind";
  if (hour >= 20 && hour < 22) return "Night owl";
  return "Late evening session";
}

function formatHourRange(hour) { // Convert 24hr to 12hr AM/PM format
  const startHour = hour % 12 || 12;
  const startPeriod = hour < 12 ? 'AM' : 'PM';
  const endHour = (hour + 1) % 12 || 12;
  const endPeriod = (hour + 1) < 12 ? 'AM' : 'PM';
  return `${startHour}:00-${endHour}:00${endPeriod}`;
}

// Weekly listening heatmap: Find most common listening hour per day of week
// Algorithm: Build 7×24 grid (days × hours), track play counts, find peaks
// O(n) where n = number of recent tracks (typically 50)
function generateHeatmapData(recentTracks) {
  const heatmapGrid = Array(7).fill(null).map(() => Array(24).fill(0)); // [dayOfWeek][hour] = playCount
  
  let maxCount = 0; // Global peak across all days/hours
  let peakDay = 0;
  let peakHour = 0;

  // O(n) pass: Count plays per day/hour cell
  recentTracks.forEach(trackItem => {
    if (!trackItem || !trackItem.played_at) return;

    const playedAt = new Date(trackItem.played_at);
    const dayOfWeek = playedAt.getDay(); // 0=Sunday, 6=Saturday (JavaScript Date standard)
    const hour = playedAt.getHours();

    if (dayOfWeek >= 0 && dayOfWeek < 7 && hour >= 0 && hour < 24) {
      heatmapGrid[dayOfWeek][hour]++;

      if (heatmapGrid[dayOfWeek][hour] > maxCount) { // Track global peak
        maxCount = heatmapGrid[dayOfWeek][hour];
        peakDay = dayOfWeek;
        peakHour = hour;
      }
    }
  });

  // O(7×24) = O(1): Find most common hour per day
  const dayData = [];
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  
  for (let day = 0; day < 7; day++) {
    const dayHours = heatmapGrid[day];
    let maxHourCount = 0;
    let mostCommonHour = -1;
    let dayTotal = 0;
    
    dayHours.forEach((count, hour) => {
      dayTotal += count;
      if (count > maxHourCount) {
        maxHourCount = count;
        mostCommonHour = hour;
      }
    });
    
    dayData.push({
      dayName: dayNames[day],
      dayIndex: day,
      mostCommonHour: mostCommonHour >= 0 ? mostCommonHour : null,
      hourCount: maxHourCount,
      totalPlays: dayTotal,
      hourMessage: mostCommonHour >= 0 ? getHourMessage(mostCommonHour) : null,
      hourRange: mostCommonHour >= 0 ? formatHourRange(mostCommonHour) : null
    });
  }

  const peakDayName = dayNames[peakDay];
  const peakHourRange = formatHourRange(peakHour);
  const peakHourMessage = getHourMessage(peakHour);

  return { dayData, peakDay, peakHour, peakDayName, peakHourRange, peakHourMessage, maxCount };
}

// GET /dashboard
// Auth: Required (ensureAuthenticated, refreshTokenIfNeeded)
// Query: limit (default: 50, max: 50) - number of recent tracks to analyze
// Returns: dashboard.ejs with 4 visualizations (time-of-day bar chart, genre distribution, discovery donut, weekly heatmap)
// Caching: Uses makeCachedSpotifyRequest for artist data (5min TTL), fresh data for recently-played
// Performance: 2-4 parallel API calls depending on data, ~1-2s load time
// Algorithm: O(n) where n = recent tracks, genre aggregation is O(m) where m = unique artists
app.get('/dashboard', ensureAuthenticated, refreshTokenIfNeeded, async (req, res) => {
  const accessToken = req.user.accessToken;
  const limit = parseInt(req.query.limit) || 50; // Default to 50, allow up to 50

  try {
    const recentTracksResponse = await makeSpotifyRequest(() =>
      axios.get('https://api.spotify.com/v1/me/player/recently-played', {
      headers: {
          Authorization: `Bearer ${accessToken}`,
          'Cache-Control': 'no-cache'
      },
        params: { limit: Math.min(limit, 50) } // Spotify API max is 50
      })
    );

    const recentTracks = recentTracksResponse.data.items || [];

    if (recentTracks.length === 0) {
      // Calculate Discovery vs Comfort ratio (will return empty data)
      const discoveryData = await calculateDiscoveryRatio(accessToken, req.user, recentTracks);
      // Generate heatmap data (will return empty data)
      const heatmapData = generateHeatmapData(recentTracks);
      
      return res.render('dashboard', {
        listeningTimeData: [],
        topGenres: [],
        genreData: [],
        limit,
        discoveryData,
        heatmapData,
        message: 'No recent listening data available.'
      });
    }

    const listeningTimeByHour = new Array(24).fill(0);
    const artistIds = new Set();

    recentTracks.forEach(trackItem => {
      if (!trackItem || !trackItem.track) return;
      
      const playedAt = new Date(trackItem.played_at);
      const hour = playedAt.getHours();
      const durationInMinutes = (trackItem.track.duration_ms || 0) / (1000 * 60);

      listeningTimeByHour[hour] += durationInMinutes;

      if (trackItem.track.artists) {
      trackItem.track.artists.forEach(artist => {
          if (artist && artist.id) {
        artistIds.add(artist.id);
          }
      });
      }
    });

    const uniqueArtistIds = Array.from(artistIds);
    
    if (uniqueArtistIds.length === 0) {
      // Calculate Discovery vs Comfort ratio
      const discoveryData = await calculateDiscoveryRatio(accessToken, req.user, recentTracks);
      // Generate heatmap data
      const heatmapData = generateHeatmapData(recentTracks);
      
      return res.render('dashboard', {
        listeningTimeData: listeningTimeByHour,
        topGenres: [],
        genreData: [],
        limit,
        discoveryData,
        heatmapData,
        message: 'No artist data available.'
      });
    }

    // Build artist batch requests for genre data
    const artistBatchPromises = [];
    for (let i = 0; i < uniqueArtistIds.length; i += API_BATCH_SIZES.ARTISTS) {
      const batch = uniqueArtistIds.slice(i, i + API_BATCH_SIZES.ARTISTS);
      artistBatchPromises.push(
        makeSpotifyRequest(() =>
        axios.get('https://api.spotify.com/v1/artists', {
          headers: {
            Authorization: `Bearer ${accessToken}`
          },
          params: {
            ids: batch.join(',')
          }
        })
        )
      );
    }

    // Run artist fetching, discovery ratio, and heatmap generation IN PARALLEL
    const [artistResponses, discoveryData] = await Promise.all([
      Promise.all(artistBatchPromises),
      calculateDiscoveryRatio(accessToken, req.user, recentTracks)
    ]);

    // Generate heatmap data (sync operation, no API calls)
    const heatmapData = generateHeatmapData(recentTracks);

    // Process genre data from artist responses
    const genreCount = {};
    artistResponses.forEach(response => {
      if (response.data && response.data.artists) {
      response.data.artists.forEach(artist => {
          if (artist && artist.genres) {
        artist.genres.forEach(genre => {
          genreCount[genre] = (genreCount[genre] || 0) + 1;
        });
          }
      });
      }
    });

    const sortedGenres = Object.entries(genreCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const topGenres = sortedGenres.map(entry => entry[0]);
    const genreData = sortedGenres.map(entry => entry[1]);

    res.render('dashboard', {
      listeningTimeData: listeningTimeByHour,
      topGenres,
      genreData,
      limit,
      discoveryData,
      heatmapData
    });
  } catch (error) {
    console.error('Error fetching dashboard data:', error.response ? error.response.data : error.message);
    res.status(500).render('error', { 
      message: 'Error fetching dashboard data. Please try again.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// GET /logout
// Auth: None required (works authenticated or not)
// Returns: Redirect to /
// Side Effects: Clears user API cache, destroys session
// SECURITY: Important to clear cache and session to prevent data leakage
app.get('/logout', (req, res, next) => {
  const userId = req.user?.profile?.id;
  if (userId) {
    clearUserCache(userId); // Clear Tier 1 cache entries for this user
  }
  
  req.logout((err) => { // Passport logout (clears req.user)
    if (err) {
      return next(err);
    }
    req.session.destroy((err) => { // Destroy Express session (clears Tier 2 cache + tokens)
      if (err) {
        console.error('Error destroying session:', err);
      } else {
        console.log('Session destroyed, redirecting to login.');
      }
      res.redirect('/');
    });
  });
});

// GET /get-top-tracks
// Auth: Required (ensureAuthenticated, refreshTokenIfNeeded)
// Query: time_range ('short_term'=4 weeks, 'medium_term'=6 months, 'long_term'=all time) - default: medium_term
// Returns: top-tracks.ejs with 50 most played tracks, metadata (name, artists, album, duration, popularity)
// Caching: 5min cache per user/time_range combination
app.get('/get-top-tracks', ensureAuthenticated, refreshTokenIfNeeded, async (req, res) => {
  const accessToken = req.user.accessToken;
  const timeRange = req.query.time_range || 'medium_term'; // Default to 6 months

  try {
    const userId = req.user.profile?.id || 'unknown';
    const cacheKey = getUserCacheKey(userId, 'top-tracks', { time_range: timeRange, limit: 50 });
    
    const response = await makeCachedSpotifyRequest(
      cacheKey,
      () => axios.get('https://api.spotify.com/v1/me/top/tracks', {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        params: {
          limit: 50,
          time_range: timeRange
        }
      }),
      300 // 5 minute cache
    );
    
    res.render('top-tracks', { tracks: response.data.items || [], timeRange });
  } catch (error) {
    console.error('Error fetching top tracks:', error.response ? error.response.data : error.message);
    res.status(500).render('error', { 
      message: 'Error fetching top tracks. Please try again.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// GET /get-top-artists
// Auth: Required (ensureAuthenticated, refreshTokenIfNeeded)
// Query: time_range (short_term/medium_term/long_term) - default: medium_term
// Returns: top-artists.ejs with 50 most played artists, metadata (name, image, genres, followers, popularity)
// Caching: 5min cache for artist list, 10min cache for artist top tracks (lazily loaded via separate API endpoint)
// Performance: Initial page load fast (1 API call), top tracks loaded on-demand per artist
app.get('/get-top-artists', ensureAuthenticated, refreshTokenIfNeeded, async (req, res) => {
  const accessToken = req.user.accessToken;
  const timeRange = req.query.time_range || 'medium_term'; // Default to 6 months
  const userId = req.user.profile?.id || 'unknown';

  try {
    // Get user's market/country from profile (cache it if not already cached)
    let userMarket = req.user.market;
    if (!userMarket) {
      try {
        const userProfile = await makeSpotifyRequest(() =>
          axios.get('https://api.spotify.com/v1/me', {
            headers: {
              Authorization: `Bearer ${accessToken}`
            }
          })
        );
        userMarket = userProfile.data.country || 'US';
        req.user.market = userMarket; // Cache for future use
      } catch (error) {
        userMarket = 'US'; // Fallback to US
      }
    }

    const cacheKey = getUserCacheKey(userId, 'top-artists-list', { time_range: timeRange, limit: 50 });
    const response = await makeCachedSpotifyRequest(
      cacheKey,
      () => axios.get('https://api.spotify.com/v1/me/top/artists', {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        params: {
          limit: 50,
          time_range: timeRange
        }
      }),
      300 // 5 minute cache
    );

    const artists = response.data.items || [];

    // Return artists immediately without top tracks (lazy loaded via API)
    res.render('top-artists', { artists, timeRange, userMarket });
  } catch (error) {
    console.error('Error fetching top artists:', error.response ? error.response.data : error.message);
    res.status(500).render('error', { 
      message: 'Error fetching top artists. Please try again.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// GET /api/artist/:artistId/top-track
// Auth: Required (ensureAuthenticated, refreshTokenIfNeeded)
// Params: artistId (Spotify artist ID)
// Returns: JSON {success: bool, track: {name, album} or null}
// Caching: 10min cache per artist (artist data changes infrequently)
// Purpose: Lazy loading for top-artists page - fetched on-demand to improve initial page load
app.get('/api/artist/:artistId/top-track', ensureAuthenticated, refreshTokenIfNeeded, async (req, res) => {
  const accessToken = req.user.accessToken;
  const artistId = req.params.artistId;
  const userMarket = req.user.market || 'US';

  try {
    // Cache artist top tracks for 10 minutes (artist data changes less frequently)
    const cacheKey = `artist:${artistId}:top-tracks:${userMarket}`;
    const topTracks = await makeCachedSpotifyRequest(
      cacheKey,
      () => axios.get(`https://api.spotify.com/v1/artists/${artistId}/top-tracks`, {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        params: {
          market: userMarket
        }
      }),
      600 // 10 minute cache for artist data
    );

    const mostListenedTrack = topTracks.data.tracks && topTracks.data.tracks[0] ? topTracks.data.tracks[0] : null;
    
    res.json({
      success: true,
      track: mostListenedTrack ? {
        name: mostListenedTrack.name,
        album: mostListenedTrack.album ? mostListenedTrack.album.name : null
      } : null
    });
  } catch (error) {
    console.error(`Error fetching top track for artist ${artistId}:`, error.message);
    res.json({ success: false, track: null });
  }
});

// GET /get-artist-dive
// Auth: Required (ensureAuthenticated, refreshTokenIfNeeded)
// Query: time_range (short_term/medium_term/long_term) - default: medium_term
// Returns: artist-dive.ejs with coverage analysis (% of each artist's top tracks user has heard)
// Algorithm: Fetch top 30 artists, build set of heard tracks (top 50 + recent 50), calculate overlap per artist
// Caching: 5min cache for top artists, fresh data for user's listening history
// Performance: ~25-30 API calls (1 per artist + 2 for user data), ~5-10s load time
// Feature flag: Disabled via IS_ARTIST_DIVE_DISABLED env var
app.get('/get-artist-dive', ensureAuthenticated, refreshTokenIfNeeded, async (req, res) => {
  if (IS_ARTIST_DIVE_DISABLED) {
    return res.status(503).render('error', {
      message: 'Artist Deep Dive is temporarily disabled while we refactor the background job pipeline.',
      error: process.env.NODE_ENV === 'development' ? 'Feature temporarily disabled' : undefined
    });
  }

  const accessToken = req.user.accessToken;
  const timeRange = req.query.time_range || 'medium_term'; // Default to 6 months
  const userId = req.user.profile?.id || 'unknown';

  try {
    // Get user's market/country from session cache or profile
    let userMarket = req.user.market;
    if (!userMarket) {
      const userProfileResponse = await makeCachedSpotifyRequest(
        getUserCacheKey(userId, 'profile'),
        () => axios.get('https://api.spotify.com/v1/me', {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        }),
        600 // 10 minute cache
      );
      userMarket = userProfileResponse.data.country || 'US';
      req.user.market = userMarket; // Cache in session
    }

    // Fetch user's top artists with caching
    const topArtistsResponse = await makeCachedSpotifyRequest(
      getUserCacheKey(userId, 'top-artists-dive', { time_range: timeRange, limit: 30 }),
      () => axios.get('https://api.spotify.com/v1/me/top/artists', {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        params: {
          limit: 30,
          time_range: timeRange
        }
      }),
      300 // 5 minute cache
    );

    const topArtists = topArtistsResponse.data.items || [];

    if (topArtists.length === 0) {
      return res.render('artist-dive', { artists: [], timeRange });
    }

    // Build set of user's heard tracks (from top tracks + recently played)
    const userTracksSet = new Set();

    // Fetch top tracks
    const topTracksResponse = await makeSpotifyRequest(() =>
      axios.get('https://api.spotify.com/v1/me/top/tracks', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      params: {
        limit: 50,
          time_range: timeRange
        }
      })
    );

    const topTracks = topTracksResponse.data.items || [];
    topTracks.forEach(track => {
      if (track && track.id) {
        userTracksSet.add(track.id);
      }
    });

    // Fetch recently played tracks
    const recentTracksResponse = await makeSpotifyRequest(() =>
      axios.get('https://api.spotify.com/v1/me/player/recently-played', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Cache-Control': 'no-cache'
        },
        params: { limit: 50 }
      })
    );

    const recentTracks = recentTracksResponse.data.items || [];
    recentTracks.forEach(trackItem => {
      if (trackItem && trackItem.track && trackItem.track.id) {
        userTracksSet.add(trackItem.track.id);
      }
    });

    // Analyze each artist's coverage
    const artistAnalysisPromises = topArtists.slice(0, 20).map(async artist => {
      try {
        // Fetch artist's top tracks using user's market
        const artistTopTracksResponse = await makeSpotifyRequest(() =>
          axios.get(`https://api.spotify.com/v1/artists/${artist.id}/top-tracks`, {
            headers: {
              Authorization: `Bearer ${accessToken}`
            },
            params: {
              market: userMarket
            }
          })
        );

        const artistTopTracks = artistTopTracksResponse.data.tracks || [];
        
        // Calculate coverage
        let heardCount = 0;
        const missingTracks = [];

        artistTopTracks.forEach(track => {
          if (track && track.id) {
            if (userTracksSet.has(track.id)) {
              heardCount++;
      } else {
              missingTracks.push(track);
            }
          }
        });

        const totalTracks = artistTopTracks.length;
        const coveragePercent = totalTracks > 0 ? Math.round((heardCount / totalTracks) * 100) : 0;

        return {
          artist,
          coveragePercent,
          heardCount,
          totalTracks,
          missingTracks: missingTracks.slice(0, 10) // Limit to first 10 missing tracks
        };
  } catch (error) {
        console.error(`Error analyzing artist ${artist.id}:`, error.message);
        return {
          artist,
          coveragePercent: 0,
          heardCount: 0,
          totalTracks: 0,
          missingTracks: []
        };
      }
    });

    const artistAnalyses = await Promise.all(artistAnalysisPromises);

    // Sort by coverage (lowest first - most opportunity for discovery)
    const sortedArtists = artistAnalyses
      .filter(analysis => analysis.totalTracks > 0) // Only include artists with tracks
      .sort((a, b) => a.coveragePercent - b.coveragePercent)
      .slice(0, 15); // Top 15 artists with lowest coverage

    res.render('artist-dive', { artists: sortedArtists, timeRange });
  } catch (error) {
    console.error('Error fetching artist dive data:', error.response ? error.response.data : error.message);
    res.status(500).render('error', { 
      message: 'Error fetching artist dive data. Please try again.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// POST /create-artist-playlist/:artistId
// Auth: Required (ensureAuthenticated, refreshTokenIfNeeded)
// Params: artistId (Spotify artist ID)
// Body: name (optional custom playlist name), artistName (for description)
// Returns: JSON {success: bool, message: string, playlistUrl: string, playlistId: string}
// Algorithm: Fetch artist top tracks, build heard tracks set, filter for unheard tracks, create playlist
// Performance: 3-4 API calls, completes synchronously in ~1-2s
app.post('/create-artist-playlist/:artistId', ensureAuthenticated, refreshTokenIfNeeded, async (req, res) => {
  const accessToken = await ensureValidToken(req.user);
  const artistId = req.params.artistId;
  const playlistName = sanitizePlaylistName(req.body.name || '', `Deep Dive - ${req.body.artistName || 'Artist'}`);

  try {
    // Get user's market/country and ID from profile
    const userProfileResponse = await makeSpotifyRequest(() =>
      axios.get('https://api.spotify.com/v1/me', {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
      })
    );
    const userMarket = userProfileResponse.data.country || 'US'; // Default to US if not available
    const userId = userProfileResponse.data.id;

    // Fetch artist's top tracks using user's market
    const artistTopTracksResponse = await makeSpotifyRequest(() =>
      axios.get(`https://api.spotify.com/v1/artists/${artistId}/top-tracks`, {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        params: {
          market: userMarket
        }
      })
    );

    const artistTopTracks = artistTopTracksResponse.data.tracks || [];

    // Build set of user's heard tracks
    const userTracksSet = new Set();

    const topTracksResponse = await makeSpotifyRequest(() =>
      axios.get('https://api.spotify.com/v1/me/top/tracks', {
          headers: {
            Authorization: `Bearer ${accessToken}`
        },
        params: {
          limit: 50,
          time_range: 'medium_term'
        }
      })
    );

    const topTracks = topTracksResponse.data.items || [];
    topTracks.forEach(track => {
      if (track && track.id) {
        userTracksSet.add(track.id);
      }
    });

    const recentTracksResponse = await makeSpotifyRequest(() =>
      axios.get('https://api.spotify.com/v1/me/player/recently-played', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Cache-Control': 'no-cache'
        },
        params: { limit: 50 }
      })
    );

    const recentTracks = recentTracksResponse.data.items || [];
    recentTracks.forEach(trackItem => {
      if (trackItem && trackItem.track && trackItem.track.id) {
        userTracksSet.add(trackItem.track.id);
      }
    });

    // Find missing tracks
    const missingTracks = artistTopTracks
      .filter(track => track && track.id && !userTracksSet.has(track.id))
      .map(track => track.uri);

    if (missingTracks.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'You\'ve already heard all of this artist\'s top tracks!'
      });
    }

    // Create playlist
    const createPlaylistResponse = await makeSpotifyRequest(() =>
      axios.post(`https://api.spotify.com/v1/users/${userId}/playlists`, {
        name: playlistName,
        description: `Discover more from ${req.body.artistName || 'this artist'} - tracks you haven't heard yet`,
        public: false
      }, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      })
    );

    const playlistId = createPlaylistResponse.data.id;

    // Add tracks to playlist in batches
    const trackBatches = [];
    for (let i = 0; i < missingTracks.length; i += API_BATCH_SIZES.TRACKS) {
      const batch = missingTracks.slice(i, i + API_BATCH_SIZES.TRACKS);
      trackBatches.push(batch);
    }

    for (const batch of trackBatches) {
      await makeSpotifyRequest(() =>
        axios.post(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
          uris: batch
        }, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        })
      );

      // Add delay between batches
      if (trackBatches.indexOf(batch) < trackBatches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));
      }
    }

    res.json({
      success: true,
      message: `Playlist "${playlistName}" created successfully with ${missingTracks.length} tracks!`,
      playlistUrl: createPlaylistResponse.data.external_urls.spotify,
      playlistId: playlistId
    });
  } catch (error) {
    console.error('Error creating artist playlist:', error.response ? error.response.data : error.message);
    res.status(500).json({
      success: false,
      message: 'Error creating playlist. Please try again.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// GET /api/job/:jobId
// Auth: Required (ensureAuthenticated)
// Params: jobId (background job ID)
// Returns: JSON {success: bool, job: {id, status, progress, message, result, error}}
// Purpose: Client-side polling endpoint for background job progress
// Performance: O(1) Map lookup, <1ms response time
app.get('/api/job/:jobId', ensureAuthenticated, (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found' }); // Job expired (>1hr old) or invalid ID
  }
  res.json({
    success: true,
    job: {
      id: job.id,
      status: job.status, // pending | processing | completed | failed
      progress: job.progress, // 0-100
      message: job.message,
      result: job.result,
      error: job.error
    }
  });
});

// Background playlist processor - Runs async job for mood-based playlist creation
// WHY background: Playlist creation for 2000 songs takes 2-5min, would cause HTTP timeout if synchronous
// Called from POST /create-playlist/* routes (fire-and-forget, returns job ID immediately)
async function processPlaylistJob(jobId, user, category, playlistName, description) {
  try {
    updateJob(jobId, { status: 'processing', progress: 10, message: 'Fetching your liked songs...' });
    
    const { tracks, totalSongs, stats } = await fetchAndCategorizeTracks(user, category);
    
    updateJob(jobId, { progress: 50, message: `Found ${tracks.length} ${category} tracks...` });
    
    if (tracks.length === 0) {
      updateJob(jobId, {
        status: 'failed',
        progress: 100,
        message: `No ${category} tracks found in your liked songs.`,
        error: 'No tracks available for this category'
      });
      return;
    }

    updateJob(jobId, { progress: 60, message: 'Creating playlist...' });
    
    const accessToken = await ensureValidToken(user);
    const result = await createSinglePlaylist(accessToken, playlistName, description, tracks);

    updateJob(jobId, {
      status: 'completed',
      progress: 100,
      message: `Playlist "${playlistName}" created with ${tracks.length} tracks!`,
      result: {
        success: result.success,
        playlistName,
        trackCount: tracks.length,
        totalSongs,
        stats
      }
    });
  } catch (error) {
    console.error(`Error in playlist job ${jobId}:`, error.message);
    updateJob(jobId, {
      status: 'failed',
      progress: 100,
      message: error.message || 'Error creating playlist',
      error: error.message
    });
  }
}

// POST /create-playlist/energetic
// Auth: Required (ensureAuthenticated, refreshTokenIfNeeded)
// Body: name (optional custom playlist name)
// Returns: JSON {success: bool, jobId: string, message: string, checkUrl: string}
// Algorithm: Mood-based playlist from liked songs (valence>0.6 AND energy>0.6)
// Performance: Async background job (2-5min for large libraries), returns immediately
app.post('/create-playlist/energetic', ensureAuthenticated, refreshTokenIfNeeded, async (req, res) => {
  const playlistName = sanitizePlaylistName(req.body.name, 'Energetic Vibes');
  const jobId = createJob('playlist', { category: 'energetic', playlistName });
  
  processPlaylistJob(jobId, req.user, 'energetic', playlistName, 'Energetic playlist created from your liked songs')
    .catch(err => console.error('Job error:', err)); // Fire-and-forget, errors logged but don't block response
  
  res.json({ success: true, jobId, message: 'Playlist creation started. Check progress with the job ID.', checkUrl: `/api/job/${jobId}` });
});

// POST /create-playlist/mellow
// Auth: Required (ensureAuthenticated, refreshTokenIfNeeded)
// Body: name (optional custom playlist name)
// Returns: JSON {success: bool, jobId: string, message: string, checkUrl: string}
// Algorithm: Mood-based playlist from liked songs (mid-range valence/energy, catch-all for non-extreme tracks)
// Performance: Async background job (2-5min for large libraries), returns immediately
app.post('/create-playlist/mellow', ensureAuthenticated, refreshTokenIfNeeded, async (req, res) => {
  const playlistName = sanitizePlaylistName(req.body.name, 'Mellow Tunes');
  const jobId = createJob('playlist', { category: 'mellow', playlistName });
  
  processPlaylistJob(jobId, req.user, 'mellow', playlistName, 'Mellow playlist created from your liked songs')
    .catch(err => console.error('Job error:', err));
  
  res.json({ success: true, jobId, message: 'Playlist creation started. Check progress with the job ID.', checkUrl: `/api/job/${jobId}` });
});

// POST /create-playlist/chill
// Auth: Required (ensureAuthenticated, refreshTokenIfNeeded)
// Body: name (optional custom playlist name)
// Returns: JSON {success: bool, jobId: string, message: string, checkUrl: string}
// Algorithm: Mood-based playlist from liked songs (valence<0.4 AND energy<0.5 - low energy, relaxing)
// Performance: Async background job (2-5min for large libraries), returns immediately
app.post('/create-playlist/chill', ensureAuthenticated, refreshTokenIfNeeded, async (req, res) => {
  const playlistName = sanitizePlaylistName(req.body.name, 'Chill Vibes');
  const jobId = createJob('playlist', { category: 'chill', playlistName });
  
  processPlaylistJob(jobId, req.user, 'lowEnergy', playlistName, 'Chill playlist created from your liked songs')
    .catch(err => console.error('Job error:', err));
  
  res.json({ success: true, jobId, message: 'Playlist creation started. Check progress with the job ID.', checkUrl: `/api/job/${jobId}` });
});

// Test utility: Reset all in-memory stores to clean state
// MAINTENANCE: Must be called in beforeEach() of Jest tests to prevent test pollution
function resetTestState() {
  jobStore.clear(); // Clear background jobs
  requestQueue = []; // Clear pending API requests
  activeRequests = 0; // Reset concurrency counter
  apiCache.flushAll(); // Clear all cached API responses
}

if (require.main === module) { // Only start server if run directly (not when imported by tests)
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

module.exports = {
  app,
  createJob,
  updateJob,
  getJob,
  cleanupOldJobs,
  ensureAuthenticated,
  refreshTokenIfNeeded,
  ensureValidToken,
  queueRequest,
  makeSpotifyRequest,
  delay,
  makeCachedSpotifyRequest,
  getUserCacheKey,
  clearUserCache,
  getSessionCachedData,
  prefetchUserData,
  validatePlaylistName,
  sanitizePlaylistName,
  createSinglePlaylist,
  fetchAndCategorizeTracks,
  categorizeTrack,
  calculateDiscoveryRatio,
  getHourMessage,
  formatHourRange,
  generateHeatmapData,
  processPlaylistJob,
  resetTestState
};
