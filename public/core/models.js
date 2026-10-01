import { MODELS, getModel } from './model-catalog.js';
export { MODELS, getModel } from './model-catalog.js';
export function normalizeSettings(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  const model = getModel(value.model) || MODELS[0];
  return {
    model: model.id,
    reasoningEffort: model.reasoning.includes(value.reasoningEffort)
      ? value.reasoningEffort
      : model.reasoning.includes('high')
        ? 'high'
        : 'none',
    verbosity: ['low', 'medium', 'high'].includes(value.verbosity) ? value.verbosity : 'medium',
    format: value.format === 'json_object' ? 'json_object' : 'text',
    tools: [
      ...new Set(
        Array.isArray(value.tools) ? value.tools.filter((tool) => model.tools.includes(tool)) : [],
      ),
    ],
    systemPrompt: typeof value.systemPrompt === 'string' ? value.systemPrompt.slice(0, 60000) : '',
    promptBlocks: (Array.isArray(value.promptBlocks) ? value.promptBlocks : [])
      .filter((block) => block && typeof block === 'object')
      .slice(0, 20)
      .map((block) => ({
        id: typeof block.id === 'string' ? block.id : crypto.randomUUID(),
        text: String(block.text || '').slice(0, 20000),
      })),
    contextStrategy: ['all', 'window', 'last_turn'].includes(value.contextStrategy)
      ? value.contextStrategy
      : 'all',
    contextWindowSize: Math.min(100, Math.max(1, Number(value.contextWindowSize) || 10)),
    maxOutputTokens: Math.min(
      model.maxOutput || 128000,
      Math.max(16, Math.round(Number(value.maxOutputTokens) || 4096)),
    ),
    temperature: Math.min(
      2,
      Math.max(0, Number.isFinite(Number(value.temperature)) ? Number(value.temperature) : 1),
    ),
  };
}
export function selectContext(messages, settings) {
  const usable = messages.filter(
    (message) => message.role === 'user' || (message.role === 'assistant' && message.text),
  );
  if (settings.contextStrategy === 'last_turn')
    return usable.filter((message) => message.role === 'user').slice(-1);
  if (settings.contextStrategy === 'window') return usable.slice(-settings.contextWindowSize);
  return usable;
}
