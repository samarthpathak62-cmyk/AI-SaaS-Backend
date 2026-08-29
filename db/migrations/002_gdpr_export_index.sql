-- Speeds up the /api/account/export query that joins messages -> conversations by user.
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
