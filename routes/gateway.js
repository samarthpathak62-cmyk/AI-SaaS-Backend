const express = require('express');
const { query } = require('../db/postgres');
const { requireApiKey } = require('../middleware/auth');
const { planRateLimit } = require('../middleware/planRateLimit');
const { validate } = require('../middleware/validate');
const { moderateMessages } = require('../middleware/moderation');
const schemas = require('../schemas');
const { PROVIDERS } = require('../config/providers');
const { withIdentityPrompt } = require('../config/systemPrompt');
const { pickCandidates } = require('../lib/gateway/router');
const { getAdapter } = require('../lib/gateway/adapters');
const { markSuccess, markFailure } = require('../lib/gateway/health');
const { calculateCost } = require('../lib/gateway/cost');
const { estimateTokens, extractTextAndImageCount, TOKENS_PER_IMAGE_ESTIMATE } = require('../utils');
const { sendUsageAlertEmail } = require('../utils/email');
const logger = require('../logger');

const router = express.Router();

async function recordUsage(user, { model, provider, promptTokens, completionTokens, imageCount, status, latencyMs }) {
  const totalTokens = promptTokens + completionTokens;
  const cost = calculateCost(model, promptTokens, completionTokens);

  await query('UPDATE users SET tokens_used_today = tokens_used_today + $1 WHERE id = $2', [totalTokens, user.id]);
  await query(
    `INSERT INTO request_logs (user_id, prompt_tokens, completion_tokens, total_tokens, image_count, model, provider, cost_usd, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [user.id, promptTokens, completionTokens, totalTokens, imageCount, model.id, provider, cost, status]
  );

  const newTotal = user.tokens_used_today + totalTokens;
  const percentUsed = Math.floor((newTotal / user.daily_token_limit) * 100);
  const today = new Date().toISOString().slice(0, 10);
  const alertAlreadySentToday = user.alert_sent_date &&
    new Date(user.alert_sent_date).toISOString().slice(0, 10) === today;
  if (percentUsed >= 80 && !alertAlreadySentToday) {
    await query('UPDATE users SET alert_sent_date = CURRENT_DATE WHERE id = $1', [user.id]);
    sendUsageAlertEmail(user.email, percentUsed, user.plan).catch(() => {});
  }
}

// POST /v1/chat/completions
// Body: { messages, model?, routing?: "cheapest"|"fastest"|"quality"|"local_first"|"health_based"|"fallback",
//         fallback_chain?: ["model-a","model-b"], stream? }
router.post('/chat/completions', requireApiKey, planRateLimit, validate(schemas.chatRequest), moderateMessages, async (req, res) => {
  const user = req.user;
  const body = req.body;

  // Every request gets the Neuron/Neura Tech AI identity system prompt prepended,
  // regardless of which real provider ends up serving it. Any system message the
  // client sent (e.g. a Pal's persona instructions) is kept, just after it.
  const messages = withIdentityPrompt(body.messages);

  let promptText = '';
  let imageCount = 0;
  for (const m of body.messages) {
    const { text, imageCount: c } = extractTextAndImageCount(m.content);
    promptText += text + ' ';
    imageCount += c;
  }

  const candidates = pickCandidates({
    requestedModel: body.model,
    strategy: body.routing || 'fallback',
    fallbackChain: body.fallback_chain,
    requireVision: imageCount > 0
  });

  if (!candidates.length) {
    return res.status(503).json({ error: 'No configured providers are available to handle this request.' });
  }

  const wantsStream = body.stream === true;

  // ---- Non-streaming: try each candidate in order until one succeeds ----
  if (!wantsStream) {
    let lastError = null;
    for (const model of candidates) {
      const provider = PROVIDERS[model.provider];
      const adapter = getAdapter(provider.format);
      const start = Date.now();
      try {
        const response = await adapter.call({ provider, model, messages, temperature: body.temperature, stream: false });
        const raw = await response.json();
        if (!response.ok) throw new Error(raw.error?.message || raw.error || `HTTP ${response.status}`);

        const data = adapter.normalizeResponse(raw);
        const latencyMs = Date.now() - start;
        markSuccess(model.id, latencyMs);

        let promptTokens = data.usage?.prompt_tokens;
        let completionTokens = data.usage?.completion_tokens;
        const completionText = data.choices?.[0]?.message?.content || '';
        if (promptTokens == null || completionTokens == null) {
          promptTokens = estimateTokens(promptText) + imageCount * TOKENS_PER_IMAGE_ESTIMATE;
          completionTokens = estimateTokens(completionText);
        }

        await recordUsage(user, { model, provider: model.provider, promptTokens, completionTokens, imageCount, status: 'success', latencyMs });

        return res.json({ ...data, model: model.id, provider: model.provider, latency_ms: latencyMs });
      } catch (err) {
        markFailure(model.id);
        lastError = err;
        logger.warn('Gateway candidate failed, trying next', { model: model.id, provider: model.provider, error: err.message });
      }
    }
    await recordUsage(user, { model: candidates[0], provider: candidates[0].provider, promptTokens: estimateTokens(promptText), completionTokens: 0, imageCount, status: 'error' });
    return res.status(502).json({ error: `All providers failed. Last error: ${lastError?.message}` });
  }

  // ---- Streaming: only the FIRST candidate is attempted (fallback mid-stream would
  // duplicate partial output to the client) - non-stream requests get full fallback chain. ----
  const model = candidates[0];
  const provider = PROVIDERS[model.provider];
  const adapter = getAdapter(provider.format);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Model', model.id);
  res.setHeader('X-Provider', model.provider);
  res.flushHeaders?.();

  let fullText = '';
  const controller = new AbortController();
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  const start = Date.now();
  req.on('close', () => { clearInterval(heartbeat); controller.abort(); });

  try {
    const upstream = await adapter.call({ provider, model, messages, temperature: body.temperature, stream: true, signal: controller.signal });
    if (!upstream.ok || !upstream.body) {
      clearInterval(heartbeat);
      markFailure(model.id);
      res.write(`data: ${JSON.stringify({ error: 'Provider error' })}\n\n`);
      return res.end();
    }

    upstream.body.on('data', chunk => {
      const text = chunk.toString('utf8');
      if (adapter.translateStreamChunk) {
        // Non-OpenAI providers (Anthropic) need their SSE events translated
        const translated = adapter.translateStreamChunk(text);
        if (translated) {
          res.write(translated);
          const match = translated.match(/"content":"([^"]*)"/);
          if (match) fullText += match[1];
        }
      } else {
        // Already OpenAI-shaped - forward as-is
        const lines = text.split('\n').filter(l => l.trim().startsWith('data:'));
        for (const line of lines) {
          const payload = line.replace(/^data:\s*/, '');
          if (payload === '[DONE]') continue;
          try {
            const json = JSON.parse(payload);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) fullText += delta;
          } catch { /* ignore partial chunks */ }
        }
        res.write(chunk);
      }
    });

    upstream.body.on('end', async () => {
      clearInterval(heartbeat);
      const latencyMs = Date.now() - start;
      markSuccess(model.id, latencyMs);
      const promptTokens = estimateTokens(promptText) + imageCount * TOKENS_PER_IMAGE_ESTIMATE;
      const completionTokens = estimateTokens(fullText);
      await recordUsage(user, { model, provider: model.provider, promptTokens, completionTokens, imageCount, status: 'success', latencyMs });
      res.write('data: [DONE]\n\n');
      res.end();
    });

    upstream.body.on('error', err => {
      clearInterval(heartbeat);
      if (err.name !== 'AbortError') { markFailure(model.id); logger.error('Gateway stream error', { error: err.message, model: model.id }); }
      res.end();
    });
  } catch (err) {
    clearInterval(heartbeat);
    if (err.name !== 'AbortError') {
      markFailure(model.id);
      logger.error('Gateway stream setup error', { error: err.message, model: model.id });
      res.write(`data: ${JSON.stringify({ error: 'Could not reach provider' })}\n\n`);
    }
    res.end();
  }
});

// GET /v1/models - lists what's actually usable right now (has a configured API key / is local)
router.get('/models', requireApiKey, (req, res) => {
  const { MODELS } = require('../config/models');
  const { isProviderConfigured } = require('../config/providers');
  const available = MODELS.filter(m => isProviderConfigured(m.provider)).map(m => ({
    id: m.id, provider: m.provider, vision: m.vision, quality_tier: m.quality_tier, speed_tier: m.speed_tier
  }));
  res.json({ data: available });
});

module.exports = router;
