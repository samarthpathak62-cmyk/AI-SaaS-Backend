const fetch = require('node-fetch');

// Anthropic wants system prompt separated out, and doesn't use "system" role in messages[].
function toAnthropicMessages(messages) {
  const system = messages.filter(m => m.role === 'system').map(m =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
  ).join('\n');

  const converted = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: toAnthropicContent(m.content)
    }));

  return { system: system || undefined, messages: converted };
}

// Translate OpenAI-style vision content array to Anthropic's image block format
function toAnthropicContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content.map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image_url') {
      const url = part.image_url?.url || '';
      const match = url.match(/^data:(.+);base64,(.+)$/);
      if (match) {
        return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
      }
      return { type: 'text', text: '[image could not be attached — expected a base64 data URL]' };
    }
    return { type: 'text', text: '' };
  });
}

async function call({ provider, model, messages, temperature, stream, signal }) {
  const { system, messages: anthropicMessages } = toAnthropicMessages(messages);

  const response = await fetch(provider.base_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env[provider.api_key_env],
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model.id,
      system,
      messages: anthropicMessages,
      max_tokens: 4096,
      temperature,
      stream: !!stream
    }),
    signal
  });

  return response;
}

// Anthropic's response shape -> normalize to OpenAI's { choices, usage } shape
function normalizeResponse(data) {
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return {
    id: data.id,
    model: data.model,
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: data.stop_reason }],
    usage: {
      prompt_tokens: data.usage?.input_tokens,
      completion_tokens: data.usage?.output_tokens,
      total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
    }
  };
}

// Anthropic streams a different SSE event schema (content_block_delta etc).
// This translates each raw SSE line into an OpenAI-style delta chunk string,
// so the client-facing stream format is identical regardless of provider.
function translateStreamChunk(rawEventText) {
  const lines = rawEventText.split('\n').filter(l => l.startsWith('data:'));
  let out = '';
  for (const line of lines) {
    const payload = line.replace(/^data:\s*/, '');
    try {
      const json = JSON.parse(payload);
      if (json.type === 'content_block_delta' && json.delta?.text) {
        out += `data: ${JSON.stringify({ choices: [{ delta: { content: json.delta.text } }] })}\n\n`;
      }
    } catch { /* ignore non-JSON lines (e.g. "event: ping") */ }
  }
  return out;
}

module.exports = { call, normalizeResponse, translateStreamChunk };
