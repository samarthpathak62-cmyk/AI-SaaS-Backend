const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query, withTransaction } = require('../db/postgres');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const schemas = require('../schemas');
const { generateOpaqueToken, generateReferralCode, hashApiKey, generateApiKey } = require('../lib/crypto');
const { auditLog } = require('../lib/audit');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../utils/email');
const logger = require('../logger');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
const ACCESS_EXPIRES = process.env.JWT_ACCESS_EXPIRES_IN || '15m';
const REFRESH_DAYS = parseInt(process.env.JWT_REFRESH_EXPIRES_IN, 10) || 30; // days
const DEFAULT_LIMIT = parseInt(process.env.DEFAULT_DAILY_TOKEN_LIMIT || '20000', 10);

function signAccessToken(user) {
  return jwt.sign({ id: user.id, type: 'access', role: user.role }, JWT_SECRET, { expiresIn: ACCESS_EXPIRES });
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Issues a brand-new refresh token family (used at login/register)
async function issueRefreshTokenFamily(userId, req) {
  const raw = generateOpaqueToken();
  const familyId = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000);
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, hashToken(raw), familyId, expiresAt, req.ip, req.headers['user-agent'] || null]
  );
  return raw;
}

// POST /api/auth/register
router.post('/register', validate(schemas.register), async (req, res) => {
  const { username, email, password, referral_code } = req.body;

  const existing = await query('SELECT id FROM users WHERE email = $1 OR username = $2', [email, username]);
  if (existing.rows.length) return res.status(409).json({ error: 'Username or email already registered' });

  let referredBy = null;
  if (referral_code) {
    const ref = await query('SELECT id FROM users WHERE referral_code = $1', [referral_code]);
    if (ref.rows[0]) referredBy = ref.rows[0].id;
  }

  const password_hash = bcrypt.hashSync(password, 10);
  const myReferralCode = generateReferralCode();
  const verificationToken = generateOpaqueToken();
  const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const { rows } = await query(
    `INSERT INTO users (username, email, password_hash, daily_token_limit, referral_code, referred_by,
                         verification_token, verification_expires)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [username, email, password_hash, DEFAULT_LIMIT, myReferralCode, referredBy, verificationToken, verificationExpires]
  );
  const userId = rows[0].id;

  // Referral bonus: both users get +5000 permanent daily token allowance
  if (referredBy) {
    await query('UPDATE users SET daily_token_limit = daily_token_limit + 5000 WHERE id IN ($1,$2)', [userId, referredBy]);
  }

  sendVerificationEmail(email, verificationToken).catch(err =>
    logger.warn('Could not send verification email', { error: err.message })
  );

  const accessToken = signAccessToken({ id: userId, role: 'user' });
  const refreshToken = await issueRefreshTokenFamily(userId, req);

  await auditLog({ userId, actorRole: 'user', action: 'register', req });

  res.status(201).json({
    message: 'Account created. Check your email to verify your account.',
    access_token: accessToken,
    refresh_token: refreshToken
  });
});

// POST /api/auth/login
router.post('/login', validate(schemas.login), async (req, res) => {
  const { email, password } = req.body;

  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    if (user) {
      await query('UPDATE users SET failed_login_attempts = failed_login_attempts + 1 WHERE id = $1', [user.id]);
      await auditLog({ userId: user.id, action: 'login_failed', req });
      // Lock account for 15 minutes after 5 failed attempts
      if (user.failed_login_attempts + 1 >= 5) {
        await query("UPDATE users SET locked_until = now() + interval '15 minutes' WHERE id = $1", [user.id]);
      }
    }
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return res.status(403).json({ error: 'Account temporarily locked due to failed login attempts. Try again later.' });
  }
  if (!user.is_active) return res.status(403).json({ error: 'Account suspended' });

  await query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);

  const accessToken = signAccessToken(user);
  const refreshToken = await issueRefreshTokenFamily(user.id, req);

  await auditLog({ userId: user.id, actorRole: user.role, action: 'login', req });

  res.json({ access_token: accessToken, refresh_token: refreshToken });
});

// POST /api/auth/refresh-token — rotation with reuse detection
router.post('/refresh-token', validate(schemas.refreshToken), async (req, res) => {
  const { refresh_token } = req.body;
  const tokenHash = hashToken(refresh_token);

  const { rows } = await query('SELECT * FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);
  const record = rows[0];
  if (!record) return res.status(401).json({ error: 'Invalid refresh token' });

  if (record.revoked_at) {
    // This token was already used once before — someone is replaying a stolen token.
    // Nuke the entire token family so the attacker (and the legit user) are logged out.
    await query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [record.family_id]);
    await auditLog({ userId: record.user_id, action: 'refresh_token_reuse_detected', req });
    return res.status(401).json({ error: 'Refresh token reuse detected. All sessions revoked, please log in again.' });
  }

  if (new Date(record.expires_at) < new Date()) {
    return res.status(401).json({ error: 'Refresh token expired, please log in again' });
  }

  const { rows: userRows } = await query('SELECT * FROM users WHERE id = $1', [record.user_id]);
  const user = userRows[0];
  if (!user || !user.is_active) return res.status(403).json({ error: 'Account unavailable' });

  // Rotate: issue a new token in the same family, mark the old one used
  const newRaw = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000);

  await withTransaction(async (client) => {
    const insertResult = await client.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [user.id, hashToken(newRaw), record.family_id, expiresAt, req.ip, req.headers['user-agent'] || null]
    );
    await client.query('UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $1 WHERE id = $2', [
      insertResult.rows[0].id, record.id
    ]);
  });

  const accessToken = signAccessToken(user);
  res.json({ access_token: accessToken, refresh_token: newRaw });
});

// POST /api/auth/logout — revokes just this session's refresh token
router.post('/logout', validate(schemas.refreshToken), async (req, res) => {
  const tokenHash = hashToken(req.body.refresh_token);
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [tokenHash]);
  res.json({ message: 'Logged out' });
});

// POST /api/auth/verify-email
router.post('/verify-email', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token is required' });

  const { rows } = await query(
    'SELECT id FROM users WHERE verification_token = $1 AND verification_expires > now()',
    [token]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Invalid or expired verification link' });

  await query(
    'UPDATE users SET email_verified = TRUE, verification_token = NULL, verification_expires = NULL WHERE id = $1',
    [rows[0].id]
  );
  res.json({ message: 'Email verified successfully' });
});

// POST /api/auth/forgot-password
router.post('/forgot-password', validate(schemas.forgotPassword), async (req, res) => {
  const { email } = req.body;
  const { rows } = await query('SELECT id FROM users WHERE email = $1', [email]);

  // Always respond the same way, whether or not the email exists (avoids leaking who has an account)
  if (rows[0]) {
    const token = generateOpaqueToken();
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await query('UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3', [token, expires, rows[0].id]);
    sendPasswordResetEmail(email, token).catch(err => logger.warn('Could not send reset email', { error: err.message }));
  }
  res.json({ message: 'If that email is registered, a reset link has been sent.' });
});

// POST /api/auth/reset-password
router.post('/reset-password', validate(schemas.resetPassword), async (req, res) => {
  const { token, new_password } = req.body;
  const { rows } = await query(
    'SELECT id FROM users WHERE reset_token = $1 AND reset_token_expires > now()',
    [token]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Invalid or expired reset link' });

  const password_hash = bcrypt.hashSync(new_password, 10);
  await query(
    'UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2',
    [password_hash, rows[0].id]
  );
  // Log out all sessions after a password reset
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [rows[0].id]);
  await auditLog({ userId: rows[0].id, action: 'password.reset', req });

  res.json({ message: 'Password reset. Please log in again.' });
});

module.exports = router;
