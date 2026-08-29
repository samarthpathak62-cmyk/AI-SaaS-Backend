const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis').default;
const { redis } = require('../lib/redis');

// Requests-per-minute ceiling by plan. Adjust to taste.
const RPM_BY_PLAN = {
  free: 10,
  developer: 60,
  pro: 60,
  business: 300,
  admin: 1000
};

// Backed by Redis so limits are shared across server restarts / multiple app instances.
// NOTE: requireApiKey must run BEFORE this middleware so req.user is populated.
const planRateLimit = rateLimit({
  windowMs: 60 * 1000,
  keyGenerator: (req) => (req.user ? `ratelimit:user:${req.user.id}` : `ratelimit:ip:${req.ip}`),
  max: (req) => RPM_BY_PLAN[req.user?.plan] || RPM_BY_PLAN[req.user?.role] || RPM_BY_PLAN.free,
  message: { error: 'Rate limit exceeded for your plan. Slow down or upgrade for a higher limit.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({
    sendCommand: (...args) => redis.call(...args)
  })
});

module.exports = { planRateLimit, RPM_BY_PLAN };
