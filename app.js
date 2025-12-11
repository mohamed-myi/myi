require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const SpotifyStrategy = require('passport-spotify').Strategy;
const axios = require('axios');
const NodeCache = require('node-cache');

// 3-tier caching: API cache (5min), session cache, client prefetch
const apiCache = new NodeCache({ 
  stdTTL: 300,
  checkperiod: 60,
  useClones: false // Faster cache hits, safe for immutable responses
});

// Background job system for async playlist creation
const jobStore = new Map();

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

function updateJob(jobId, updates) {
  const job = jobStore.get(jobId);
  if (job) {
    Object.assign(job, updates);
    jobStore.set(jobId, job);
  }
}

function getJob(jobId) {
  return jobStore.get(jobId) || null;
}

// Cleanup jobs older than 1hr
function cleanupOldJobs() {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const [jobId, job] of jobStore.entries()) {
    if (job.createdAt < oneHourAgo && (job.status === 'completed' || job.status === 'failed')) {
      jobStore.delete(jobId);
    }
  }
}

if (process.env.NODE_ENV !== 'test') {
  setInterval(cleanupOldJobs, 30 * 60 * 1000);
}

const app = express();
const port = process.env.PORT || 3000;

// Configuration constants
const MOOD_THRESHOLDS = {
  ENERGETIC_VALENCE: 0.6,
  ENERGETIC_ENERGY: 0.6,
  LOW_ENERGY_VALENCE: 0.4,
  LOW_ENERGY_ENERGY: 0.5
};

const API_BATCH_SIZES = {
  TRACKS: 50,
  ARTISTS: 50,
  PLAYLIST_TRACKS: 50
};

const TOKEN_REFRESH_BUFFER = 5 * 60 * 1000; // Refresh 5min before expiry
const MAX_RETRIES = 3;
const RETRY_DELAY_BASE = 1000; // Exponential backoff: 1s, 2s, 4s
const REQUEST_DELAY = 100;
const MAX_CONCURRENT_REQUESTS = 5;
const MAX_SONGS_LIMIT = 2000; // Prevent timeout on large libraries
const IS_ARTIST_DIVE_DISABLED = process.env.ARTIST_DIVE_DISABLED !== 'false';

// Validate required environment variables
const requiredEnvVars = ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SESSION_SECRET'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error('Missing required environment variables:', missingVars.join(', '));
  process.exit(1);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

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

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

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

app.get('/', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/menu');
  }
  res.render('login');
});

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

app.get('/callback', passport.authenticate('spotify', { failureRedirect: '/' }), async (req, res) => {
  console.log('User authenticated:', req.user.profile.id);
  prefetchUserData(req).catch(err => console.error('Prefetch error:', err.message));
  res.redirect('/menu');
});

app.get('/menu', ensureAuthenticated, (req, res) => {
  res.render('main-menu');
});

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect('/auth/spotify');
}

// Refresh access token if expiring soon
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

// Token refresh for background jobs
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

// Request queue to prevent rate limiting
let requestQueue = [];
let activeRequests = 0;

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

function queueRequest(requestFn) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ requestFn, resolve, reject });
    processRequestQueue();
  });
}

// Spotify API wrapper with retry logic and exponential backoff
async function makeSpotifyRequest(requestFn, retries = MAX_RETRIES, accessToken = null) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await queueRequest(requestFn);
    } catch (error) {
      if (error.response) {
        const status = error.response.status;
        
        if (status === 429) {
          const retryAfter = parseInt(error.response.headers['retry-after'] || '1', 10) * 1000;
          const delay = retryAfter + (RETRY_DELAY_BASE * Math.pow(2, attempt));
          console.log(`Rate limited (429). Retrying after ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// API response cache (5min TTL)
async function makeCachedSpotifyRequest(cacheKey, requestFn, ttl = 300) {
  const cached = apiCache.get(cacheKey);
  if (cached) {
    console.log(`Cache hit: ${cacheKey}`);
    return cached;
  }

  console.log(`Cache miss: ${cacheKey}`);
  const response = await makeSpotifyRequest(requestFn);
  apiCache.set(cacheKey, response, ttl);
  return response;
}

// Generate deterministic cache keys
function getUserCacheKey(userId, endpoint, params = {}) {
  const paramStr = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `user:${userId}:${endpoint}${paramStr ? ':' + paramStr : ''}`;
}

function clearUserCache(userId) {
  const keys = apiCache.keys();
  const userKeys = keys.filter(k => k.startsWith(`user:${userId}:`));
  userKeys.forEach(k => apiCache.del(k));
  console.log(`Cleared ${userKeys.length} cached entries for user ${userId}`);
}

// Session-level cache (per-user, survives across requests)
async function getSessionCachedData(req, key, fetchFn, maxAge = 5 * 60 * 1000) {
  if (!req.user.sessionCache) {
    req.user.sessionCache = {};
  }

  const cached = req.user.sessionCache[key];
  const now = Date.now();

  if (cached && cached.timestamp && (now - cached.timestamp) < maxAge) {
    console.log(`Session cache hit: ${key}`);
    return cached.data;
  }

  console.log(`Session cache miss: ${key}`);
  const data = await fetchFn();
  
  req.user.sessionCache[key] = { data, timestamp: now };
  return data;
}

// Prefetch user data after authentication
async function prefetchUserData(req) {
  const accessToken = req.user.accessToken;
  const userId = req.user.profile?.id || 'unknown';

  try {
    if (!req.user.market) {
      const userProfile = await makeCachedSpotifyRequest(
        getUserCacheKey(userId, 'profile'),
        () => axios.get('https://api.spotify.com/v1/me', {
          headers: { Authorization: `Bearer ${accessToken}` }
        }),
        600
      );
      req.user.market = userProfile.data.country || 'US';
    }

    console.log(`Prefetched data for user ${userId}`);
  } catch (error) {
    console.error('Error prefetching user data:', error.message);
  }
}

function validatePlaylistName(name) {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= 100;
}

function sanitizePlaylistName(name, defaultName) {
  if (!validatePlaylistName(name)) {
    return defaultName;
  }
  return name.trim();
}

// Create playlist and add tracks in batches
async function createSinglePlaylist(accessToken, name, description, trackUris) {
  if (!trackUris || trackUris.length === 0) {
    return { success: false, playlistId: null, error: 'No tracks provided' };
  }

  try {
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

// Fetch liked songs and categorize by mood using audio features
async function fetchAndCategorizeTracks(user, category) {
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
      
      // Refresh token periodically for long operations
      if (batchNumber % 10 === 0) {
        accessToken = await ensureValidToken(user);
      }
      
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

// Categorize tracks by valence (positivity) and energy (intensity)
function categorizeTrack(features) {
  if (!features || typeof features.valence !== 'number' || typeof features.energy !== 'number') {
    return 'mellow';
  }

  const { valence, energy } = features;

  if (valence > MOOD_THRESHOLDS.ENERGETIC_VALENCE && energy > MOOD_THRESHOLDS.ENERGETIC_ENERGY) {
    return 'energetic';
  } 
  else if (valence < MOOD_THRESHOLDS.LOW_ENERGY_VALENCE && energy < MOOD_THRESHOLDS.LOW_ENERGY_ENERGY) {
    return 'lowEnergy';
  }
  return 'mellow';
}

// Calculate discovery vs comfort ratio: tracks both in top tracks AND top artists = comfort
async function calculateDiscoveryRatio(accessToken, user, recentTracks = null) {
  try {
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
      return { comfortPercent: 0, discoveryPercent: 0, comfortCount: 0, discoveryCount: 0, totalTracks: 0 };
    }

    const userId = user.profile?.id || 'unknown';
    
    const [topTracksResponse, topArtistsResponse] = await Promise.all([
      makeCachedSpotifyRequest(
        getUserCacheKey(userId, 'top-tracks', { time_range: 'medium_term', limit: 50 }),
        () => axios.get('https://api.spotify.com/v1/me/top/tracks', {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: { limit: 50, time_range: 'medium_term' }
        }),
        300
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

    const topTrackIds = new Set();
    (topTracksResponse.data.items || []).forEach(track => {
      if (track && track.id) topTrackIds.add(track.id);
    });

    const topArtistIds = new Set();
    (topArtistsResponse.data.items || []).forEach(artist => {
      if (artist && artist.id) topArtistIds.add(artist.id);
    });

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

      if (isTopTrack && isTopArtist) {
        comfortCount++;
      } else {
        discoveryCount++;
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

function formatHourRange(hour) {
  const startHour = hour % 12 || 12;
  const startPeriod = hour < 12 ? 'AM' : 'PM';
  const endHour = (hour + 1) % 12 || 12;
  const endPeriod = (hour + 1) < 12 ? 'AM' : 'PM';
  return `${startHour}:00-${endHour}:00${endPeriod}`;
}

// Generate weekly listening heatmap with most common hour per day
function generateHeatmapData(recentTracks) {
  const heatmapGrid = Array(7).fill(null).map(() => Array(24).fill(0));
  
  let maxCount = 0;
  let peakDay = 0;
  let peakHour = 0;

  recentTracks.forEach(trackItem => {
    if (!trackItem || !trackItem.played_at) return;

    const playedAt = new Date(trackItem.played_at);
    const dayOfWeek = playedAt.getDay();
    const hour = playedAt.getHours();

    if (dayOfWeek >= 0 && dayOfWeek < 7 && hour >= 0 && hour < 24) {
      heatmapGrid[dayOfWeek][hour]++;

      if (heatmapGrid[dayOfWeek][hour] > maxCount) {
        maxCount = heatmapGrid[dayOfWeek][hour];
        peakDay = dayOfWeek;
        peakHour = hour;
      }
    }
  });

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
      const discoveryData = await calculateDiscoveryRatio(accessToken, req.user, recentTracks);
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
      const discoveryData = await calculateDiscoveryRatio(accessToken, req.user, recentTracks);
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

    const [artistResponses, discoveryData] = await Promise.all([
      Promise.all(artistBatchPromises),
      calculateDiscoveryRatio(accessToken, req.user, recentTracks)
    ]);

    const heatmapData = generateHeatmapData(recentTracks);
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

app.get('/logout', (req, res, next) => {
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

app.get('/get-top-tracks', ensureAuthenticated, refreshTokenIfNeeded, async (req, res) => {
  const accessToken = req.user.accessToken;
  const timeRange = req.query.time_range || 'medium_term';

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
      300
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

app.get('/get-top-artists', ensureAuthenticated, refreshTokenIfNeeded, async (req, res) => {
  const accessToken = req.user.accessToken;
  const timeRange = req.query.time_range || 'medium_term';
  const userId = req.user.profile?.id || 'unknown';

  try {
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
        req.user.market = userMarket;
      } catch (error) {
        userMarket = 'US';
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
      300
    );

    const artists = response.data.items || [];

    res.render('top-artists', { artists, timeRange, userMarket });
  } catch (error) {
    console.error('Error fetching top artists:', error.response ? error.response.data : error.message);
    res.status(500).render('error', { 
      message: 'Error fetching top artists. Please try again.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.get('/api/artist/:artistId/top-track', ensureAuthenticated, refreshTokenIfNeeded, async (req, res) => {
  const accessToken = req.user.accessToken;
  const artistId = req.params.artistId;
  const userMarket = req.user.market || 'US';

  try {
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
      600
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

app.get('/get-artist-dive', ensureAuthenticated, refreshTokenIfNeeded, async (req, res) => {
  if (IS_ARTIST_DIVE_DISABLED) {
    return res.status(503).render('error', {
      message: 'Artist Deep Dive is temporarily disabled while we refactor the background job pipeline.',
      error: process.env.NODE_ENV === 'development' ? 'Feature temporarily disabled' : undefined
    });
  }

  const accessToken = req.user.accessToken;
  const timeRange = req.query.time_range || 'medium_term';
  const userId = req.user.profile?.id || 'unknown';

  try {
    let userMarket = req.user.market;
    if (!userMarket) {
      const userProfileResponse = await makeCachedSpotifyRequest(
        getUserCacheKey(userId, 'profile'),
        () => axios.get('https://api.spotify.com/v1/me', {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        }),
        600
      );
      userMarket = userProfileResponse.data.country || 'US';
      req.user.market = userMarket;
    }

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
      300
    );

    const topArtists = topArtistsResponse.data.items || [];

    if (topArtists.length === 0) {
      return res.render('artist-dive', { artists: [], timeRange });
    }

    const userTracksSet = new Set();

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

    const artistAnalysisPromises = topArtists.slice(0, 20).map(async artist => {
      try {
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
          missingTracks: missingTracks.slice(0, 10)
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

    const sortedArtists = artistAnalyses
      .filter(analysis => analysis.totalTracks > 0)
      .sort((a, b) => a.coveragePercent - b.coveragePercent)
      .slice(0, 15);

    res.render('artist-dive', { artists: sortedArtists, timeRange });
  } catch (error) {
    console.error('Error fetching artist dive data:', error.response ? error.response.data : error.message);
    res.status(500).render('error', { 
      message: 'Error fetching artist dive data. Please try again.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

app.post('/create-artist-playlist/:artistId', ensureAuthenticated, refreshTokenIfNeeded, async (req, res) => {
  const accessToken = await ensureValidToken(req.user);
  const artistId = req.params.artistId;
  const playlistName = sanitizePlaylistName(req.body.name || '', `Deep Dive - ${req.body.artistName || 'Artist'}`);

  try {
    const userProfileResponse = await makeSpotifyRequest(() =>
      axios.get('https://api.spotify.com/v1/me', {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
      })
    );
    const userMarket = userProfileResponse.data.country || 'US';
    const userId = userProfileResponse.data.id;

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

    const missingTracks = artistTopTracks
      .filter(track => track && track.id && !userTracksSet.has(track.id))
      .map(track => track.uri);

    if (missingTracks.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'You\'ve already heard all of this artist\'s top tracks!'
      });
    }

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

// Process playlist creation job in background
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

app.post('/create-playlist/energetic', ensureAuthenticated, refreshTokenIfNeeded, async (req, res) => {
  const playlistName = sanitizePlaylistName(req.body.name, 'Energetic Vibes');
  const jobId = createJob('playlist', { category: 'energetic', playlistName });
  
  processPlaylistJob(jobId, req.user, 'energetic', playlistName, 'Energetic playlist created from your liked songs')
    .catch(err => console.error('Job error:', err));
  
  res.json({ success: true, jobId, message: 'Playlist creation started. Check progress with the job ID.', checkUrl: `/api/job/${jobId}` });
});

app.post('/create-playlist/mellow', ensureAuthenticated, refreshTokenIfNeeded, async (req, res) => {
  const playlistName = sanitizePlaylistName(req.body.name, 'Mellow Tunes');
  const jobId = createJob('playlist', { category: 'mellow', playlistName });
  
  processPlaylistJob(jobId, req.user, 'mellow', playlistName, 'Mellow playlist created from your liked songs')
    .catch(err => console.error('Job error:', err));
  
  res.json({ success: true, jobId, message: 'Playlist creation started. Check progress with the job ID.', checkUrl: `/api/job/${jobId}` });
});

app.post('/create-playlist/chill', ensureAuthenticated, refreshTokenIfNeeded, async (req, res) => {
  const playlistName = sanitizePlaylistName(req.body.name, 'Chill Vibes');
  const jobId = createJob('playlist', { category: 'chill', playlistName });
  
  processPlaylistJob(jobId, req.user, 'lowEnergy', playlistName, 'Chill playlist created from your liked songs')
    .catch(err => console.error('Job error:', err));
  
  res.json({ success: true, jobId, message: 'Playlist creation started. Check progress with the job ID.', checkUrl: `/api/job/${jobId}` });
});

// Reset test state for Jest
function resetTestState() {
  jobStore.clear();
  requestQueue = [];
  activeRequests = 0;
  apiCache.flushAll();
}

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
