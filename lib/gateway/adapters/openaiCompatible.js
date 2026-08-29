const fetch = require('node-fetch');

// These providers all speak the same request/response shape as OpenAI's
// /v1/chat/completions, so one adapter covers all of them.

async function call({ provider, model, messages, temperature, stream, signal }) {
  const headers = { 'Content-Type': 'application/json' };
  if (provider.api_key_env && process.env[provider.api_key_env]) {
    headers['Authorization'] = `Bearer ${process.env[provider.api_key_env]}`;
  }

  const response = await fetch(provider.base_url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: model.id, messages, temperature, stream: !!stream }),
    signal
  });

  return response; // caller reads .json() or streams .body directly — already OpenAI-shaped
}

// Non-streaming response is already in OpenAI's { choices: [{ message: { content } }], usage } shape.
function normalizeResponse(data) {
  return data;
}

module.exports = { call, normalizeResponse };
