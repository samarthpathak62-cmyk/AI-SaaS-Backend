const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db/postgres');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const schemas = require('../schemas');
const { auditLog } = require('../lib/audit');
const { PLANS } = require('../config/plans');

const router = express.Router();

router.get('/me', requireAuth, (req, res) => {
  const u = req.user;
  const planDef = PLANS[u.plan] || PLANS.free;
  res.json({
    id: u.id,
    username: u.username,
    email: u.email,
    email_verified: u.email_verified,
    role: u.role,
    plan: u.plan,
    plan_status: u.plan_status,
    payment_provider: u.payment_provider,
    daily_token_limit: u.daily_token_limit,
    tokens_used_today: u.tokens_used_today,
    tokens_remaining_today: Math.max(0, u.daily_token_limit - u.tokens_used_today),
    daily_usage_seconds_limit: planDef.daily_usage_seconds_limit,
    usage_seconds_today: u.usage_seconds_today,
    usage_seconds_remaining_today: planDef.daily_usage_seconds_limit
      ? Math.max(0, planDef.daily_usage_seconds_limit - u.usage_seconds_today)
      : null,
    referral_code: u.referral_code,
    created_at: u.created_at
  });
});

router.get('/history', requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT id, prompt_tokens, completion_tokens, total_tokens, image_count, model, status, created_at
     FROM request_logs WHERE user_id = $1 ORDER BY id DESC LIMIT 50`,
    [req.user.id]
  );
  res.json({ history: rows });
});

router.post('/change-password', requireAuth, validate(schemas.changePassword), async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!bcrypt.compareSync(current_password, req.user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [req.user.id]);
  await auditLog({ userId: req.user.id, actorRole: req.user.role, action: 'password.changed', req });
  res.json({ message: 'Password changed. Please log in again on other devices.' });
});

// GDPR-style data export: everything we hold about this user, as one JSON file.
router.get('/export', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const [profile, apiKeys, conversations, messages, requestLogs, auditLogs] = await Promise.all([
    query(`SELECT id, username, email, email_verified, role, plan, plan_status,
                  daily_token_limit, referral_code, created_at
           FROM users WHERE id = $1`, [userId]),
    query(`SELECT id, name, key_prefix, scopes, expires_at, last_used_at, revoked_at, created_at
           FROM api_keys WHERE user_id = $1`, [userId]),
    query(`SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = $1`, [userId]),
    query(`SELECT m.id, m.conversation_id, m.role, m.content, m.created_at
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE c.user_id = $1`, [userId]),
    query(`SELECT id, prompt_tokens, completion_tokens, total_tokens, image_count, model,
                  provider, cost_usd, status, created_at
           FROM request_logs WHERE user_id = $1`, [userId]),
    query(`SELECT id, action, target_type, target_id, created_at
           FROM audit_logs WHERE user_id = $1`, [userId])
  ]);

  await auditLog({ userId, actorRole: req.user.role, action: 'account.data_exported', req });

  res.setHeader('Content-Disposition', `attachment; filename="account-export-${userId}.json"`);
  res.json({
    exported_at: new Date().toISOString(),
    profile: profile.rows[0],
    api_keys: apiKeys.rows,
    conversations: conversations.rows,
    messages: messages.rows,
    request_logs: requestLogs.rows,
    audit_logs: auditLogs.rows
  });
});

// Permanent account deletion. Requires current password + typing "DELETE" to confirm.
// Cascades to api_keys, refresh_tokens, conversations (and their messages), request_logs;
// audit_logs keep the row but user_id is set NULL (see schema ON DELETE SET NULL).
router.post('/delete', requireAuth, validate(schemas.deleteAccount), async (req, res) => {
  const { password } = req.body;
  if (!bcrypt.compareSync(password, req.user.password_hash)) {
    return res.status(401).json({ error: 'Password is incorrect' });
  }

  await auditLog({ userId: req.user.id, actorRole: req.user.role, action: 'account.deleted', req });
  await query('DELETE FROM users WHERE id = $1', [req.user.id]);

  res.json({ message: 'Account and all associated data permanently deleted.' });
});

module.exports = router;
