const jwt = require('jsonwebtoken');
const { query } = require('../db/postgres');
const { hashApiKey } = require('../lib/crypto');
const { PLANS } = require('../config/plans');

const JWT_SECRET = process.env.JWT_SECRET;

// A gap shorter than this counts as "still in the same active session" and is added
// to usage_seconds_today. A longer gap means the user stepped away - that idle time
// is free and doesn't burn into their 2-hour daily cap.
const FREE_SESSION_IDLE_GAP_SECONDS = 5 * 60; // 5 minutes
// Safety cap per single request, in case a request somehow takes an unrealistically
// long time (e.g. a long-running stream) - stops one request from eating the whole day.
const MAX_SECONDS_PER_REQUEST = 10 * 60; // 10 minutes

function resetDailyQuotaIfNeeded(user) {
  const today = new Date().toISOString().slice(0, 10);
  const resetDate = user.usage_reset_date instanceof Date
    ? user.usage_reset_date.toISOString().slice(0, 10)
    : user.usage_reset_date;
  if (resetDate !== today) {
    query('UPDATE users SET tokens_used_today = 0, usage_seconds_today = 0, usage_reset_date = $1 WHERE id = $2', [today, user.id])
      .catch(() => {});
    user.tokens_used_today = 0;
    user.usage_seconds_today = 0;
  }
  return user;
}

// Free-plan-only: enforces the 2-hour (configurable via config/plans.js) daily active-usage
// cap, and updates usage_seconds_today based on how close together requests are coming in.
// Returns { allowed: boolean, secondsUsedToday, limitSeconds }. Paid plans (no limit
// configured) always return allowed: true and skip the DB write entirely.
async function trackFreeUsageTime(user) {
  const planDef = PLANS[user.plan] || PLANS.free;
  const limitSeconds = planDef.daily_usage_seconds_limit;
  if (!limitSeconds) return { allowed: true };

  if (user.usage_seconds_today >= limitSeconds) {
    return { allowed: false, secondsUsedToday: user.usage_seconds_today, limitSeconds };
  }

  const now = new Date();
  const last = user.last_activity_at ? new Date(user.last_activity_at) : null;
  let addSeconds = 0;
  if (last) {
    const gapSeconds = (now - last) / 1000;
    if (gapSeconds > 0 && gapSeconds < FREE_SESSION_IDLE_GAP_SECONDS) {
      addSeconds = Math.min(gapSeconds, MAX_SECONDS_PER_REQUEST);
    }
  }

  const newTotal = Math.min(user.usage_seconds_today + addSeconds, limitSeconds);
  await query('UPDATE users SET usage_seconds_today = $1, last_activity_at = $2 WHERE id = $3', [newTotal, now, user.id]);
  user.usage_seconds_today = newTotal;
  user.last_activity_at = now;

  return { allowed: true, secondsUsedToday: newTotal, limitSeconds };
}

// For dashboard/account endpoints - short-lived JWT access token from login
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== 'access') return res.status(401).json({ error: 'Wrong token type' });

    const { rows } = await query('SELECT * FROM users WHERE id = $1', [payload.id]);
    let user = rows[0];
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (!user.is_active) return res.status(403).json({ error: 'Account suspended' });

    user = resetDailyQuotaIfNeeded(user);
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// For model calls - long-lived API key (from the api_keys table, not the login password)
async function requireApiKey(req, res, next) {
  const header = req.headers.authorization || '';
  const key = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'Missing API key' });

  const keyHash = hashApiKey(key);
  const { rows } = await query(
    `SELECT k.id AS key_id, k.expires_at, k.revoked_at, k.scopes, u.*
     FROM api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = $1`,
    [keyHash]
  );
  const row = rows[0];
  if (!row) return res.status(401).json({ error: 'Invalid API key' });
  if (row.revoked_at) return res.status(401).json({ error: 'This API key has been revoked' });
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return res.status(401).json({ error: 'This API key has expired' });
  }
  if (!row.is_active) return res.status(403).json({ error: 'Account suspended' });

  let user = row;
  user = resetDailyQuotaIfNeeded(user);

  if (user.tokens_used_today >= user.daily_token_limit) {
    return res.status(429).json({ error: 'Daily token limit reached. Try again tomorrow or upgrade plan.' });
  }

  const usageTime = await trackFreeUsageTime(user);
  if (!usageTime.allowed) {
    return res.status(429).json({
      error: 'Free plan daily usage limit (2 hours) reached. Upgrade to Pro/Business for unlimited usage time, or try again tomorrow.',
      seconds_used_today: usageTime.secondsUsedToday,
      limit_seconds: usageTime.limitSeconds
    });
  }

  query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.key_id]).catch(() => {});

  req.user = user;
  req.apiKeyId = row.key_id;
  req.apiKeyScopes = row.scopes || [];
  next();
}

// Role-based access control: requireRole('admin'), requireRole('admin', 'developer'), etc.
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: `Requires one of these roles: ${allowedRoles.join(', ')}` });
    }
    next();
  };
}

module.exports = { requireAuth, requireApiKey, requireRole };
