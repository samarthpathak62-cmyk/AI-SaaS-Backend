-- Which gateway the user's active subscription (if any) is on, plus Paymenter-side IDs
-- mirroring the Stripe columns that already exist (stripe_customer_id, stripe_subscription_id).
ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_provider TEXT; -- 'stripe' | 'paymenter' | NULL
ALTER TABLE users ADD COLUMN IF NOT EXISTS paymenter_user_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS paymenter_order_id TEXT;
CREATE INDEX IF NOT EXISTS idx_users_paymenter_order ON users(paymenter_order_id);
