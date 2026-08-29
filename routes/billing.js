const express = require('express');
const Stripe = require('stripe');
const { query } = require('../db/postgres');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const schemas = require('../schemas');
const { PLANS, planByPriceId, planByPaymenterProductId } = require('../config/plans');
const { configuredProviders, getProvider, defaultProvider } = require('../lib/payments');
const { auditLog } = require('../lib/audit');
const logger = require('../logger');

const router = express.Router();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Public: which plans exist and which payment gateway(s) can actually be used right now.
router.get('/plans', (req, res) => {
  const publicPlans = Object.entries(PLANS).map(([key, p]) => ({
    key,
    name: p.name,
    daily_token_limit: p.daily_token_limit,
    daily_usage_seconds_limit: p.daily_usage_seconds_limit,
    purchasable: Boolean(p.stripe_price_id || p.paymenter_product_id)
  }));
  res.json({
    plans: publicPlans,
    payment_providers: configuredProviders().map(p => p.name)
  });
});

// Start a checkout with whichever gateway the user picks - {plan, provider?}.
// If provider is omitted, the first configured gateway is used automatically, so a
// server with only one gateway set up keeps working exactly like before.
router.post('/create-checkout-session', requireAuth, validate(schemas.createCheckoutSession), async (req, res) => {
  const { plan, provider } = req.body;
  if (!PLANS[plan]) return res.status(400).json({ error: 'Unknown plan' });

  try {
    const providerName = provider || defaultProvider();
    const gateway = getProvider(providerName);
    const { url } = await gateway.createCheckoutSession(req.user, plan);
    res.json({ url, provider: providerName });
  } catch (err) {
    logger.error('Checkout session error', { error: err.message, provider });
    res.status(400).json({ error: err.message || 'Could not create checkout session' });
  }
});

// Send the user to whichever gateway their active subscription is on (defaults to
// Stripe for legacy users with no payment_provider recorded yet).
router.post('/portal', requireAuth, async (req, res) => {
  try {
    const providerName = req.user.payment_provider || 'stripe';
    const gateway = getProvider(providerName);
    const { url } = await gateway.createPortalSession(req.user);
    res.json({ url, provider: providerName });
  } catch (err) {
    logger.error('Billing portal error', { error: err.message });
    res.status(400).json({ error: err.message || 'Could not open billing portal' });
  }
});

// ---- Stripe webhook ---- (mounted with express.raw() in server.js - Stripe needs the RAW body)
async function stripeWebhookHandler(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.error('Stripe webhook signature verification failed', { error: err.message });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.user_id;
        const planKey = session.metadata?.plan;
        if (userId && PLANS[planKey]) {
          await query(
            `UPDATE users SET plan = $1, daily_token_limit = $2, stripe_subscription_id = $3,
                    plan_status = 'active', payment_provider = 'stripe' WHERE id = $4`,
            [planKey, PLANS[planKey].daily_token_limit, session.subscription, userId]
          );
          await auditLog({ userId, action: 'billing.subscription_started', metadata: { plan: planKey, provider: 'stripe' } });
        }
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const priceId = sub.items.data[0]?.price?.id;
        const planKey = planByPriceId(priceId);
        const { rows } = await query('SELECT id FROM users WHERE stripe_customer_id = $1', [sub.customer]);
        if (rows[0] && planKey) {
          await query('UPDATE users SET plan = $1, daily_token_limit = $2, plan_status = $3 WHERE id = $4', [
            planKey, PLANS[planKey].daily_token_limit, sub.status, rows[0].id
          ]);
          await auditLog({ userId: rows[0].id, action: 'billing.subscription_updated', metadata: { plan: planKey, status: sub.status } });
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const { rows } = await query('SELECT id FROM users WHERE stripe_customer_id = $1', [sub.customer]);
        if (rows[0]) {
          await query(
            `UPDATE users SET plan = 'free', daily_token_limit = $1, plan_status = 'canceled', stripe_subscription_id = NULL WHERE id = $2`,
            [PLANS.free.daily_token_limit, rows[0].id]
          );
          await auditLog({ userId: rows[0].id, action: 'billing.subscription_canceled' });
        }
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  } catch (err) {
    logger.error('Stripe webhook handling error', { error: err.message });
    res.status(500).json({ error: 'Webhook handler failed' });
  }
}

// ---- Paymenter webhook ---- (mounted with express.json() in server.js - normal JSON body)
// Verified with a shared secret header rather than a signature scheme, since Paymenter's
// outbound webhook format can vary by install - see lib/payments/paymenterProvider.js.
// Configure your Paymenter instance (or a small extension) to POST here on order/invoice
// paid events with header `X-Paymenter-Secret: <PAYMENTER_WEBHOOK_SECRET>` and a body like:
//   { "event": "order.paid", "order_id": "123", "product_id": "45", "status": "paid" }
// If your Paymenter setup can't send webhooks, activate plans manually instead via
// PATCH /api/admin/users/:id/plan - that always works regardless of webhook support.
async function paymenterWebhookHandler(req, res) {
  const providedSecret = req.headers['x-paymenter-secret'];
  const expectedSecret = process.env.PAYMENTER_WEBHOOK_SECRET;
  if (!expectedSecret || providedSecret !== expectedSecret) {
    logger.warn('Paymenter webhook rejected - bad or missing shared secret');
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  try {
    const { event, order_id, product_id, status } = req.body || {};
    const isPaid = status === 'paid' || status === 'completed' || event === 'order.paid' || event === 'invoice.paid';
    if (!isPaid || !order_id) {
      return res.json({ received: true, ignored: true });
    }

    const planKey = planByPaymenterProductId(product_id);
    const { rows } = await query('SELECT id FROM users WHERE paymenter_order_id = $1', [order_id]);
    const userId = rows[0]?.id;

    if (userId && planKey) {
      await query(
        `UPDATE users SET plan = $1, daily_token_limit = $2, plan_status = 'active', payment_provider = 'paymenter' WHERE id = $3`,
        [planKey, PLANS[planKey].daily_token_limit, userId]
      );
      await auditLog({ userId, action: 'billing.subscription_started', metadata: { plan: planKey, provider: 'paymenter', order_id } });
    } else {
      logger.warn('Paymenter webhook: could not match order to a user/plan', { order_id, product_id });
    }

    res.json({ received: true });
  } catch (err) {
    logger.error('Paymenter webhook handling error', { error: err.message });
    res.status(500).json({ error: 'Webhook handler failed' });
  }
}

// Mounted on the normal express.json() body parser (unlike the Stripe webhook above),
// since Paymenter webhooks are plain JSON with no signature scheme to verify against a raw body.
router.post('/webhook/paymenter', paymenterWebhookHandler);

module.exports = { router, stripeWebhookHandler, paymenterWebhookHandler };
