/**
 * myi - Music Insights & Intelligence
 * 
 * Main server file for the Spotify music analytics application.
 * Provides user authentication, data visualization, and playlist creation features.
 * 
 * @author Mohamed Ibrahim
 * @version 1.0.0
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const SpotifyStrategy = require('passport-spotify').Strategy;
const axios = require('axios');
const NodeCache = require('node-cache');

// API Response Cache - TTL in seconds
const apiCache = new NodeCache({ 
  stdTTL: 300, // 5 minutes default TTL
  checkperiod: 60, // Check for expired entries every 60 seconds
  useClones: false // Better performance, don't clone objects
});

// Background Job System for long-running operations
const jobStore = new Map();

/**
 * Creates a background job and returns its ID
 * @param {string} type - Job type (e.g., 'playlist')
 * @param {Object} data - Job data
 * @returns {string} Job ID
 */
function createJob(type, data) {
  const jobId = `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  jobStore.set(jobId, {
    id: jobId,
    type,
    status: 'pending',
    progress: 0,
    message: 'Starting...',
    data,
    result: null,
    error: null,
    createdAt: Date.now()
  });
  return jobId;
}

/**
 * Updates a job's status
 * @param {string} jobId - Job ID
 * @param {Object} updates - Fields to update
 */
function updateJob(jobId, updates) {
  const job = jobStore.get(jobId);
  if (job) {
    Object.assign(job, updates);
    jobStore.set(jobId, job);
  }
}

/**
 * Gets a job's current status
 * @param {string} jobId - Job ID
 * @returns {Object|null} Job object or null if not found
 */
function getJob(jobId) {
  return jobStore.get(jobId) || null;
}

/**
 * Cleans up old completed/failed jobs (older than 1 hour)
 */
function cleanupOldJobs() {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const [jobId, job] of jobStore.entries()) {
    if (job.createdAt < oneHourAgo && (job.status === 'completed' || job.status === 'failed')) {
      jobStore.delete(jobId);
    }
  }
}

// Clean up old jobs every 30 minutes (skip interval in tests)
if (process.env.NODE_ENV !== 'test') {
  setInterval(cleanupOldJobs, 30 * 60 * 1000);
}

const app = express();
const port = process.env.PORT || 3000;

/**
 * Application Constants
 * 
 * Configuration values for mood thresholds, API batch sizes, rate limiting,
 * and other operational parameters.
 */
const MOOD_THRESHOLDS = {
  ENERGETIC_VALENCE: 0.6,
  ENERGETIC_ENERGY: 0.6,
  LOW_ENERGY_VALENCE: 0.4,
  LOW_ENERGY_ENERGY: 0.5
};

const API_BATCH_SIZES = {
  TRACKS: 50,  // Reduced from 100 to avoid rate limits
  ARTISTS: 50,
  PLAYLIST_TRACKS: 50  // Smaller batch for adding tracks to playlists
};

const TOKEN_REFRESH_BUFFER = 5 * 60 * 1000; // 5 minutes
const MAX_RETRIES = 3;
const RETRY_DELAY_BASE = 1000; // 1 second
const REQUEST_DELAY = 100; // Delay between batch requests (ms)
const MAX_CONCURRENT_REQUESTS = 5; // Max concurrent API requests
const MAX_SONGS_LIMIT = 2000; // Limit for very large libraries
const IS_ARTIST_DIVE_DISABLED = process.env.ARTIST_DIVE_DISABLED !== 'false';

// Environment variable validation
const requiredEnvVars = ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SESSION_SECRET'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error('Missing required environment variables:', missingVars.join(', '));
  console.error('Please set these in your .env file');
  process.exit(1);
}

// Debug: Log OAuth configuration on startup
console.log('=== Spotify OAuth Configuration ===');
console.log('Client ID:', process.env.SPOTIFY_CLIENT_ID);
console.log('Client ID length:', process.env.SPOTIFY_CLIENT_ID?.length);
console.log('Callback URL:', process.env.CALLBACK_URL || 'http://localhost:3000/callback');
console.log('===================================');

// Express configuration
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((obj, done) => {
  done(null, obj);
});

// Spotify OAuth
passport.use(new SpotifyStrategy(
  {
    clientID: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL || 'http://127.0.0.1:3000/callback'
  },
  (accessToken, refreshToken, expires_in, profile, done) => {
    console.log('User authenticated:', profile.id);
    return done(null, { 
      profile, 
      accessToken,
      refreshToken,
      expiresAt: Date.now() + (expires_in * 1000)
    });
  }
));

app.use(express.static('public'));

/**
 * Application Routes
 * 
 * All routes are defined below with their respective handlers and middleware.
 */

/**
 * Root route - shows login page if not authenticated, redirects to menu if authenticated
 */
app.get('/', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/menu');
  }
  res.render('login');
});

/**
 * Spotify OAuth authentication route
 * Redirects user to Spotify authorization page
 */
app.get('/auth/spotify', passport.authenticate('spotify', {
  scope: [
    'user-read-email', 
    'user-read-private', 
    'user-top-read', 
    'playlist-modify-public', 
    'user-read-recently-played', 
    'playlist-modify-private',
    'user-library-read'
  ]
}));

/**
 * OAuth callback route - handles Spotify authentication response
 * Redirects to main menu on success, root on failure
 */
app.get('/callback', passport.authenticate('spotify', { failureRedirect: '/' }), async (req, res) => {
  console.log('User authenticated:', req.user.profile.id);
  
  // Prefetch user data in background (don't wait)
  prefetchUserData(req).catch(err => console.error('Prefetch error:', err.message));
  
  res.redirect('/menu');
});

/**
 * Main menu route - requires authentication
 * Displays navigation menu with all available features
 */
app.get('/menu', ensureAuthenticated, (req, res) => {
  res.render('main-menu');
});

/**
 * Middleware Functions
 */

/**
 * Ensures user is authenticated before accessing protected routes
 * Redirects to Spotify OAuth if not authenticated
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect('/auth/spotify');
}

/**
 * Middleware to refresh access token if it's about to expire
 * Checks token expiration and refreshes if within buffer time
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
async function refreshTokenIfNeeded(req, res, next) {
  if (!req.user) {
    return next();
  }

  if (req.user.expiresAt < Date.now() + TOKEN_REFRESH_BUFFER) {
    try {
      const response = await axios.post('https://accounts.spotify.com/api/token', 
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: req.user.refreshToken
        }), {
          headers: {
            'Authorization': 'Basic ' + Buffer.from(
              process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET
            ).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      req.user.accessToken = response.data.access_token;
      req.user.expiresAt = Date.now() + (response.data.expires_in * 1000);
      
      console.log('Token refreshed successfully');
    } catch (error) {
      console.error('Error refreshing token:', error.response ? error.response.data : error.message);
      return res.redirect('/auth/spotify');
    }
  }
  next();
}

/**
 * Refreshes access token during long-running operations
 * Used when operations may exceed token lifetime
 * 
 * @param {Object} user - User session object with accessToken and refreshToken
 * @returns {Promise<string>} Valid access token
 * @throws {Error} If token refresh fails or user session is invalid
 */
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

/**
 * Request Queue System
 * 
 * Implements throttling to limit concurrent Spotify API requests
 * and prevent rate limiting issues.
 */

let requestQueue = [];
let activeRequests = 0;

/**
 * Processes queued requests up to the maximum concurrent limit
 * Automatically processes next request when one completes
 */
async function processRequestQueue() {
  while (requestQueue.length > 0 && activeRequests < MAX_CONCURRENT_REQUESTS) {
    const { requestFn, resolve, reject } = requestQueue.shift();
    activeRequests++;
    
    try {
      const result = await requestFn();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      activeRequests--;
      processRequestQueue();
    }
  }
}

/**
 * Adds a request to the queue and returns a promise
 * 
 * @param {Function} requestFn - Async function that makes the API request
 * @returns {Promise} Promise that resolves with the request result
 */
function queueRequest(requestFn) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ requestFn, resolve, reject });
    processRequestQueue();
  });
}

/**
 * Makes a Spotify API request with automatic retry logic for rate limits
 * Handles 429 (rate limit) and 403 (forbidden) errors with exponential backoff
 * 
 * @param {Function} requestFn - Async function that makes the API request
 * @param {number} retries - Maximum number of retry attempts (default: MAX_RETRIES)
 * @param {string} accessToken - Optional access token for 403 error handling
 * @returns {Promise} Promise that resolves with the API response
 * @throws {Error} If max retries exceeded or request fails
 */
async function makeSpotifyRequest(requestFn, retries = MAX_RETRIES, accessToken = null) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await queueRequest(requestFn);
    } catch (error) {
      if (error.response) {
        const status = error.response.status;
        
        // Handle rate limiting (429)
        if (status === 429) {
          const retryAfter = parseInt(error.response.headers['retry-after'] || '1', 10) * 1000;
          const delay = retryAfter + (RETRY_DELAY_BASE * Math.pow(2, attempt));
          console.log(`Rate limited (429). Retrying after ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        // Handle forbidden (403) - likely token issue
        if (status === 403) {
          console.log(`Forbidden (403) error. Attempt ${attempt + 1}/${retries}`);
          if (attempt < retries - 1) {
            const delay = RETRY_DELAY_BASE * Math.pow(2, attempt);
            console.log(`Waiting ${delay}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          throw new Error('Access forbidden. Please try logging in again.');
        }
      }
      throw error;
    }
  }
  throw new Error('Max retries exceeded');
}

/**
 * Utility function to create a delay
 * 
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise} Promise that resolves after the delay
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Makes a cached Spotify API request
 * Returns cached data if available and not expired, otherwise fetches fresh data
 * 
 * @param {string} cacheKey - Unique key for caching this request
 * @param {Function} requestFn - Async function that makes the API request
 * @param {number} ttl - Optional TTL in seconds (default: 300 = 5 minutes)
 * @returns {Promise} Promise that resolves with the API response data
 */
async function makeCachedSpotifyRequest(cacheKey, requestFn, ttl = 300) {
  // Check cache first
  const cached = apiCache.get(cacheKey);
  if (cached) {
    console.log(`Cache hit: ${cacheKey}`);
    return cached;
  }

  // Make request and cache result
  console.log(`Cache miss: ${cacheKey}`);
  const response = await makeSpotifyRequest(requestFn);
  apiCache.set(cacheKey, response, ttl);
  return response;
}

/**
 * Generates a cache key for user-specific API requests
 * 
 * @param {string} userId - Spotify user ID
 * @param {string} endpoint - API endpoint name
 * @param {Object} params - Optional parameters to include in key
 * @returns {string} Cache key
 */
function getUserCacheKey(userId, endpoint, params = {}) {
  const paramStr = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `user:${userId}:${endpoint}${paramStr ? ':' + paramStr : ''}`;
}

/**
 * Clears all cached data for a specific user
 * Call this on logout to prevent stale data
 * 
 * @param {string} userId - Spotify user ID
 */
function clearUserCache(userId) {
  const keys = apiCache.keys();
  const userKeys = keys.filter(k => k.startsWith(`user:${userId}:`));
  userKeys.forEach(k => apiCache.del(k));
  console.log(`Cleared ${userKeys.length} cached entries for user ${userId}`);
}

/**
 * Session-level cache helper for user data
 * Stores frequently accessed data in user session to avoid redundant API calls
 * 
 * @param {Object} req - Express request object
 * @param {string} key - Cache key within session
 * @param {Function} fetchFn - Async function to fetch data if not cached
 * @param {number} maxAge - Maximum age in ms before refresh (default: 5 minutes)
 * @returns {Promise} Cached or freshly fetched data
 */
async function getSessionCachedData(req, key, fetchFn, maxAge = 5 * 60 * 1000) {
  // Initialize session cache if not exists
  if (!req.user.sessionCache) {
    req.user.sessionCache = {};
  }

  const cached = req.user.sessionCache[key];
  const now = Date.now();

  // Return cached data if valid
  if (cached && cached.timestamp && (now - cached.timestamp) < maxAge) {
    console.log(`Session cache hit: ${key}`);
    return cached.data;
  }

  // Fetch fresh data
  console.log(`Session cache miss: ${key}`);
  const data = await fetchFn();
  
  // Store in session
  req.user.sessionCache[key] = {
    data,
    timestamp: now
  };

  return data;
}

/**
 * Prefetch common user data and store in session
 * Call after successful authentication to warm up cache
 * 
 * @param {Object} req - Express request object
 */
async function prefetchUserData(req) {
  const accessToken = req.user.accessToken;
  const userId = req.user.profile?.id || 'unknown';

  try {
    // Prefetch user profile for market info
    if (!req.user.market) {
      const userProfile = await makeCachedSpotifyRequest(
        getUserCacheKey(userId, 'profile'),
        () => axios.get('https://api.spotify.com/v1/me', {
          headers: { Authorization: `Bearer ${accessToken}` }
        }),
        600 // 10 minute cache
      );
      req.user.market = userProfile.data.country || 'US';
    }

    console.log(`Prefetched data for user ${userId}`);
  } catch (error) {
    console.error('Error prefetching user data:', error.message);
  }
}

/**
 * Input Validation Functions
 */

/**
 * Validates playlist name format and length
 * 
 * @param {string} name - Playlist name to validate
 * @returns {boolean} True if valid, false otherwise
 */
function validatePlaylistName(name) {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= 100;
}

/**
 * Sanitizes and validates playlist name, returns default if invalid
 * 
 * @param {string} name - Playlist name to sanitize
 * @param {string} defaultName - Default name to use if input is invalid
 * @returns {string} Sanitized playlist name or default
 */
function sanitizePlaylistName(name, defaultName) {
  if (!validatePlaylistName(name)) {
    return defaultName;
  }
  return name.trim();
}

/**
 * Playlist Creation Functions
 */

/**
 * Creates a single Spotify playlist and adds tracks in batches
 * Includes delays between batches to prevent rate limiting
 * 
 * @param {string} accessToken - Spotify access token
 * @param {string} name - Playlist name
 * @param {string} description - Playlist description
 * @param {Array<string>} trackUris - Array of Spotify track URIs
 * @returns {Promise<Object>} Created playlist object with URL
 * @throws {Error} If playlist creation fails
 */
async function createSinglePlaylist(accessToken, name, description, trackUris) {
  if (!trackUris || trackUris.length === 0) {
    return { success: false, playlistId: null, error: 'No tracks provided' };
  }

  try {
    // Create playlist
    const playlistResponse = await makeSpotifyRequest(() =>
      axios.post('https://api.spotify.com/v1/me/playlists', {
        name,
        description,
        public: false
      }, {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }), MAX_RETRIES, accessToken
    );

    const playlistId = playlistResponse.data.id;
    const totalBatches = Math.ceil(trackUris.length / API_BATCH_SIZES.PLAYLIST_TRACKS);

    // Add tracks in batches with delays
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
        
        // Add delay between batches to avoid rate limits
        if (i + API_BATCH_SIZES.PLAYLIST_TRACKS < trackUris.length) {
          await delay(REQUEST_DELAY);
        }
      } catch (error) {
        console.error(`Error adding batch ${batchNumber} to playlist "${name}":`, error.response ? error.response.data : error.message);
        throw error;
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

/**
 * Fetches user's liked tracks and categorizes them by mood
 * Processes tracks in batches with rate limiting and token refresh
 * 
 * @param {Object} user - User session object
 * @param {string} category - Mood category ('energetic', 'mellow', or 'lowEnergy')
 * @returns {Promise<Object>} Object containing categorized tracks, stats, and metadata
 * @throws {Error} If no liked songs found or processing fails
 */
async function fetchAndCategorizeTracks(user, category) {
  // Ensure token is valid at start
  let accessToken = await ensureValidToken(user);
  let allLikedTracks = [];
  let limit = 50;
  let offset = 0;
  let totalSongs = 0;

  console.log('Fetching liked songs...');

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
    
    // Limit for very large libraries to avoid timeouts
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

  const trackMap = new Map();
  allLikedTracks.forEach(item => {
    if (item && item.track && item.track.id && item.track.uri) {
      trackMap.set(item.track.id, item.track.uri);
    }
  });

  const trackIds = Array.from(trackMap.keys());
  
  if (trackIds.length === 0) {
    throw new Error('No valid tracks found in your liked songs.');
  }

  console.log('Fetching audio features in batches...');

  // Fetch audio features with delays between batches
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
          params: { ids: batch.join(',') }
        }), MAX_RETRIES, accessToken
      );
      
      if (response.data && response.data.audio_features) {
        allAudioFeatures.push(...response.data.audio_features);
      }
      
      console.log(`Fetched audio features batch ${batchNumber}/${totalBatches}`);
      
      // Refresh token periodically during long operations
      if (batchNumber % 10 === 0) {
        accessToken = await ensureValidToken(user);
      }
      
      // Add delay between batches
      if (i + API_BATCH_SIZES.TRACKS < trackIds.length) {
        await delay(REQUEST_DELAY);
      }
    } catch (error) {
      console.error(`Error fetching audio features batch ${batchNumber}:`, error.message);
      throw error;
    }
  }

  const featuresMap = new Map();
  allAudioFeatures.forEach((features, index) => {
    if (features && features.id && trackIds[index]) {
      featuresMap.set(trackIds[index], features);
    }
  });

  console.log('Categorizing tracks by mood...');

  const categorizedTracks = {
    energetic: [],
    mellow: [],
    lowEnergy: []
  };

  featuresMap.forEach((features, trackId) => {
    const trackUri = trackMap.get(trackId);
    if (!trackUri) return;

    const trackCategory = categorizeTrack(features);

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
    tracks: categorizedTracks[category],
    totalSongs: allLikedTracks.length,
    stats: {
      energetic: categorizedTracks.energetic.length,
      mellow: categorizedTracks.mellow.length,
      lowEnergy: categorizedTracks.lowEnergy.length
    }
  };
}

/**
 * Categorizes a track into a mood category based on audio features
 * 
 * @param {Object} features - Spotify audio features object
 * @param {number} features.valence - Musical positiveness (0.0 to 1.0)
 * @param {number} features.energy - Intensity and activity (0.0 to 1.0)
 * @returns {string} Mood category: 'energetic', 'mellow', or 'lowEnergy'
 */
function categorizeTrack(features) {
  if (!features || typeof features.valence !== 'number' || typeof features.energy !== 'number') {
    return 'mellow';
  }

  const { valence, energy } = features;

  if (valence > MOOD_THRESHOLDS.ENERGETIC_VALENCE && energy > MOOD_THRESHOLDS.ENERGETIC_ENERGY) {
    return 'energetic';
  } else if (valence < MOOD_THRESHOLDS.LOW_ENERGY_VALENCE && energy < MOOD_THRESHOLDS.LOW_ENERGY_ENERGY) {
    return 'lowEnergy';
  }
  return 'mellow';
}

/**
 * Data Analysis Functions
 */

/**
 * Calculates the ratio of discovery vs comfort tracks in recent listening
 * Comfort tracks are those in both recent plays and top tracks/artists
 * Discovery tracks are new music not in top lists
 * 
 * @param {string} accessToken - Spotify access token
 * @param {Object} user - User session object
 * @param {Array} recentTracks - Optional array of recently played tracks to avoid redundant API call
 * @returns {Promise<Object>} Object with comfort/discovery percentages and counts
 */
async function calculateDiscoveryRatio(accessToken, user, recentTracks = null) {
  try {
    // Use provided recent tracks or fetch if not provided
    let recentTracksData = recentTracks;
    
    if (!recentTracksData) {
      const recentTracksResponse = await makeSpotifyRequest(() =>
        axios.get('https://api.spotify.com/v1/me/player/recently-played', {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Cache-Control': 'no-cache'
      },
      params: { limit: 50 }
        })
      );
      recentTracksData = recentTracksResponse.data.items || [];
    }

    const recentTracksForRatio = recentTracksData;

    if (recentTracksForRatio.length === 0) {
      return {
        comfortPercent: 0,
        discoveryPercent: 0,
        comfortCount: 0,
        discoveryCount: 0,
        totalTracks: 0
      };
    }

    // Fetch top tracks and top artists IN PARALLEL with caching for better performance
    // Note: user object may have profile.id for cache key
    const userId = user.profile?.id || 'unknown';
    
    const [topTracksResponse, topArtistsResponse] = await Promise.all([
      makeCachedSpotifyRequest(
        getUserCacheKey(userId, 'top-tracks', { time_range: 'medium_term', limit: 50 }),
        () => axios.get('https://api.spotify.com/v1/me/top/tracks', {
          headers: {
            Authorization: `Bearer ${accessToken}`
          },
          params: {
            limit: 50,
            time_range: 'medium_term'
          }
        }),
        300 // 5 minute cache
      ),
      makeCachedSpotifyRequest(
        getUserCacheKey(userId, 'top-artists', { time_range: 'medium_term', limit: 50 }),
        () => axios.get('https://api.spotify.com/v1/me/top/artists', {
          headers: {
            Authorization: `Bearer ${accessToken}`
          },
          params: {
            limit: 50,
            time_range: 'medium_term'
          }
        }),
        300 // 5 minute cache
      )
    ]);

    const topTracks = topTracksResponse.data.items || [];
    const topTrackIds = new Set();
    topTracks.forEach(track => {
      if (track && track.id) {
        topTrackIds.add(track.id);
      }
    });

    const topArtists = topArtistsResponse.data.items || [];
    const topArtistIds = new Set();
    topArtists.forEach(artist => {
      if (artist && artist.id) {
        topArtistIds.add(artist.id);
      }
    });

    // Classify recent tracks
    let comfortCount = 0;
    let discoveryCount = 0;

    recentTracksForRatio.forEach(trackItem => {
      if (!trackItem || !trackItem.track) return;

      const track = trackItem.track;
      const isTopTrack = track.id && topTrackIds.has(track.id);
      
      // Check if any artist from this track is in top artists
      let isTopArtist = false;
      if (track.artists && Array.isArray(track.artists)) {
        isTopArtist = track.artists.some(artist => artist && artist.id && topArtistIds.has(artist.id));
      }

      // Comfort: track is in top tracks AND at least one artist is in top artists
      if (isTopTrack && isTopArtist) {
        comfortCount++;
      } else {
        discoveryCount++;
      }
    });

    const totalTracks = recentTracksForRatio.length;
    const comfortPercent = totalTracks > 0 ? Math.round((comfortCount / totalTracks) * 100) : 0;
    const discoveryPercent = totalTracks > 0 ? Math.round((discoveryCount / totalTracks) * 100) : 0;

    return {
      comfortPercent,
      discoveryPercent,
      comfortCount,
      discoveryCount,
      totalTracks
    };
  } catch (error) {
    console.error('Error calculating discovery ratio:', error.response ? error.response.data : error.message);
    return {
      comfortPercent: 0,
      discoveryPercent: 0,
      comfortCount: 0,
      discoveryCount: 0,
      totalTracks: 0,
      error: error.message
    };
  }
}

/**
 * Returns a user-friendly message for a given hour of the day
 * 
 * @param {number} hour - Hour of day (0-23)
 * @returns {string} Descriptive message for that time period
 */
function getHourMessage(hour) {
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

/**
 * Formats an hour into a readable time range (e.g., "3:00-4:00PM")
 * 
 * @param {number} hour - Hour of day (0-23)
 * @returns {string} Formatted time range string
 */
function formatHourRange(hour) {
  const startHour = hour % 12 || 12;
  const startPeriod = hour < 12 ? 'AM' : 'PM';
  const endHour = (hour + 1) % 12 || 12;
  const endPeriod = (hour + 1) < 12 ? 'AM' : 'PM';
  return `${startHour}:00-${endHour}:00${endPeriod}`;
}

/**
 * Generates heatmap data from recently played tracks
 * Calculates most common listening hour for each day of the week
 * 
 * @param {Array} recentTracks - Array of recently played track objects
 * @returns {Object} Object containing day data, peak listening info, and statistics
 */
function generateHeatmapData(recentTracks) {
  // Initialize 7×24 grid (days of week × hours)
  // Day 0 = Sunday, Day 6 = Saturday
  const heatmapGrid = Array(7).fill(null).map(() => Array(24).fill(0));
  
  let maxCount = 0;
  let peakDay = 0;
  let peakHour = 0;

  recentTracks.forEach(trackItem => {
    if (!trackItem || !trackItem.played_at) return;

    const playedAt = new Date(trackItem.played_at);
    const dayOfWeek = playedAt.getDay(); // 0 = Sunday, 6 = Saturday
    const hour = playedAt.getHours(); // 0-23

    if (dayOfWeek >= 0 && dayOfWeek < 7 && hour >= 0 && hour < 24) {
      heatmapGrid[dayOfWeek][hour]++;

      // Track peak session
      if (heatmapGrid[dayOfWeek][hour] > maxCount) {
        maxCount = heatmapGrid[dayOfWeek][hour];
        peakDay = dayOfWeek;
        peakHour = hour;
      }
    }
  });

  // Calculate most common hour for each day
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

  return {
    dayData,
    peakDay,
    peakHour,
    peakDayName,
    peakHourRange,
    peakHourMessage,
    maxCount
  };
}

/**
 * Dashboard route - displays comprehensive listening insights
 * Includes time-of-day analysis, genre distribution, discovery/comfort ratio, and heatmap
 * Query params: limit (number of recent tracks to analyze, default: 50, max: 50)
 */
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

/**
 * Logout route - destroys user session and redirects to login
 */
app.get('/logout', (req, res, next) => {
  // Clear user's API cache before logout
  const userId = req.user?.profile?.id;
  if (userId) {
    clearUserCache(userId);
  }
  
  req.logout((err) => {
    if (err) {
      return next(err);
    }
    req.session.destroy((err) => {
      if (err) {
        console.error('Error destroying session:', err);
      } else {
        console.log('Session destroyed, redirecting to login.');
      }
      res.redirect('/');
    });
  });
});

/**
 * Top tracks route - displays user's most played tracks
 * Query params: time_range ('short_term', 'medium_term', or 'long_term', default: 'medium_term')
 */
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

/**
 * Top artists route - displays user's most played artists
 * Top tracks are loaded lazily via /api/artist/:id/top-track for better performance
 * Query params: time_range ('short_term', 'medium_term', or 'long_term', default: 'medium_term')
 */
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

/**
 * API endpoint to fetch an artist's top track (for lazy loading)
 * Returns JSON with the artist's most popular track
 */
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

/**
 * Artist Deep Dive route - analyzes how much of favorite artists' discographies user has explored
 * Shows coverage percentage and missing tracks for discovery
 * Query params: time_range ('short_term', 'medium_term', or 'long_term', default: 'medium_term')
 * Note: This feature is currently a work in progress
 */
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

/**
 * Create playlist route for artist's missing tracks
 * Creates a playlist containing tracks from an artist that the user hasn't heard yet
 * Route params: artistId - Spotify artist ID
 * Body params: name (optional playlist name), artistName (for description)
 */
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

/**
 * Job Status Endpoint
 * Returns the current status of a background job
 */
app.get('/api/job/:jobId', ensureAuthenticated, (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found' });
  }
  res.json({
    success: true,
    job: {
      id: job.id,
      status: job.status,
      progress: job.progress,
      message: job.message,
      result: job.result,
      error: job.error
    }
  });
});

/**
 * Background playlist processor
 * Processes playlist creation in the background and updates job status
 */
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

/**
 * Playlist Creation Routes
 * 
 * These routes create mood-based playlists from user's liked songs.
 * Uses background jobs for better UX - returns immediately with job ID.
 * Body params: name (optional custom playlist name)
 */

/**
 * Create energetic playlist - high energy, positive songs
 */
app.post('/create-playlist/energetic', ensureAuthenticated, refreshTokenIfNeeded, async (req, res) => {
  const playlistName = sanitizePlaylistName(req.body.name, 'Energetic Vibes');

  // Create a background job
  const jobId = createJob('playlist', { category: 'energetic', playlistName });
  
  // Start processing in background (don't await)
  processPlaylistJob(
    jobId, 
    req.user, 
    'energetic', 
    playlistName, 
    'Energetic playlist created from your liked songs'
  ).catch(err => console.error('Job error:', err));

  // Return job ID immediately
  res.json({
    success: true,
    jobId,
    message: 'Playlist creation started. Check progress with the job ID.',
    checkUrl: `/api/job/${jobId}`
  });
});

/**
 * Create mellow playlist - balanced, moderate energy songs
 */
app.post('/create-playlist/mellow', ensureAuthenticated, refreshTokenIfNeeded, async (req, res) => {
  const playlistName = sanitizePlaylistName(req.body.name, 'Mellow Tunes');

  // Create a background job
  const jobId = createJob('playlist', { category: 'mellow', playlistName });
  
  // Start processing in background
  processPlaylistJob(
    jobId, 
    req.user, 
    'mellow', 
    playlistName, 
    'Mellow playlist created from your liked songs'
  ).catch(err => console.error('Job error:', err));

  // Return job ID immediately
  res.json({
    success: true,
    jobId,
    message: 'Playlist creation started. Check progress with the job ID.',
    checkUrl: `/api/job/${jobId}`
  });
});

/**
 * Create chill playlist - low energy, relaxing songs
 */
app.post('/create-playlist/chill', ensureAuthenticated, refreshTokenIfNeeded, async (req, res) => {
  const playlistName = sanitizePlaylistName(req.body.name, 'Chill Vibes');

  // Create a background job
  const jobId = createJob('playlist', { category: 'chill', playlistName });
  
  // Start processing in background
  processPlaylistJob(
    jobId, 
    req.user, 
    'lowEnergy', 
    playlistName, 
    'Chill playlist created from your liked songs'
  ).catch(err => console.error('Job error:', err));

  // Return job ID immediately
  res.json({
    success: true,
    jobId,
    message: 'Playlist creation started. Check progress with the job ID.',
    checkUrl: `/api/job/${jobId}`
  });
});

/**
 * Test helper to reset in-memory stores between test cases
 */
function resetTestState() {
  jobStore.clear();
  requestQueue = [];
  activeRequests = 0;
  apiCache.flushAll();
}

/**
 * Start server
 * Listens on the configured port (default: 3000)
 */
if (require.main === module) {
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
