const express = require('express');
const fetch = require('node-fetch');
const { query } = require('../db/postgres');
const { requireApiKey } = require('../middleware/auth');
const { planRateLimit } = require('../middleware/planRateLimit');
const { validate } = require('../middleware/validate');
const { moderateMessages } = require('../middleware/moderation');
const schemas = require('../schemas');
const { estimateTokens, extractTextAndImageCount, TOKENS_PER_IMAGE_ESTIMATE } = require('../utils');
const { nextServerUrl, markFailed } = require('../config/llama-cluster');
const { sendUsageAlertEmail } = require('../utils/email');
const logger = require('../logger');

const router = express.Router();

async function getOrCreateConversation(userId, conversationId, firstMessageText) {
  if (conversationId) {
    const { rows } = await query('SELECT * FROM conversations WHERE id = $1 AND user_id = $2', [conversationId, userId]);
    if (rows[0]) return rows[0];
  }
  const title = (firstMessageText || 'New Chat').slice(0, 60);
  const { rows } = await query(
    'INSERT INTO conversations (user_id, title) VALUES ($1,$2) RETURNING *', [userId, title]
  );
  return rows[0];
}

async function saveMessage(conversationId, role, content) {
  await query('INSERT INTO messages (conversation_id, role, content) VALUES ($1,$2,$3)', [
    conversationId, role, JSON.stringify(content)
  ]);
  await query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId]);
}

async function recordUsageAndMaybeAlert(user, promptTokens, completionTokens, imageCount, model, status = 'success') {
  const totalTokens = promptTokens + completionTokens;

  await query('UPDATE users SET tokens_used_today = tokens_used_today + $1 WHERE id = $2', [totalTokens, user.id]);
  await query(
    `INSERT INTO request_logs (user_id, prompt_tokens, completion_tokens, total_tokens, image_count, model, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [user.id, promptTokens, completionTokens, totalTokens, imageCount, model || 'default', status]
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
  return totalTokens;
}

// POST /api/chat  -> OpenAI-style: { messages: [...], model, conversation_id, stream }
router.post('/chat', requireApiKey, planRateLimit, validate(schemas.chatRequest), moderateMessages, async (req, res) => {
  const user = req.user;
  const body = req.body;

  let promptText = '';
  let imageCount = 0;
  for (const m of body.messages) {
    const { text, imageCount: c } = extractTextAndImageCount(m.content);
    promptText += text + ' ';
    imageCount += c;
  }

  const firstUserMsg = body.messages.find(m => m.role === 'user');
  const firstText = firstUserMsg ? extractTextAndImageCount(firstUserMsg.content).text : 'New Chat';
  const conversation = await getOrCreateConversation(user.id, body.conversation_id, firstText);

  const lastMessage = body.messages[body.messages.length - 1];
  await saveMessage(conversation.id, 'user', lastMessage.content);

  const wantsStream = body.stream === true;
  const serverUrl = nextServerUrl();

  if (!wantsStream) {
    try {
      const upstream = await fetch(serverUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, stream: false })
      });
      const data = await upstream.json();

      if (!upstream.ok) {
        await recordUsageAndMaybeAlert(user, estimateTokens(promptText), 0, imageCount, body.model, 'error');
        return res.status(upstream.status).json({ error: data.error || 'Model server error' });
      }

      let promptTokens = data.usage?.prompt_tokens;
      let completionTokens = data.usage?.completion_tokens;
      const completionText = data.choices?.[0]?.message?.content || '';
      if (promptTokens == null || completionTokens == null) {
        promptTokens = estimateTokens(promptText) + imageCount * TOKENS_PER_IMAGE_ESTIMATE;
        completionTokens = estimateTokens(completionText);
      }

      await recordUsageAndMaybeAlert(user, promptTokens, completionTokens, imageCount, body.model);
      await saveMessage(conversation.id, 'assistant', completionText);

      res.json({ ...data, conversation_id: conversation.id });
    } catch (err) {
      markFailed(serverUrl);
      logger.error('Upstream error (non-stream)', { error: err.message, serverUrl });
      res.status(502).json({ error: 'Could not reach model server (is llama-server running?)' });
    }
    return;
  }

  // ---- Streaming path (Server-Sent Events, with heartbeat + client-cancel support) ----
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Conversation-Id', String(conversation.id));
  res.flushHeaders?.();

  let fullText = '';
  const controller = new AbortController();
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);

  // If the client disconnects (closes tab, cancels request), stop calling the model
  req.on('close', () => {
    clearInterval(heartbeat);
    controller.abort();
  });

  try {
    const upstream = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal
    });

    if (!upstream.ok || !upstream.body) {
      clearInterval(heartbeat);
      res.write(`data: ${JSON.stringify({ error: 'Model server error' })}\n\n`);
      return res.end();
    }

    upstream.body.on('data', chunk => {
      const lines = chunk.toString('utf8').split('\n').filter(l => l.trim().startsWith('data:'));
      for (const line of lines) {
        const payload = line.replace(/^data:\s*/, '');
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) fullText += delta;
        } catch { /* ignore partial/non-JSON chunks */ }
      }
      res.write(chunk);
    });

    upstream.body.on('end', async () => {
      clearInterval(heartbeat);
      const promptTokens = estimateTokens(promptText) + imageCount * TOKENS_PER_IMAGE_ESTIMATE;
      const completionTokens = estimateTokens(fullText);
      await recordUsageAndMaybeAlert(user, promptTokens, completionTokens, imageCount, body.model);
      if (fullText) await saveMessage(conversation.id, 'assistant', fullText);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    upstream.body.on('error', err => {
      clearInterval(heartbeat);
      if (err.name !== 'AbortError') {
        markFailed(serverUrl);
        logger.error('Upstream stream error', { error: err.message, serverUrl });
      }
      res.end();
    });
  } catch (err) {
    clearInterval(heartbeat);
    if (err.name !== 'AbortError') {
      markFailed(serverUrl);
      logger.error('Upstream error (stream setup)', { error: err.message, serverUrl });
      res.write(`data: ${JSON.stringify({ error: 'Could not reach model server' })}\n\n`);
    }
    res.end();
  }
});

module.exports = router;
