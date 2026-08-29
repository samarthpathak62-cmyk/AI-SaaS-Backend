// Central place to add/remove models available through the gateway.
// cost_per_1k_* is in USD. speed_tier and quality_tier are 1 (lowest) - 5 (highest),
// used purely for ranking during routing decisions — tune these to your own judgment
// or replace with live numbers from each provider's pricing page.

const MODELS = [
  // ---- Cloud models — all routed through the LiteLLM proxy (see /litellm/config.yaml,
  // which maps each of these ids to the real provider + model + API key). ----
  { id: 'gpt-4o', provider: 'litellm', cost_per_1k_prompt: 0.005, cost_per_1k_completion: 0.015, speed_tier: 3, quality_tier: 5, vision: true },
  { id: 'gpt-4o-mini', provider: 'litellm', cost_per_1k_prompt: 0.00015, cost_per_1k_completion: 0.0006, speed_tier: 4, quality_tier: 3, vision: true },
  { id: 'claude-sonnet-4-6', provider: 'litellm', cost_per_1k_prompt: 0.003, cost_per_1k_completion: 0.015, speed_tier: 3, quality_tier: 5, vision: true },
  { id: 'claude-haiku-4-5', provider: 'litellm', cost_per_1k_prompt: 0.0008, cost_per_1k_completion: 0.004, speed_tier: 5, quality_tier: 3, vision: true },
  { id: 'gemini-1.5-pro', provider: 'litellm', cost_per_1k_prompt: 0.00125, cost_per_1k_completion: 0.005, speed_tier: 3, quality_tier: 4, vision: true },
  { id: 'gemini-1.5-flash', provider: 'litellm', cost_per_1k_prompt: 0.000075, cost_per_1k_completion: 0.0003, speed_tier: 5, quality_tier: 2, vision: true },
  { id: 'llama-3.3-70b-versatile', provider: 'litellm', cost_per_1k_prompt: 0.00059, cost_per_1k_completion: 0.00079, speed_tier: 5, quality_tier: 4, vision: false },
  { id: 'openrouter/auto', provider: 'litellm', cost_per_1k_prompt: 0.001, cost_per_1k_completion: 0.003, speed_tier: 3, quality_tier: 3, vision: false }

  // Local/self-hosted backend models (ollama, vllm, llama_cpp, lmstudio) were removed here —
  // see the "offline models" cleanup. Add rows back with provider: 'ollama' etc. if you ever
  // want to self-host a model on your own server again (unrelated to the app's on-device models).
];

function findModel(modelId) {
  return MODELS.find(m => m.id === modelId) || null;
}

function modelsByProvider(providerKey) {
  return MODELS.filter(m => m.provider === providerKey);
}

module.exports = { MODELS, findModel, modelsByProvider };
