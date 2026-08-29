const express = require('express');
const { query } = require('../db/postgres');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/conversations - list this user's chats, most recent first
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT id, title, created_at, updated_at FROM conversations
     WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 100`,
    [req.user.id]
  );
  res.json({ conversations: rows });
});

// GET /api/conversations/:id - full message history for one chat
router.get('/:id', requireAuth, async (req, res) => {
  const convo = await query('SELECT id FROM conversations WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!convo.rows[0]) return res.status(404).json({ error: 'Conversation not found' });

  const { rows } = await query(
    'SELECT id, role, content, created_at FROM messages WHERE conversation_id = $1 ORDER BY id ASC',
    [req.params.id]
  );
  res.json({ conversation_id: Number(req.params.id), messages: rows });
});

// DELETE /api/conversations/:id
router.delete('/:id', requireAuth, async (req, res) => {
  const { rows } = await query(
    'DELETE FROM conversations WHERE id = $1 AND user_id = $2 RETURNING id',
    [req.params.id, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ message: 'Conversation deleted' });
});

module.exports = router;
