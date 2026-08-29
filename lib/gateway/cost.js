function calculateCost(model, promptTokens, completionTokens) {
  const promptCost = (promptTokens / 1000) * model.cost_per_1k_prompt;
  const completionCost = (completionTokens / 1000) * model.cost_per_1k_completion;
  return Math.round((promptCost + completionCost) * 1e6) / 1e6; // round to 6 decimal places (USD)
}

module.exports = { calculateCost };
