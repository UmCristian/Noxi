import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { MODELS, normalizeSettings, selectContext } from '../public/core/models.js';
import { newChat, parseBackup, makeBackup } from '../public/core/backup.js';
import * as store from '../public/core/storage.js';
import { buildResponseRequest } from '../services/requestService.js';
import { inspectUpload, signFile, verifyFile } from '../services/fileService.js';
import { prepareMessages, readNDJSON } from '../public/core/api.js';
import { estimateCost } from '../public/core/usage.js';
import { streamResponse } from '../services/openaiService.js';

const request = (settings = {}) => ({
  settings: { ...normalizeSettings(), ...settings },
  messages: [{ role: 'user', text: 'Hola', attachments: [] }],
});
test('paid web requires fresh explicit request confirmation including auto', () => {
  const body = request({ tools: ['web_search'] });
  assert.throws(() => buildResponseRequest(body, verifyFile), { status: 428 });
  body.webSearchConfirmed = true;
  const built = buildResponseRequest(body, verifyFile);
  assert.equal(built.tool_choice, 'auto');
  assert.deepEqual(built.tools, [{ type: 'web_search' }]);
  delete body.webSearchConfirmed;
  assert.throws(() => buildResponseRequest(body, verifyFile), { status: 428 });
});
test('model compatibility, default tools off, JSON and context', () => {
  const built = buildResponseRequest(request(), verifyFile);
  assert.equal(built.model, 'gpt-5.6-luna');
  assert.equal(built.store, false);
  assert.equal(built.tools, undefined);
  assert.equal(built.reasoning.effort, 'high');
  assert.equal(built.text.verbosity, 'medium');
  assert.equal(built.temperature, undefined);
  const other = buildResponseRequest(
    request({ model: 'gpt-4.1', maxOutputTokens: 99999 }),
    verifyFile,
  );
  assert.equal(other.reasoning, undefined);
  assert.equal(other.text.verbosity, undefined);
  assert.equal(other.max_output_tokens, 32768);
  assert.equal(buildResponseRequest(request({ model: 'gpt-5.4' }), verifyFile).model, 'gpt-5.4');
  const json = buildResponseRequest(request({ format: 'json_object' }), verifyFile);
  assert.match(json.instructions, /JSON/);
  assert.equal(
    selectContext(
      [
        { role: 'user', text: 'a' },
        { role: 'assistant', text: 'b' },
        { role: 'user', text: 'c' },
      ],
      { contextStrategy: 'last_turn' },
    ).length,
    1,
  );
  assert.throws(() => buildResponseRequest(request({ model: 'made-up' }), verifyFile));
});

test('a catalog entry alone controls server parameters, tools and input capabilities', async () => {
  const model = {
    id: 'catalog-fixture',
    name: 'Fixture',
    reasoning: [],
    verbosity: false,
    temperature: true,
    vision: false,
    files: false,
    tools: [],
    maxOutput: 100,
    pricing: { rates: [1, 0.1, 2] },
  };
  MODELS.push(model);
  try {
    const built = buildResponseRequest(
      request({ model: model.id, maxOutputTokens: 999 }),
      verifyFile,
    );
    assert.equal(built.max_output_tokens, 100);
    assert.equal(built.reasoning, undefined);
    assert.equal(built.text.verbosity, undefined);
    assert.equal(built.temperature, 1);
    assert.throws(
      () => buildResponseRequest(request({ model: model.id, tools: ['web_search'] }), verifyFile),
      /not supported/,
    );
    const body = request({ model: model.id });
    body.messages[0].attachments = [{ receipt: 'fixture' }];
    for (const image of [true, false])
      assert.throws(
        () => buildResponseRequest(body, () => ({ id: 'file-fixture', image })),
        /does not support/,
      );
    await assert.rejects(
      prepareMessages(
        {
          settings: normalizeSettings({ model: model.id }),
          messages: [{ role: 'user', text: 'image', attachments: [{ name: 'a.png' }] }],
        },
        new AbortController().signal,
        () => {},
      ),
      /does not support images/,
    );
    assert.equal(
      estimateCost({ model: model.id, usage: { input_tokens: 1000000, output_tokens: 1000000 } }),
      3,
    );
  } finally {
    MODELS.splice(MODELS.indexOf(model), 1);
  }
});
test('uploads verify actual bytes and tamper-proof references', () => {
  assert.throws(() =>
    inspectUpload({ originalname: 'x.png', size: 4, buffer: Buffer.from('fake') }),
  );
  const file = { id: 'file-test', expiresAt: Date.now() + 100000, image: false };
  assert.deepEqual(verifyFile(signFile(file)), file);
  assert.throws(() => verifyFile(signFile(file).slice(0, -3) + 'bad'));
  assert.throws(() => verifyFile(signFile({ ...file, expiresAt: 0 })), { status: 410 });
});
test('legacy migration strips secrets and restores interrupted state', () => {
  const [{ chat }] = parseBackup({
    title: 'Old',
    model: 'gpt-5.4',
    systemPrompt: 'guide',
    apiKey: 'do-not-export',
    messages: [
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'partial', status: 'streaming' },
    ],
  });
  assert.equal(chat.settings.model, 'gpt-5.4');
  assert.equal(chat.settings.systemPrompt, 'guide');
  assert.equal(chat.messages[1].status, 'interrupted');
  assert.equal(chat.apiKey, undefined);
  assert.throws(() => parseBackup({ format: 'chatgui', version: 99, chats: [] }));
});
test('IndexedDB persists chats and blobs atomically and deletion cleans files', async () => {
  const chat = newChat();
  const id = crypto.randomUUID();
  chat.pendingAttachments = [{ id, name: 'a.txt', type: 'text/plain', size: 3 }];
  await store.saveChat(chat, [{ id, chatId: chat.id, blob: new Blob(['abc']) }]);
  assert.equal((await store.listChats()).find((c) => c.id === chat.id).title, chat.title);
  assert.equal(await (await store.getFile(id)).blob.text(), 'abc');
  await store.deleteChat(chat.id);
  assert.equal(await store.getFile(id), undefined);
});
test('versioned backup remaps ids, keeps settings, restores attachment bytes', async () => {
  const [{ chat, files }] = parseBackup({
    format: 'chatgui',
    version: 2,
    chats: [
      {
        title: 'backup',
        settings: { model: 'gpt-5.4', tools: ['web_search'] },
        messages: [
          {
            role: 'user',
            text: 'x',
            attachments: [{ id: 'a', name: 'a.txt', size: 3, receipt: 'secret' }],
          },
        ],
        files: [{ id: 'a', data: 'data:text/plain;base64,YWJj' }],
      },
    ],
  });
  assert.equal(files[0].id, chat.messages[0].attachments[0].id);
  assert.notEqual(files[0].id, 'a');
  assert.equal(await files[0].blob.text(), 'abc');
  assert.equal(chat.messages[0].attachments[0].receipt, undefined);
  await store.importRecords([{ chat, files }]);
  assert.equal((await store.getFiles(chat.id)).length, 1);
});
test('NDJSON handles multibyte split and final line without newline', async () => {
  const bytes = new TextEncoder().encode('{"text":"ñ"}\n{"type":"done"}');
  const events = [];
  await readNDJSON(
    new ReadableStream({
      start(c) {
        for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
        c.close();
      },
    }),
    (e) => events.push(e),
  );
  assert.equal(events[0].text, 'ñ');
  assert.equal(events[1].type, 'done');
});
test('provider adapter detects files, citations and incomplete responses', async () => {
  const events = [];
  const item = {
    type: 'message',
    content: [
      {
        annotations: [
          {
            type: 'container_file_citation',
            file_id: 'cfile_test',
            container_id: 'cntr_test',
            filename: 'result.csv',
          },
          { type: 'url_citation', url: 'https://example.com', title: 'Source' },
        ],
      },
    ],
  };
  const client = {
    responses: {
      async *create() {
        yield { type: 'response.output_text.delta', delta: 'Hi' };
        yield { type: 'response.output_item.done', item };
        yield {
          type: 'response.incomplete',
          response: { output: [item], usage: { total_tokens: 2 } },
        };
      },
    },
    containers: {
      files: {
        content: {
          retrieve: async () => new Response('a,b', { headers: { 'content-type': 'text/csv' } }),
        },
      },
    },
  };
  await streamResponse(client, {}, new AbortController().signal, (e) => events.push(e));
  assert.equal(events.filter((e) => e.type === 'artifact').length, 1);
  assert.equal(events.find((e) => e.type === 'artifact').data, 'YSxi');
  assert.equal(events.at(-1).status, 'incomplete');
});
