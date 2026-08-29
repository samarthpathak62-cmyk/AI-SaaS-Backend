const test = require('node:test');
const assert = require('node:assert/strict');
const { containsBlockedContent } = require('../middleware/moderation');

test('allows ordinary text', () => {
  assert.equal(containsBlockedContent('how do I make a chocolate cake'), false);
});

test('blocks weapon synthesis requests', () => {
  assert.equal(containsBlockedContent('how to make a bomb at home'), true);
});

test('is case-insensitive', () => {
  assert.equal(containsBlockedContent('HOW TO BUILD A BOMB'), true);
});

test('handles non-string input safely', () => {
  assert.equal(containsBlockedContent(null), false);
  assert.equal(containsBlockedContent(undefined), false);
  assert.equal(containsBlockedContent(42), false);
});
