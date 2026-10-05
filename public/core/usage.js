import { getModel } from './model-catalog.js';
export function estimateCost(message) {
  const pricing = getModel(
    message.model === 'gpt-5.4-mini' ? 'gpt-5.4-mini-2026-03-17' : message.model,
  )?.pricing;
  const rates = pricing?.rates;
  const usage = message.usage;
  if (!rates || !usage) return null;
  const input = Math.max(0, usage.input_tokens || 0),
    output = Math.max(0, usage.output_tokens || 0);
  const cached = Math.min(input, Math.max(0, usage.input_tokens_details?.cached_tokens || 0));
  const tier = pricing.longContext;
  const long = tier && input > tier.threshold;
  return (
    ((input - cached) * rates[0] * (long ? tier.inputMultiplier : 1) +
      cached * rates[1] * (long ? tier.inputMultiplier : 1) +
      output * rates[2] * (long ? tier.outputMultiplier : 1)) /
    1000000
  );
}
