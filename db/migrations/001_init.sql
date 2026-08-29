-- ============================================================
-- AI Backend — PostgreSQL schema
-- Run via: node db/migrate.js
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id                      SERIAL PRIMARY KEY,
  username                TEXT UNIQUE NOT NULL,
  email                   TEXT UNIQUE NOT NULL,
  password_hash           TEXT NOT NULL,
  role                    TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'developer', 'admin')),

  email_verified          BOOLEAN NOT NULL DEFAULT FALSE,
  verification_token      TEXT,
  verification_expires    TIMESTAMPTZ,
  reset_token             TEXT,
  reset_token_expires     TIMESTAMPTZ,

  plan                    TEXT NOT NULL DEFAULT 'free',
  plan_status             TEXT,
  stripe_customer_id      TEXT,
  stripe_subscription_id  TEXT,

  daily_token_limit       INTEGER NOT NULL DEFAULT 20000,
  tokens_used_today       INTEGER NOT NULL DEFAULT 0,
  usage_reset_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  alert_sent_date         DATE,

  referral_code           TEXT UNIQUE,
  referred_by             INTEGER REFERENCES users(id),

  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  failed_login_attempts   INTEGER NOT NULL DEFAULT 0,
  locked_until            TIMESTAMPTZ,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Multiple named API keys per user (create/revoke/expire independently of login password)
CREATE TABLE IF NOT EXISTS api_keys (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL DEFAULT 'default',
  key_prefix    TEXT NOT NULL,          -- first 8 chars shown in dashboards, e.g. "sk-a1b2"
  key_hash      TEXT NOT NULL UNIQUE,   -- sha256 hash of the full key (never store raw key)
  scopes        TEXT[] NOT NULL DEFAULT ARRAY['chat'],
  expires_at    TIMESTAMPTZ,            -- NULL = never expires
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

-- Refresh tokens with rotation: each refresh issues a new token and revokes the old one.
-- If a revoked token is presented again, that's theft/reuse -> revoke the whole family.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  family_id     TEXT NOT NULL,          -- shared by a token and all its rotated descendants
  replaced_by   INTEGER REFERENCES refresh_tokens(id),
  revoked_at    TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL,
  ip            TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family_id);

-- Every sensitive action gets logged here: login, key creation, plan change, admin actions, etc.
CREATE TABLE IF NOT EXISTS audit_logs (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_role  TEXT,                     -- role of whoever performed the action
  action      TEXT NOT NULL,            -- e.g. 'login', 'api_key.created', 'admin.plan_changed'
  target_type TEXT,                     -- e.g. 'user', 'api_key'
  target_id   TEXT,
  ip          TEXT,
  user_agent  TEXT,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS conversations (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         JSONB NOT NULL,       -- string OR vision-style array, stored as-is
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

CREATE TABLE IF NOT EXISTS request_logs (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prompt_tokens       INTEGER NOT NULL DEFAULT 0,
  completion_tokens   INTEGER NOT NULL DEFAULT 0,
  total_tokens        INTEGER NOT NULL DEFAULT 0,
  image_count         INTEGER NOT NULL DEFAULT 0,
  model               TEXT,
  latency_ms          INTEGER,
  status              TEXT DEFAULT 'success', -- success, error, moderated, rate_limited
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_request_logs_user ON request_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_created ON request_logs(created_at);

-- Safe to re-run: adds gateway columns if migrating from the pre-gateway schema
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_request_logs_provider ON request_logs(provider);
