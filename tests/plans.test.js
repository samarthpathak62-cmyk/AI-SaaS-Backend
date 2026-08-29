const test = require('node:test');
const assert = require('node:assert/strict');

process.env.STRIPE_PRICE_PRO = 'price_test_pro';
process.env.PAYMENTER_PRODUCT_PRO = '101';

delete require.cache[require.resolve('../config/plans')];
const { PLANS, planByPriceId, planByPaymenterProductId } = require('../config/plans');

test('free plan has a 2-hour usage-time cap and no purchase price', () => {
  assert.equal(PLANS.free.daily_usage_seconds_limit, 2 * 60 * 60);
  assert.equal(PLANS.free.stripe_price_id, null);
  assert.equal(PLANS.free.paymenter_product_id, null);
});

test('paid plans have no usage-time cap (token limit governs instead)', () => {
  assert.equal(PLANS.pro.daily_usage_seconds_limit, null);
  assert.equal(PLANS.business.daily_usage_seconds_limit, null);
});

test('planByPriceId resolves a configured Stripe price back to its plan key', () => {
  assert.equal(planByPriceId('price_test_pro'), 'pro');
  assert.equal(planByPriceId('price_does_not_exist'), null);
});

test('planByPaymenterProductId resolves a configured Paymenter product back to its plan key', () => {
  assert.equal(planByPaymenterProductId('101'), 'pro');
  assert.equal(planByPaymenterProductId(101), 'pro'); // works whether IDs arrive as string or number
  assert.equal(planByPaymenterProductId('999'), null);
});
