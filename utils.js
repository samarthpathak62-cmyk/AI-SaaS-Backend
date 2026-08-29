function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Rough token estimate if llama-server doesn't return usage stats
// (~4 chars per token is a common English approximation)
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// A message's `content` can be a plain string OR an array of parts
// (OpenAI vision format): [{type:"text", text:"..."}, {type:"image_url", image_url:{url:"data:..."}}]
// This pulls out just the text and counts how many images were sent.
function extractTextAndImageCount(content) {
  if (typeof content === 'string') return { text: content, imageCount: 0 };
  if (!Array.isArray(content)) return { text: '', imageCount: 0 };

  let text = '';
  let imageCount = 0;
  for (const part of content) {
    if (part.type === 'text') text += part.text + ' ';
    if (part.type === 'image_url') imageCount += 1;
  }
  return { text, imageCount };
}

// Flat cost-per-image in "tokens" for usage accounting when the model
// doesn't report exact usage. Adjust this to match your model's real vision cost.
const TOKENS_PER_IMAGE_ESTIMATE = 300;

module.exports = { todayStr, estimateTokens, extractTextAndImageCount, TOKENS_PER_IMAGE_ESTIMATE };
