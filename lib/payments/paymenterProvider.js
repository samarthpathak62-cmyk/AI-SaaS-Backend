// Paymenter (https://paymenter.org) is a self-hosted billing/client-area panel - not a
// direct card processor. It has its own Admin REST API (Bearer token, documented at
// https://paymenter.org/api/) which this adapter uses to create an order on the user's
// behalf; the user then completes payment on your Paymenter storefront using whatever
// gateways *you've* configured inside Paymenter (Stripe, PayPal, Mollie, etc).
//
// VERIFY BEFORE GOING LIVE: the exact checkout URL path and webhook payload shape can
// differ by Paymenter version/theme. The Admin API calls below (create user, create
// order) match the published v1 API. If your storefront's checkout URL differs from
// CHECKOUT_URL below, update that one line. If Paymenter isn't sending you real-time
// webhooks, use the manual fallback: PATCH /api/admin/users/:id/plan.
const fetch = require('node-fetch');
const logger = require('../../logger');
const { query } = require('../../db/postgres');
const { PLANS } = require('../../config/plans');

const BASE_URL = (process.env.PAYMENTER_URL || '').replace(/\/$/, '');
const API_TOKEN = process.env.PAYMENTER_API_TOKEN;

function isConfigured() {
  return Boolean(BASE_URL && API_TOKEN);
}

async function paymenterFetch(path, options = {}) {
  const res = await fetch(`${BASE_URL}/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${API_TOKEN}`,
      ...(options.headers || {})
    }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.message || `Paymenter API error (HTTP ${res.status})`);
  }
  return body;
}

// Finds (by email) or creates the Paymenter-side user matching our local user, and
// remembers the mapping so repeat purchases don't create duplicate Paymenter accounts.
async function ensurePaymenterUser(user) {
  if (user.paymenter_user_id) return user.paymenter_user_id;

  const list = await paymenterFetch(`/v1/admin/users?filter[email]=${encodeURIComponent(user.email)}`);
  let paymenterUserId = list?.data?.[0]?.id;

  if (!paymenterUserId) {
    const created = await paymenterFetch('/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({ email: user.email, first_name: user.username })
    });
    paymenterUserId = created?.data?.id;
  }

  if (paymenterUserId) {
    await query('UPDATE users SET paymenter_user_id = $1 WHERE id = $2', [paymenterUserId, user.id]);
  }
  return paymenterUserId;
}

async function createCheckoutSession(user, planKey) {
  if (!isConfigured()) throw new Error('Paymenter is not configured (set PAYMENTER_URL and PAYMENTER_API_TOKEN)');
  const planDef = PLANS[planKey];
  if (!planDef?.paymenter_product_id) throw new Error('This plan has no Paymenter product configured');

  const paymenterUserId = await ensurePaymenterUser(user);
  const order = await paymenterFetch('/v1/admin/orders', {
    method: 'POST',
    body: JSON.stringify({
      user_id: paymenterUserId,
      products: [{ product_id: planDef.paymenter_product_id, quantity: 1 }]
    })
  });

  const orderId = order?.data?.id;
  if (orderId) {
    await query('UPDATE users SET paymenter_order_id = $1, payment_provider = $2 WHERE id = $3', [orderId, 'paymenter', user.id]);
  } else {
    logger.warn('Paymenter order created but no id returned', { userId: user.id, response: order });
  }

  // Standard Paymenter client-area order URL - verify this matches your install (see note above).
  const url = `${BASE_URL}/checkout/order/${orderId}`;
  return { url, orderId };
}

// Paymenter itself IS the client portal - there's no separate "billing portal" API call
// like Stripe's; just send the user to their Paymenter account/invoices page.
async function createPortalSession() {
  return { url: `${BASE_URL}/account` };
}

module.exports = { name: 'paymenter', isConfigured, createCheckoutSession, createPortalSession, ensurePaymenterUser, paymenterFetch };
