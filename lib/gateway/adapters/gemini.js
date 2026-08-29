const fetch = require('node-fetch');

function toGeminiContents(messages) {
  // Gemini has no "system" role in contents[]; fold any system messages into the first user turn.
  const systemText = messages.filter(m => m.role === 'system').map(m =>
    typeof m.content === 'string' ? m.content : ''
  ).join('\n');

  const turns = messages.filter(m => m.role !== 'system').map((m, i) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: toGeminiParts(m.content, i === 0 ? systemText : '')
  }));

  return turns;
}

function toGeminiParts(content, prefixText) {
  const parts = [];
  if (prefixText) parts.push({ text: prefixText });

  if (typeof content === 'string') {
    parts.push({ text: content });
    return parts;
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === 'text') parts.push({ text: part.text });
      if (part.type === 'image_url') {
        const url = part.image_url?.url || '';
        const match = url.match(/^data:(.+);base64,(.+)$/);
        if (match) parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
      }
    }
  }
  return parts;
}

async function call({ provider, model, messages, temperature, stream, signal }) {
  const contents = toGeminiContents(messages);
  const method = stream ? 'streamGenerateContent' : 'generateContent';
  const url = `${provider.base_url}/${model.id}:${method}?key=${process.env[provider.api_key_env]}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents, generationConfig: { temperature } }),
    signal
  });

  return response;
}

// Gemini's response -> normalize to OpenAI's { choices, usage } shape
function normalizeResponse(data) {
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts || []).map(p => p.text || '').join('');
  return {
    model: data.modelVersion,
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: candidate?.finishReason }],
    usage: {
      prompt_tokens: data.usageMetadata?.promptTokenCount,
      completion_tokens: data.usageMetadata?.candidatesTokenCount,
      total_tokens: data.usageMetadata?.totalTokenCount
    }
  };
}

module.exports = { call, normalizeResponse };
