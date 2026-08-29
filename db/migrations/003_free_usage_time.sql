-- Tracks "active usage time" for the free plan's 2-hour daily cap.
-- usage_seconds_today accumulates only while requests are close together (see
-- middleware/auth.js trackFreeUsageTime) - long idle gaps don't count against the cap.
ALTER TABLE users ADD COLUMN IF NOT EXISTS usage_seconds_today INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;
