import { MODELS, normalizeSettings } from '../public/core/models.js';
import { MAX_FILE_BYTES, MAX_ATTACHMENTS } from '../public/core/files.js';
function number(value, fallback, min, max) {
  const parsed = value?.trim?.() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
export function getRuntimeConfig(env = process.env) {
  const requested = (env.OPENAI_MODEL_OPTIONS || '').split(',').map((value) => value.trim());
  const defaultSettings = normalizeSettings({
    model: env.OPENAI_MODEL,
    maxOutputTokens: number(env.DEFAULT_MAX_OUTPUT_TOKENS, 4096, 16, 128000),
    contextStrategy: env.DEFAULT_CONTEXT_STRATEGY,
    contextWindowSize: number(env.DEFAULT_CONTEXT_WINDOW_SIZE, 10, 1, 100),
    temperature: number(env.DEFAULT_TEMPERATURE, 1, 0, 2),
  });
  const models = env.OPENAI_MODEL_OPTIONS?.trim()
    ? MODELS.filter(
        (model) => model.featured || [defaultSettings.model, ...requested].includes(model.id),
      )
    : MODELS;
  return {
    models,
    defaultSettings,
    maxFileBytes: Math.floor(
      number(env.MAX_UPLOAD_MB, 4, 0.01, MAX_FILE_BYTES / 1048576) * 1048576,
    ),
    maxAttachments: Math.floor(
      number(env.MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENTS, 1, MAX_ATTACHMENTS),
    ),
  };
}
