const stripeProvider = require('./stripeProvider');
const paymenterProvider = require('./paymenterProvider');

const PROVIDERS = {
  stripe: stripeProvider,
  paymenter: paymenterProvider
};

// Only gateways with the right env vars actually filled in show up as usable -
// so the frontend/user only ever sees payment options that will actually work.
function configuredProviders() {
  return Object.values(PROVIDERS).filter(p => p.isConfigured());
}

function getProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown payment provider "${name}". Valid options: ${Object.keys(PROVIDERS).join(', ')}`);
  if (!provider.isConfigured()) throw new Error(`Payment provider "${name}" is not configured on this server`);
  return provider;
}

function defaultProvider() {
  const configured = configuredProviders();
  if (configured.length === 0) throw new Error('No payment provider is configured (set up Stripe and/or Paymenter in .env)');
  return configured[0].name;
}

module.exports = { PROVIDERS, configuredProviders, getProvider, defaultProvider };
