import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../server.js';

const previousKey = process.env.OPENAI_API_KEY;
const previousPass = process.env.PASS_KEY;
delete process.env.OPENAI_API_KEY;
process.env.PASS_KEY = 'local-test-key';
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const initialLogin = await globalThis.fetch(base + '/login', {
  method: 'POST',
  body: new URLSearchParams({ key: 'local-test-key' }),
  redirect: 'manual',
});
const sessionCookie = initialLogin.headers.get('set-cookie').split(';')[0];
const fetch = (url, options = {}) =>
  globalThis.fetch(url, { ...options, headers: { Cookie: sessionCookie, ...options.headers } });
const json = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
test.after(() => {
  server.close();
  server.closeAllConnections();
  if (previousKey) process.env.OPENAI_API_KEY = previousKey;
  if (previousPass) process.env.PASS_KEY = previousPass;
});

test('server config is safe, old data is not served, CSP and unknown APIs', async () => {
  const response = await fetch(base + '/api/config');
  const config = await response.json();
  assert.equal(config.configured, false);
  assert.equal(config.models[0].id, 'gpt-5.6-luna');
  assert.equal(config.openAIApiKey, undefined);
  assert.match(response.headers.get('content-security-policy'), /object-src 'none'/);
  assert.equal((await fetch(base + '/data/chats/a.json')).status, 404);
  assert.equal((await fetch(base + '/.env')).status, 404);
  assert.equal((await fetch(base + '/api/chats')).status, 404);
});
test('server rejects unconfirmed paid web before any provider call', async () => {
  const response = await fetch(
    base + '/api/responses',
    json({
      settings: { model: 'gpt-5.4-mini', tools: ['web_search'] },
      messages: [{ role: 'user', text: 'x', attachments: [] }],
    }),
  );
  assert.equal(response.status, 428);
  assert.match((await response.json()).error, /charges/);
});
test('server rejects spoofed binary and oversized uploads', async () => {
  const fake = new FormData();
  fake.append('file', new Blob(['not a PDF']), 'fake.pdf');
  assert.equal((await fetch(base + '/api/files', { method: 'POST', body: fake })).status, 400);
  const large = new FormData();
  large.append('file', new Blob([new Uint8Array(4 * 1024 * 1024 + 1)]), 'large.pdf');
  assert.equal((await fetch(base + '/api/files', { method: 'POST', body: large })).status, 413);
});
test('Word export produces a real ZIP document without OpenAI', async () => {
  const response = await fetch(
    base + '/api/exports/docx',
    json({ text: 'A real local export\nSecond paragraph' }),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /wordprocessingml/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');
});
test('cross-origin writes are rejected', async () => {
  const response = await fetch(base + '/api/exports/docx', {
    ...json({ text: 'x' }),
    headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' },
  });
  assert.equal(response.status, 403);
});
test('mandatory passkey uses signed expiring HttpOnly cookie and protects API', async () => {
  process.env.PASS_KEY = 'local-test-key';
  try {
    assert.equal((await globalThis.fetch(base + '/api/config')).status, 401);
    assert.equal((await fetch(base + '/login')).status, 200);
    assert.equal((await fetch(base + '/tokens.css')).status, 200);
    const login = await fetch(base + '/login', {
      method: 'POST',
      body: new URLSearchParams({ key: 'local-test-key' }),
      redirect: 'manual',
    });
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.ok(!cookie.includes('local-test-key'));
    assert.equal(
      (await fetch(base + '/api/config', { headers: { Cookie: cookie.split(';')[0] } })).status,
      200,
    );
  } finally {
    process.env.PASS_KEY = 'local-test-key';
  }
});

test('missing PASS_KEY never opens the application and wrong passwords are rejected', async () => {
  delete process.env.PASS_KEY;
  assert.equal((await globalThis.fetch(base + '/api/config')).status, 503);
  const blocked = await globalThis.fetch(base + '/', { redirect: 'manual' });
  assert.equal(blocked.headers.get('location'), '/login?setup=1');
  process.env.PASS_KEY = 'local-test-key';
  const rejected = await globalThis.fetch(base + '/login', {
    method: 'POST',
    body: new URLSearchParams({ key: 'wrong-key' }),
    redirect: 'manual',
  });
  assert.equal(rejected.headers.get('location'), '/login?error=1');
  assert.equal(rejected.headers.get('set-cookie'), null);
  const malformed = await globalThis.fetch(base + '/api/config', {
    headers: { Cookie: sessionCookie + 'bad' },
  });
  assert.equal(malformed.status, 401);
  const logout = await fetch(base + '/logout', { method: 'POST', redirect: 'manual' });
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
});
