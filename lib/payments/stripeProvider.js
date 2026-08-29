const Stripe = require('stripe');
const { query } = require('../../db/postgres');
const { PLANS } = require('../../config/plans');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

function isConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

async function createCheckoutSession(user, planKey) {
  const planDef = PLANS[planKey];
  if (!planDef?.stripe_price_id) throw new Error('This plan has no Stripe price configured');

  let customerId = user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: user.email, metadata: { user_id: user.id } });
    customerId = customer.id;
    await query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, user.id]);
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: planDef.stripe_price_id, quantity: 1 }],
    success_url: `${APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_URL}/billing/cancel`,
    metadata: { user_id: user.id, plan: planKey }
  });

  return { url: session.url };
}

async function createPortalSession(user) {
  if (!user.stripe_customer_id) throw new Error('No billing account found for this user yet');
  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: `${APP_URL}/account`
  });
  return { url: session.url };
}

module.exports = { name: 'stripe', stripe, isConfigured, createCheckoutSession, createPortalSession };
