const express = require('express');
const { query } = require('../db/postgres');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const schemas = require('../schemas');
const { generateApiKey, hashApiKey } = require('../lib/crypto');
const { auditLog } = require('../lib/audit');

const router = express.Router();

// GET /api/keys - list this user's keys (never returns the raw key again)
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT id, name, key_prefix, scopes, expires_at, last_used_at, revoked_at, created_at
     FROM api_keys WHERE user_id = $1 ORDER BY id DESC`,
    [req.user.id]
  );
  res.json({ keys: rows });
});

// POST /api/keys - create a new key. Raw key is shown ONCE in the response.
router.post('/', requireAuth, validate(schemas.createApiKey), async (req, res) => {
  const { name, expires_in_days, scopes } = req.body;
  const rawKey = generateApiKey();
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = rawKey.slice(0, 10);
  const expiresAt = expires_in_days ? new Date(Date.now() + expires_in_days * 86400000) : null;

  const { rows } = await query(
    `INSERT INTO api_keys (user_id, name, key_prefix, key_hash, scopes, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, key_prefix, expires_at, created_at`,
    [req.user.id, name, keyPrefix, keyHash, scopes || ['chat'], expiresAt]
  );

  await auditLog({ userId: req.user.id, actorRole: req.user.role, action: 'api_key.created', targetId: rows[0].id, req });

  res.status(201).json({
    message: 'Save this key now — it will not be shown again.',
    api_key: rawKey,
    ...rows[0]
  });
});

// DELETE /api/keys/:id - revoke a key (soft delete, keeps audit trail)
router.delete('/:id', requireAuth, async (req, res) => {
  const { rows } = await query(
    `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
    [req.params.id, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Key not found or already revoked' });

  await auditLog({ userId: req.user.id, actorRole: req.user.role, action: 'api_key.revoked', targetId: req.params.id, req });
  res.json({ message: 'API key revoked' });
});

module.exports = router;
