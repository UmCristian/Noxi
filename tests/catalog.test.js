import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, getModel, normalizeSettings } from '../public/core/models.js';
import { parseBackup } from '../public/core/backup.js';
import { estimateCost } from '../public/core/usage.js';
import { buildResponseRequest } from '../services/requestService.js';
import { getRuntimeConfig } from '../services/configService.js';

const ids = [
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.4-mini-2026-03-17',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
];
const rates = [
  [2, 0.2, 12],
  [0.2, 0.02, 1.2],
  [0.75, 0.075, 4.5],
  [10, 1, 50],
  [2, 0.2, 10],
  [0.1, 0.01, 0.5],
];
const efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
test('six models have exact order, groups, defaults and verified capabilities', () => {
  assert.deepEqual(
    MODELS.map((m) => m.id),
    ids,
  );
  assert.deepEqual(
    MODELS.map((m) => m.group),
    ['Recommended', 'Recommended', 'Recommended', 'Other models', 'Other models', 'Other models'],
  );
  assert.deepEqual(
    MODELS.map((m) => m.name),
    ['GPT-5.6 Terra', 'GPT-5.6 Luna', 'GPT-5.4 mini', 'GPT-6 Astra', 'GPT-6 Sol', 'GPT-6 Luna'],
  );
  assert.equal(normalizeSettings().model, ids[0]);
  assert.equal(getRuntimeConfig({}).defaultSettings.model, ids[0]);
  assert.deepEqual(
    getRuntimeConfig({}).models.map((m) => m.id),
    ids,
  );
  assert.equal(getModel('gpt-5.4-mini'), undefined);
  for (const [index, model] of MODELS.entries()) {
    assert.deepEqual(
      model.reasoning,
      index === 2 ? efforts.slice(0, -1) : index === 3 ? efforts.slice(1) : efforts,
    );
    assert.equal(model.vision, true);
    assert.equal(model.files, true);
    assert.equal(model.verbosity, true);
    assert.equal(model.temperature, false);
    assert.equal(model.maxOutput, 128000);
    for (const effort of model.reasoning) {
      const request = buildResponseRequest(
        {
          settings: normalizeSettings({ model: model.id, reasoningEffort: effort }),
          messages: [{ role: 'user', text: 'test', attachments: [] }],
        },
        () => {},
      );
      assert.equal(request.model, model.id);
      assert.equal(request.reasoning.effort, effort);
      assert.equal(request.temperature, undefined);
    }
  }
});

test('legacy settings and imported chats normalize without changing message history', () => {
  for (const oldId of [
    'gpt-5.4-mini',
    'gpt-5.4',
    'gpt-5.5',
    'gpt-5.4-nano',
    'gpt-4.1',
    'gpt-5.6-sol',
    'unknown',
  ]) {
    const expected = oldId === 'gpt-5.4-mini' ? ids[2] : ids[0];
    const settings = {
      model: oldId,
      reasoningEffort: 'max',
      tools: ['web_search', 'invalid'],
      systemPrompt: 'keep me',
    };
    const normalized = normalizeSettings(settings);
    assert.equal(normalized.model, expected);
    assert.equal(normalized.systemPrompt, 'keep me');
    assert.deepEqual(normalized.tools, ['web_search']);
    assert.ok(getModel(expected).reasoning.includes(normalized.reasoningEffort));
    const [{ chat }] = parseBackup({
      title: 'Legacy',
      settings,
      messages: [
        { role: 'assistant', text: 'Historical response', model: oldId, status: 'complete' },
      ],
    });
    assert.equal(chat.settings.model, expected);
    assert.equal(chat.messages[0].text, 'Historical response');
    assert.equal(chat.messages[0].model, oldId);
  }
  assert.equal(
    normalizeSettings({ model: ids[3], reasoningEffort: 'none' }).reasoningEffort,
    'high',
  );
  assert.equal(
    normalizeSettings({ model: ids[2], reasoningEffort: 'max' }).reasoningEffort,
    'high',
  );
});

test('standard costs include cached input and exact long-context boundary for all six models', () => {
  for (const [index, model] of ids.entries()) {
    const [inputRate, cacheRate, outputRate] = rates[index];
    for (const input of [100000, 272000, 272001]) {
      const long = index !== 2 && input > 272000;
      const usage = {
        input_tokens: input,
        input_tokens_details: { cached_tokens: 10000 },
        output_tokens: 1000,
      };
      const expected =
        ((input - 10000) * inputRate * (long ? 2 : 1) +
          10000 * cacheRate * (long ? 2 : 1) +
          1000 * outputRate * (long ? 1.5 : 1)) /
        1000000;
      assert.equal(estimateCost({ model, usage }), expected);
    }
  }
  assert.equal(estimateCost({ model: ids[0] }), null);
  assert.equal(estimateCost({ model: 'unknown', usage: { input_tokens: 1 } }), null);
  assert.equal(
    estimateCost({ model: 'gpt-5.4-mini', usage: { input_tokens: 100000, output_tokens: 100000 } }),
    estimateCost({ model: ids[2], usage: { input_tokens: 100000, output_tokens: 100000 } }),
  );
});
