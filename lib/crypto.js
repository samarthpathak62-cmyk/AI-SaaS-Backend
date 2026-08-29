const crypto = require('crypto');

// Generates a raw API key like "sk-live-a1b2c3..." — shown to the user ONCE.
function generateApiKey() {
  const raw = crypto.randomBytes(24).toString('hex');
  return `sk-${raw}`;
}

// We never store the raw key — only its SHA-256 hash, like a password.
function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function generateReferralCode() {
  return crypto.randomBytes(4).toString('hex');
}

function generateOpaqueToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { generateApiKey, hashApiKey, generateReferralCode, generateOpaqueToken };
