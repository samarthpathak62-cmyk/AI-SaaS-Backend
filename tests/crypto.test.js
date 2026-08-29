const test = require('node:test');
const assert = require('node:assert/strict');
const { generateApiKey, hashApiKey, generateReferralCode, generateOpaqueToken } = require('../lib/crypto');

test('generateApiKey produces a unique sk- prefixed key', () => {
  const a = generateApiKey();
  const b = generateApiKey();
  assert.match(a, /^sk-[a-f0-9]{48}$/);
  assert.notEqual(a, b);
});

test('hashApiKey is deterministic and one-way looking', () => {
  const key = generateApiKey();
  const hash1 = hashApiKey(key);
  const hash2 = hashApiKey(key);
  assert.equal(hash1, hash2);
  assert.notEqual(hash1, key);
  assert.equal(hash1.length, 64); // sha256 hex
});

test('generateReferralCode and generateOpaqueToken produce non-empty unique values', () => {
  assert.notEqual(generateReferralCode(), generateReferralCode());
  assert.notEqual(generateOpaqueToken(), generateOpaqueToken());
});
