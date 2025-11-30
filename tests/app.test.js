jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn()
}));

const axios = require('axios');
const {
  createJob,
  updateJob,
  getJob,
  cleanupOldJobs,
  ensureAuthenticated,
  refreshTokenIfNeeded,
  ensureValidToken,
  queueRequest,
  makeSpotifyRequest,
  makeCachedSpotifyRequest,
  getUserCacheKey,
  clearUserCache,
  getSessionCachedData,
  validatePlaylistName,
  sanitizePlaylistName,
  categorizeTrack,
  generateHeatmapData,
  calculateDiscoveryRatio,
  resetTestState
} = require('../app');

const advanceTimers = async (ms) => {
  if (typeof jest.advanceTimersByTimeAsync === 'function') {
    await jest.advanceTimersByTimeAsync(ms);
  } else {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
  }
};

describe('app utilities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetTestState();
  });

  describe('job management', () => {
    test('creates and updates jobs correctly', () => {
      const jobId = createJob('playlist', { foo: 'bar' });
      const job = getJob(jobId);
      expect(job).toMatchObject({
        id: expect.any(String),
        type: 'playlist',
        status: 'pending',
        progress: 0
      });

      updateJob(jobId, { status: 'processing', progress: 25 });
      const updatedJob = getJob(jobId);
      expect(updatedJob.status).toBe('processing');
      expect(updatedJob.progress).toBe(25);
    });

    test('cleanup removes stale completed jobs', () => {
      const jobId = createJob('playlist', {});
      updateJob(jobId, {
        status: 'completed',
        createdAt: Date.now() - (2 * 60 * 60 * 1000)
      });
      cleanupOldJobs();
      expect(getJob(jobId)).toBeNull();
    });
  });

  describe('authentication middleware', () => {
    test('ensureAuthenticated calls next when user logged in', () => {
      const req = { isAuthenticated: () => true };
      const res = { redirect: jest.fn() };
      const next = jest.fn();
      ensureAuthenticated(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.redirect).not.toHaveBeenCalled();
    });

    test('ensureAuthenticated redirects when not logged in', () => {
      const req = { isAuthenticated: () => false };
      const res = { redirect: jest.fn() };
      const next = jest.fn();
      ensureAuthenticated(req, res, next);
      expect(res.redirect).toHaveBeenCalledWith('/auth/spotify');
      expect(next).not.toHaveBeenCalled();
    });

    test('refreshTokenIfNeeded skips when user missing', async () => {
      const req = {};
      const res = { redirect: jest.fn() };
      const next = jest.fn();
      await refreshTokenIfNeeded(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.redirect).not.toHaveBeenCalled();
      expect(axios.post).not.toHaveBeenCalled();
    });

    test('refreshTokenIfNeeded refreshes tokens near expiry', async () => {
      const req = {
        user: {
          accessToken: 'old-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now()
        }
      };
      const res = { redirect: jest.fn() };
      const next = jest.fn();
      axios.post.mockResolvedValueOnce({
        data: { access_token: 'new-token', expires_in: 3600 }
      });

      await refreshTokenIfNeeded(req, res, next);

      expect(req.user.accessToken).toBe('new-token');
      expect(req.user.expiresAt).toBeGreaterThan(Date.now());
      expect(next).toHaveBeenCalled();
    });

    test('refreshTokenIfNeeded redirects on refresh failure', async () => {
      const req = {
        user: {
          accessToken: 'old-token',
          refreshToken: 'refresh-token',
          expiresAt: Date.now()
        }
      };
      const res = { redirect: jest.fn() };
      const next = jest.fn();
      axios.post.mockRejectedValueOnce(new Error('refresh failed'));

      await refreshTokenIfNeeded(req, res, next);

      expect(res.redirect).toHaveBeenCalledWith('/auth/spotify');
      expect(next).not.toHaveBeenCalled();
    });

    test('ensureValidToken returns current token when fresh', async () => {
      const user = {
        accessToken: 'fresh-token',
        expiresAt: Date.now() + (10 * 60 * 1000)
      };
      const token = await ensureValidToken(user);
      expect(token).toBe('fresh-token');
      expect(axios.post).not.toHaveBeenCalled();
    });

    test('ensureValidToken refreshes when expired', async () => {
      const user = {
        accessToken: 'old-token',
        refreshToken: 'refresh',
        expiresAt: Date.now()
      };
      axios.post.mockResolvedValueOnce({
        data: { access_token: 'new-token', expires_in: 1800 }
      });
      const token = await ensureValidToken(user);
      expect(token).toBe('new-token');
    });

    test('ensureValidToken throws on failure', async () => {
      const user = {
        accessToken: 'old-token',
        refreshToken: 'refresh',
        expiresAt: Date.now()
      };
      axios.post.mockRejectedValueOnce(new Error('boom'));
      await expect(ensureValidToken(user)).rejects.toThrow('Token refresh failed');
    });
  });

  describe('request queue', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    test('queueRequest executes async functions', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      const result = await queueRequest(fn);
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('makeSpotifyRequest retries on 429', async () => {
      jest.useFakeTimers();
      const requestFn = jest
        .fn()
        .mockRejectedValueOnce({
          response: { status: 429, headers: { 'retry-after': '0' } }
        })
        .mockResolvedValueOnce({ data: 'success' });

      const promise = makeSpotifyRequest(requestFn, 2);
      await advanceTimers(1000);
      const result = await promise;

      expect(result).toEqual({ data: 'success' });
      expect(requestFn).toHaveBeenCalledTimes(2);
    });

    test('makeSpotifyRequest throws friendly error on 403', async () => {
      const requestFn = jest.fn().mockRejectedValue({
        response: { status: 403 }
      });

      await expect(makeSpotifyRequest(requestFn, 1)).rejects.toThrow('Access forbidden. Please try logging in again.');
      expect(requestFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('caching helpers', () => {
    test('makeCachedSpotifyRequest reuses cached value', async () => {
      const cacheKey = getUserCacheKey('user1', 'top-tracks', { limit: 10 });
      const requestFn = jest.fn().mockResolvedValue({ data: { items: [1] } });

      const first = await makeCachedSpotifyRequest(cacheKey, requestFn, 60);
      const second = await makeCachedSpotifyRequest(cacheKey, requestFn, 60);

      expect(first).toEqual({ data: { items: [1] } });
      expect(second).toEqual(first);
      expect(requestFn).toHaveBeenCalledTimes(1);
    });

    test('clearUserCache invalidates stored entries', async () => {
      const cacheKey = getUserCacheKey('user2', 'top-artists', { limit: 5 });
      const requestFn = jest.fn().mockResolvedValue({ data: { items: [] } });

      await makeCachedSpotifyRequest(cacheKey, requestFn, 60);
      clearUserCache('user2');
      await makeCachedSpotifyRequest(cacheKey, requestFn, 60);

      expect(requestFn).toHaveBeenCalledTimes(2);
    });

    test('getSessionCachedData stores result in session cache', async () => {
      const req = { user: {} };
      const fetchFn = jest.fn().mockResolvedValue({ foo: 'bar' });
      const first = await getSessionCachedData(req, 'profile', fetchFn);
      const second = await getSessionCachedData(req, 'profile', fetchFn);
      expect(first).toEqual({ foo: 'bar' });
      expect(second).toEqual(first);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('validation helpers', () => {
    test('validatePlaylistName enforces constraints', () => {
      expect(validatePlaylistName('  valid name  ')).toBe(true);
      expect(validatePlaylistName('')).toBe(false);
      expect(validatePlaylistName(' '.repeat(101))).toBe(false);
    });

    test('sanitizePlaylistName falls back to default', () => {
      expect(sanitizePlaylistName(' My Mix ', 'Default')).toBe('My Mix');
      expect(sanitizePlaylistName('', 'Default')).toBe('Default');
    });
  });

  describe('categorization and analytics', () => {
    test('categorizeTrack uses thresholds', () => {
      expect(categorizeTrack({ valence: 0.7, energy: 0.7 })).toBe('energetic');
      expect(categorizeTrack({ valence: 0.2, energy: 0.2 })).toBe('lowEnergy');
      expect(categorizeTrack({ valence: 0.5, energy: 0.4 })).toBe('mellow');
      expect(categorizeTrack(null)).toBe('mellow');
    });

    test('generateHeatmapData computes peaks', () => {
      const tracks = [
        { played_at: new Date('2024-01-01T08:15:00Z').toISOString() }, // Monday 08 UTC
        { played_at: new Date('2024-01-01T08:45:00Z').toISOString() },
        { played_at: new Date('2024-01-02T21:15:00Z').toISOString() } // Tuesday 21 UTC
      ];
      const data = generateHeatmapData(tracks);
      expect(data.maxCount).toBeGreaterThan(0);
      expect(data.dayData).toHaveLength(7);
      expect(data.peakDay).toBeGreaterThanOrEqual(0);
      expect(data.peakHour).toBeGreaterThanOrEqual(0);
    });

    test('calculateDiscoveryRatio splits comfort vs discovery', async () => {
      const recentTracks = [
        { track: { id: 'track1', artists: [{ id: 'artist1' }] } },
        { track: { id: 'track2', artists: [{ id: 'artist2' }] } }
      ];

      axios.get
        .mockResolvedValueOnce({ data: { items: [{ id: 'track1' }] } }) // top tracks
        .mockResolvedValueOnce({ data: { items: [{ id: 'artist1' }] } }); // top artists

      const result = await calculateDiscoveryRatio('token', { profile: { id: 'user' } }, recentTracks);

      expect(result).toEqual(
        expect.objectContaining({
          comfortCount: 1,
          discoveryCount: 1,
          comfortPercent: 50,
          discoveryPercent: 50,
          totalTracks: 2
        })
      );
    });
  });
});

