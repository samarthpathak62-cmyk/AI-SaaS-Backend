// Define your subscription plans here.
// stripe_price_id must match a real Price ID created in your Stripe Dashboard.
// paymenter_product_id must match a real Product ID created in your Paymenter panel.
// daily_token_limit resets every day automatically for each user.
// daily_usage_seconds_limit: total *active* usage time per day (idle gaps don't count -
// see middleware/auth.js). Set to null for "no time cap, token limit governs instead".

const PLANS = {
  free: {
    name: 'Free',
    daily_token_limit: 20000,
    daily_usage_seconds_limit: 2 * 60 * 60, // 2 hours/day
    stripe_price_id: null,       // free plan has no Stripe price
    paymenter_product_id: null   // free plan has no Paymenter product
  },
  pro: {
    name: 'Pro',
    daily_token_limit: 500000,
    daily_usage_seconds_limit: null, // unlimited time - only the token limit applies
    stripe_price_id: process.env.STRIPE_PRICE_PRO || 'price_REPLACE_ME',
    paymenter_product_id: process.env.PAYMENTER_PRODUCT_PRO || null
  },
  business: {
    name: 'Business',
    daily_token_limit: 3000000,
    daily_usage_seconds_limit: null,
    stripe_price_id: process.env.STRIPE_PRICE_BUSINESS || 'price_REPLACE_ME',
    paymenter_product_id: process.env.PAYMENTER_PRODUCT_BUSINESS || null
  }
};

function planByPriceId(priceId) {
  return Object.entries(PLANS).find(([, p]) => p.stripe_price_id === priceId)?.[0] || null;
}

function planByPaymenterProductId(productId) {
  return Object.entries(PLANS).find(([, p]) => String(p.paymenter_product_id) === String(productId))?.[0] || null;
}

module.exports = { PLANS, planByPriceId, planByPaymenterProductId };
