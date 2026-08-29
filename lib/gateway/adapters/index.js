const openaiCompatible = require('./openaiCompatible');
const anthropic = require('./anthropic');
const gemini = require('./gemini');

const ADAPTERS = {
  openai: openaiCompatible,
  anthropic,
  gemini
};

function getAdapter(format) {
  const adapter = ADAPTERS[format];
  if (!adapter) throw new Error(`No adapter registered for format "${format}"`);
  return adapter;
}

module.exports = { getAdapter };
