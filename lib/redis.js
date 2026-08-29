const Redis = require('ioredis');
const logger = require('../logger');

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 200, 5000)
});

redis.on('error', (err) => logger.error('Redis error', { error: err.message }));
redis.on('connect', () => logger.info('Redis connected'));

// Simple cache helpers (JSON in/out)
async function cacheGet(key) {
  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : null;
}
async function cacheSet(key, value, ttlSeconds = 60) {
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
}
async function cacheDel(key) {
  await redis.del(key);
}

module.exports = { redis, cacheGet, cacheSet, cacheDel };
