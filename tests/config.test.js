import test from 'node:test';
import assert from 'node:assert/strict';
import { getRuntimeConfig } from '../services/configService.js';
import { buildResponseRequest } from '../services/requestService.js';

test('Vercel environment names map to defaults and safe upload limits', () => {
  const config = getRuntimeConfig({
    OPENAI_MODEL: 'gpt-5.4-mini',
    OPENAI_MODEL_OPTIONS: 'gpt-4.1,unknown-model',
    DEFAULT_MAX_OUTPUT_TOKENS: '8192',
    DEFAULT_CONTEXT_STRATEGY: 'window',
    DEFAULT_CONTEXT_WINDOW_SIZE: '6',
    DEFAULT_TEMPERATURE: '0.4',
    MAX_ATTACHMENTS_PER_MESSAGE: '3',
    MAX_UPLOAD_MB: '2',
    OPENAI_API_KEY: 'private',
    PASS_KEY: 'private',
  });
  assert.equal(config.defaultSettings.maxOutputTokens, 8192);
  assert.equal(config.defaultSettings.contextStrategy, 'window');
  assert.equal(config.defaultSettings.contextWindowSize, 6);
  assert.equal(config.defaultSettings.temperature, 0.4);
  assert.equal(config.maxAttachments, 3);
  assert.equal(config.maxFileBytes, 2 * 1048576);
  assert.deepEqual(
    config.models.map((model) => model.id),
    ['gpt-5.4-mini', 'gpt-5.4', 'gpt-4.1'],
  );
  assert.ok(!JSON.stringify(config).includes('private'));
});
test('invalid environment values fall back and oversized limits are clamped', () => {
  const config = getRuntimeConfig({
    OPENAI_MODEL: 'invalid',
    DEFAULT_MAX_OUTPUT_TOKENS: 'oops',
    MAX_UPLOAD_MB: '50',
    MAX_ATTACHMENTS_PER_MESSAGE: '50',
  });
  assert.equal(config.defaultSettings.model, 'gpt-5.4-mini');
  assert.equal(config.defaultSettings.maxOutputTokens, 4096);
  assert.equal(config.maxFileBytes, 4 * 1048576);
  assert.equal(config.maxAttachments, 8);
});
test('server applies configured attachment count independently of client', () => {
  const previous = process.env.MAX_ATTACHMENTS_PER_MESSAGE;
  process.env.MAX_ATTACHMENTS_PER_MESSAGE = '1';
  try {
    assert.throws(
      () =>
        buildResponseRequest(
          {
            settings: { model: 'gpt-5.4-mini' },
            messages: [
              { role: 'user', text: 'x', attachments: [{ receipt: 'a' }, { receipt: 'b' }] },
            ],
          },
          () => ({ id: 'file-x' }),
        ),
      /maximum 1/,
    );
  } finally {
    if (previous === undefined) delete process.env.MAX_ATTACHMENTS_PER_MESSAGE;
    else process.env.MAX_ATTACHMENTS_PER_MESSAGE = previous;
  }
});
