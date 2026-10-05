import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { signFile, verifyFile } from '../services/fileService.js';

const previous = Object.fromEntries(
  ['OPENAI_API_KEY', 'PASS_KEY', 'VERCEL'].map((key) => [key, process.env[key]]),
);
process.env.OPENAI_API_KEY = '';
process.env.PASS_KEY = 'boundary-test-pass';
delete process.env.VERCEL;
const { default: app } = await import('../server.js');
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const nativeFetch = globalThis.fetch;
let externalRequests = 0;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin !== base) {
    externalRequests++;
    throw new Error('External requests are forbidden in boundary tests');
  }
  return nativeFetch(input, options);
};
const login = () =>
  fetch(base + '/login', {
    method: 'POST',
    body: new URLSearchParams({ key: 'boundary-test-pass' }),
    redirect: 'manual',
  });

test.after(() => {
  server.close();
  server.closeAllConnections();
  globalThis.fetch = nativeFetch;
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('known fallback receipts cannot trigger provider operations without an API key', async () => {
  const file = { id: 'file-boundary', image: false, expiresAt: Date.now() + 60000 };
  const payload = Buffer.from(JSON.stringify(file)).toString('base64url');
  const mac = createHmac('sha256', 'unconfigured').update(payload).digest('base64url');
  const receipt = `${payload}.${mac}`;
  assert.deepEqual(verifyFile(receipt), file);
  const response = await login();
  const cookie = response.headers.get('set-cookie').split(';')[0];
  for (const [endpoint, body] of [
    ['/api/files/cleanup', { receipts: [receipt] }],
    [
      '/api/responses',
      {
        settings: { model: 'gpt-5.4-mini-2026-03-17' },
        messages: [{ role: 'user', text: 'fixture', attachments: [{ receipt }] }],
      },
    ],
  ]) {
    const result = await fetch(base + endpoint, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(result.status, 503);
  }
  const form = new FormData();
  form.append('file', new Blob(['fixture']), 'fixture.txt');
  const upload = await fetch(base + '/api/files', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: form,
  });
  assert.equal(upload.status, 503);
  assert.equal(externalRequests, 0);
});

test('configuring or rotating the API key invalidates previous receipts', () => {
  const file = { id: 'file-boundary', image: false, expiresAt: Date.now() + 60000 };
  const fallbackReceipt = signFile(file);
  try {
    process.env.OPENAI_API_KEY = 'not-a-real-key-one';
    assert.throws(() => verifyFile(fallbackReceipt), { status: 400 });
    const configuredReceipt = signFile(file);
    assert.deepEqual(verifyFile(configuredReceipt), file);
    process.env.OPENAI_API_KEY = 'not-a-real-key-two';
    assert.throws(() => verifyFile(configuredReceipt), { status: 400 });
  } finally {
    process.env.OPENAI_API_KEY = '';
  }
});

test('cookies retain the localhost HTTP and Vercel HTTPS policy', async () => {
  for (const vercel of [false, true]) {
    if (vercel) process.env.VERCEL = '1';
    else delete process.env.VERCEL;
    const response = await login();
    const cookie = response.headers.get('set-cookie');
    assert.equal(response.status, 303);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Max-Age=604800/);
    assert.equal(/; Secure(?:;|$)/.test(cookie), vercel);
  }
  delete process.env.VERCEL;
});
