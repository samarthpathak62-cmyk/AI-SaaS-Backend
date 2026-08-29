const { MODELS, findModel } = require('../../config/models');
const { PROVIDERS, isProviderConfigured } = require('../../config/providers');
const { isHealthy, averageLatency } = require('./health');

// Returns an ordered list of models to TRY, in priority order. The gateway route
// walks this list and stops at the first one that succeeds — this is how every
// strategy naturally gets automatic fallback (e.g. Gemini down -> Claude -> OpenAI -> local).
function pickCandidates({ requestedModel, strategy = 'fallback', fallbackChain, requireVision = false }) {
  let pool = MODELS.filter(m => isProviderConfigured(m.provider));
  if (requireVision) pool = pool.filter(m => m.vision);

  // Explicit fallback chain: user lists exact model ids in the order to try
  if (Array.isArray(fallbackChain) && fallbackChain.length) {
    return fallbackChain.map(findModel).filter(Boolean).filter(m => isProviderConfigured(m.provider));
  }

  // A specific model was requested - try it first, then fall back to the same strategy's ranking
  const requested = requestedModel ? findModel(requestedModel) : null;
  const rest = pool.filter(m => m.id !== requestedModel);

  const ranked = rankByStrategy(rest, strategy);
  return requested ? [requested, ...ranked] : ranked;
}

function rankByStrategy(pool, strategy) {
  const healthy = pool.filter(m => isHealthy(m.id));
  const candidates = healthy.length ? healthy : pool; // if everything's "unhealthy", try anyway rather than fail outright

  switch (strategy) {
    case 'cheapest':
      return [...candidates].sort((a, b) =>
        (a.cost_per_1k_prompt + a.cost_per_1k_completion) - (b.cost_per_1k_prompt + b.cost_per_1k_completion)
      );
    case 'fastest':
    case 'latency_based':
      return [...candidates].sort((a, b) => averageLatency(a.id) - averageLatency(b.id) || b.speed_tier - a.speed_tier);
    case 'quality':
      return [...candidates].sort((a, b) => b.quality_tier - a.quality_tier);
    case 'local_first':
      return [...candidates].sort((a, b) => {
        const aLocal = PROVIDERS[a.provider].local ? 0 : 1;
        const bLocal = PROVIDERS[b.provider].local ? 0 : 1;
        return aLocal - bLocal || b.quality_tier - a.quality_tier;
      });
    case 'health_based':
      return [...candidates].sort((a, b) => (isHealthy(b.id) ? 1 : 0) - (isHealthy(a.id) ? 1 : 0));
    case 'fallback':
    default:
      // Sensible default order: quality first among healthy models
      return [...candidates].sort((a, b) => b.quality_tier - a.quality_tier);
  }
}

module.exports = { pickCandidates };
