// Every provider here speaks one of 3 "formats":
// - "openai"     : OpenAI's /chat/completions wire format (used as-is by many providers)
// - "anthropic"  : Anthropic's /v1/messages format
// - "gemini"     : Google's generateContent format
//
// Local providers (ollama, vllm, llama_cpp, lmstudio) all speak the "openai" format too,
// so they reuse the same adapter — only base_url differs.
//
// "litellm" is our self-hosted LiteLLM proxy (see /litellm/config.yaml + docker-compose.yml).
// It exposes a single OpenAI-compatible endpoint and internally forwards to whichever real
// provider (OpenAI/Anthropic/Gemini/Groq/etc.) is mapped to the requested model name — so it
// reuses the plain "openai" format adapter too. config/models.js points cloud models at this
// provider instead of calling OpenAI/Anthropic/Gemini directly.

const PROVIDERS = {
  litellm: {
    label: 'LiteLLM proxy',
    format: 'openai',
    base_url: (process.env.LITELLM_BASE_URL || 'http://127.0.0.1:4000') + '/chat/completions',
    api_key_env: 'LITELLM_MASTER_KEY',
    local: false
  },
  // NOTE: the entries below (openai, anthropic, gemini, groq, openrouter) are kept so you
  // can point a model at a provider directly if you ever want to bypass LiteLLM — but by
  // default config/models.js routes every cloud model through "litellm" above instead.
  openai: {
    label: 'OpenAI',
    format: 'openai',
    base_url: 'https://api.openai.com/v1/chat/completions',
    api_key_env: 'OPENAI_API_KEY',
    local: false
  },
  anthropic: {
    label: 'Anthropic',
    format: 'anthropic',
    base_url: 'https://api.anthropic.com/v1/messages',
    api_key_env: 'ANTHROPIC_API_KEY',
    local: false
  },
  gemini: {
    label: 'Google Gemini',
    format: 'gemini',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/models',
    api_key_env: 'GEMINI_API_KEY',
    local: false
  },
  groq: {
    label: 'Groq',
    format: 'openai',
    base_url: 'https://api.groq.com/openai/v1/chat/completions',
    api_key_env: 'GROQ_API_KEY',
    local: false
  },
  openrouter: {
    label: 'OpenRouter',
    format: 'openai',
    base_url: 'https://openrouter.ai/api/v1/chat/completions',
    api_key_env: 'OPENROUTER_API_KEY',
    local: false
  },
  ollama: {
    label: 'Ollama (local)',
    format: 'openai',
    base_url: process.env.OLLAMA_URL || 'http://127.0.0.1:11434/v1/chat/completions',
    api_key_env: null, // no key needed for local
    local: true
  },
  vllm: {
    label: 'vLLM (local)',
    format: 'openai',
    base_url: process.env.VLLM_URL || 'http://127.0.0.1:8000/v1/chat/completions',
    api_key_env: null,
    local: true
  },
  llama_cpp: {
    label: 'llama.cpp (local)',
    format: 'openai',
    base_url: process.env.LLAMA_SERVER_URL || 'http://127.0.0.1:8080/v1/chat/completions',
    api_key_env: null,
    local: true
  },
  lmstudio: {
    label: 'LM Studio (local)',
    format: 'openai',
    base_url: process.env.LMSTUDIO_URL || 'http://127.0.0.1:1234/v1/chat/completions',
    api_key_env: null,
    local: true
  }
};

function isProviderConfigured(providerKey) {
  const p = PROVIDERS[providerKey];
  if (!p) return false;
  if (p.local) return true; // assume reachable; health checks will catch it if not
  return !!(p.api_key_env && process.env[p.api_key_env]);
}

module.exports = { PROVIDERS, isProviderConfigured };
