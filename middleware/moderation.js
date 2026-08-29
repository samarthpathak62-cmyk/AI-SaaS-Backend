// Basic keyword-level moderation. This is a first line of defense, not a complete
// solution - for serious production use, consider a dedicated moderation API/model.
const BLOCKED_PATTERNS = [
  /\bhow (to|do i) (make|build|synthesize) .*(bomb|explosive|nerve agent|chemical weapon)/i,
  /\bchild (sexual|porn|abuse)/i,
  /\bcsam\b/i,
  /\bhow (to|do i) (make|create|build) .*(virus|malware|ransomware) .*(spread|infect)/i
];

function containsBlockedContent(text) {
  if (!text || typeof text !== 'string') return false;
  return BLOCKED_PATTERNS.some(pattern => pattern.test(text));
}

function moderateMessages(req, res, next) {
  const messages = req.body.messages || [];
  for (const m of messages) {
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter(p => p.type === 'text').map(p => p.text).join(' ')
        : '';
    if (containsBlockedContent(text)) {
      return res.status(400).json({ error: 'This request violates our usage policy and cannot be processed.' });
    }
  }
  next();
}

module.exports = { moderateMessages, containsBlockedContent };
