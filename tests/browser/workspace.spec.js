import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const answer =
  '# A useful response\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconst value = 1;\n```\n\n<script>window.pwned=true</script>';
const ndjson = (...events) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';
async function boot(page) {
  await page.request.post('/login', { form: { key: 'e2e-access-key' } });
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), configured: true } });
  });
  await page.route('**/api/files', (route) =>
    route.fulfill({ json: { receipt: 'test-receipt', expiresAt: Date.now() + 1000000 } }),
  );
  await page.goto('/');
  await expect(page.locator('#save-state')).toHaveText('Saved');
}
async function mockAnswer(page, capture = () => {}) {
  await page.route('**/api/responses', (route) => {
    capture(route.request().postDataJSON());
    return route.fulfill({
      contentType: 'application/x-ndjson',
      body: ndjson(
        { type: 'delta', text: answer },
        { type: 'artifact', name: 'result.csv', mime: 'text/csv', data: 'YSxiCjEsMg==' },
        {
          type: 'done',
          status: 'complete',
          usage: { input_tokens: 30, output_tokens: 20, total_tokens: 50 },
        },
      ),
    });
  });
}
async function send(page, text = 'Hello') {
  await page.locator('#message-input').fill(text);
  await page.locator('#send').click();
  await expect(page.locator('.assistant .message-body')).toContainText('A useful response');
  await expect(page.locator('#stop')).toBeHidden();
}

test('Markdown, input files, generated downloads, persistence and backup round trip', async ({
  page,
}, info) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await boot(page);
  await mockAnswer(page);
  await page
    .locator('#file-input')
    .setInputFiles({ name: 'data.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2') });
  await expect(page.locator('#pending')).toContainText('data.csv');
  await send(page, 'Analyze this file');
  await expect(page.locator('.message-body table')).toBeVisible();
  await expect(page.locator('.code-copy')).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: info.outputPath('conversation.png') });
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  await page.reload();
  await expect(page.locator('.user .attachment')).toContainText('data.csv');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download result.csv' }).click();
  expect(await readFile(await (await downloading).path(), 'utf8')).toBe('a,b\n1,2');
  await page.locator('#backup-button').click();
  const backupEvent = page.waitForEvent('download');
  await page.locator('#export-current').click();
  const backup = JSON.parse(await readFile(await (await backupEvent).path(), 'utf8'));
  expect(backup.format).toBe('chatgui');
  expect(backup.version).toBe(2);
  expect(backup.chats[0].files).toHaveLength(2);
  expect(JSON.stringify(backup)).not.toContain('test-receipt');
  for (const [id, extension] of [
    ['export-md', '.md'],
    ['export-txt', '.txt'],
    ['export-docx', '.docx'],
  ]) {
    const pending = page.waitForEvent('download');
    await page.locator(`#${id}`).click();
    const output = await pending;
    expect(output.suggestedFilename()).toContain(extension);
    const bytes = await readFile(await output.path());
    expect(extension === '.docx' ? bytes.subarray(0, 2).toString() : bytes.toString()).toContain(
      extension === '.docx' ? 'PK' : 'Analyze this file',
    );
  }
  await page.locator('#backup-dialog [data-close]').click();
  await page.locator('#history-button').click();
  await page.locator('#import-input').setInputFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(page.locator('.chat-row')).toHaveCount(2);
  await page.locator('#search-chats').fill('Analyze');
  await expect(page.locator('.chat-row')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('paid Web Search requires confirmation for every request and regeneration', async ({
  page,
}) => {
  const requests = [];
  await boot(page);
  await mockAnswer(page, (body) => requests.push(body));
  await page.locator('#settings-button').click();
  await page.locator('#add-tools').click();
  await page.getByRole('switch', { name: 'Web Search', exact: true }).check();
  await page.locator('#close-settings').click();
  await page.locator('#message-input').fill('Search for something');
  await page.locator('#send').click();
  await expect(page.locator('#confirm-dialog')).toBeVisible();
  expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('#message-input')).toHaveValue('Search for something');
  await page.locator('#send').click();
  await page.locator('#confirm-accept').click();
  await expect(page.locator('.assistant')).toBeVisible();
  await expect(page.locator('#stop')).toBeHidden();
  expect(requests[0].webSearchConfirmed).toBe(true);
  await page.getByRole('button', { name: 'Regenerate', exact: true }).click();
  await expect(page.locator('#confirm-dialog')).toBeVisible();
  expect(requests).toHaveLength(1);
  await page.locator('#confirm-accept').click();
  await expect(page.locator('#stop')).toBeHidden();
  expect(requests).toHaveLength(2);
});

test('catalog capabilities, settings persistence, paid switches, editing and history', async ({
  page,
}, info) => {
  await boot(page);
  await mockAnswer(page);
  await page.locator('#settings-button').click();
  await page.locator('#model').selectOption('gpt-6-astra');
  await expect(page.locator('#effort option[value="none"]')).toHaveCount(0);
  await expect(page.locator('#verbosity')).toBeVisible();
  await page.locator('.advanced summary').click();
  await expect(page.locator('#temperature')).toBeHidden();
  await page.locator('#context').selectOption('window');
  await page.locator('#window').fill('6');
  await page.locator('#window').dispatchEvent('change');
  await page.locator('#add-tools').click();
  for (const name of ['Code Interpreter', 'Image Generation']) {
    await page.getByRole('switch', { name, exact: true }).check();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('switch', { name, exact: true })).not.toBeChecked();
    await page.getByRole('switch', { name, exact: true }).check();
    await page.locator('#confirm-accept').click();
  }
  await page.locator('#developer').fill('Be concise.');
  await page.locator('#add-block').click();
  await page.getByLabel('Instruction block').fill('Use examples.');
  await page.locator('#close-settings').click();
  await send(page, 'First message');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#message-input').fill('Edited message');
  await page.locator('#send').click();
  await page.locator('#confirm-accept').click();
  await expect(page.locator('#stop')).toBeHidden();
  await expect(page.locator('.message')).toHaveCount(2);
  await expect(page.locator('.user')).toContainText('Edited message');
  await page.locator('#rename').click();
  await page.locator('#confirm-input').fill('Research');
  await page.locator('#confirm-accept').click();
  await expect(page.locator('#rename')).toHaveText('Research');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await page.reload();
  await expect(page.locator('#rename')).toHaveText('Research');
  await page.locator('#settings-button').click();
  await expect(page.locator('#model')).toHaveValue('gpt-6-astra');
  await expect(page.locator('#window')).toHaveValue('6');
  await expect(page.locator('#developer')).toHaveValue('Be concise.');
  await expect(page.getByLabel('Instruction block')).toHaveValue('Use examples.');
  await page.screenshot({ animations: 'disabled', path: info.outputPath('settings.png') });
  await page.locator('#close-settings').click();
  await page.locator('#new-chat').click();
  await page.locator('#history-button').click();
  await page.getByRole('button', { name: 'Delete Research', exact: true }).click();
  await page.locator('#confirm-accept').click();
  await expect(page.locator('.chat-row')).toHaveCount(1);
});

test('incremental streaming, stop and reload preserve partial text', async ({ page }) => {
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (url, init = {}) => {
      if (url !== '/api/responses') return nativeFetch(url, init);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ type: 'delta', text: 'Partial response' }) + '\n',
              ),
            );
            init.signal.addEventListener('abort', () =>
              controller.error(new DOMException('Aborted', 'AbortError')),
            );
          },
        }),
        { headers: { 'Content-Type': 'application/x-ndjson' } },
      );
    };
  });
  await boot(page);
  await page.locator('#message-input').fill('Stream a response');
  await page.locator('#send').click();
  await expect(page.locator('.assistant')).toContainText('Partial response');
  await expect(page.locator('#stop')).toBeVisible();
  await page.locator('#settings-button').click();
  await expect(page.locator('#model')).toBeDisabled();
  await page.locator('#close-settings').click();
  await page.locator('#stop').click();
  await expect(page.locator('.assistant')).toContainText('Stopped');
  await page.reload();
  await expect(page.locator('.assistant')).toContainText('Partial response');
  await expect(page.locator('.assistant')).toContainText('Stopped');
});

test('errors retain messages and support retry', async ({ page }) => {
  await boot(page);
  await page.route('**/api/responses', (route) =>
    route.fulfill({ status: 429, json: { error: 'Test quota error' } }),
  );
  await page.locator('#message-input').fill('Keep this message');
  await page.locator('#send').click();
  await expect(page.locator('#notice')).toContainText('Test quota error');
  await expect(page.locator('.user')).toContainText('Keep this message');
  await page.unroute('**/api/responses');
  await mockAnswer(page);
  await page.getByRole('button', { name: 'Regenerate', exact: true }).click();
  await expect(page.locator('.assistant')).toContainText('A useful response');
  await expect(page.locator('.message')).toHaveCount(2);
});

test('responsive surfaces, themes, settings focus and local assets', async ({ page }, info) => {
  const failures = [];
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(response.url());
  });
  await boot(page);
  for (const [width, height] of [
    [1440, 960],
    [820, 1180],
    [390, 844],
    [320, 680],
  ]) {
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const box = await page.locator('#composer').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    await page.locator('#settings-button').click();
    await expect(page.locator('#close-settings')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    expect(
      await page.evaluate(() =>
        document.getElementById('settings').contains(document.activeElement),
      ),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#settings-button')).toBeFocused();
    for (const theme of ['light', 'dark']) {
      await page.locator('#appearance-button').click();
      await page.locator('#theme').selectOption(theme);
      await page.keyboard.press('Escape');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.screenshot({
        animations: 'disabled',
        path: info.outputPath(`workspace-${width}-${theme}.png`),
      });
    }
  }
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(failures).toEqual([]);
});

test('sign in, invalid password, sign out and local draft retention', async ({ page }, info) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get('/api/config')).status()).toBe(401);
  await page.locator('#key').fill('wrong');
  await page.locator('#login-submit').click();
  await expect(page.locator('#login-error')).toContainText('Incorrect');
  await page.locator('#toggle-password').click();
  await expect(page.locator('#key')).toHaveAttribute('type', 'text');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ animations: 'disabled', path: info.outputPath('login-mobile.png') });
  await page.locator('#key').fill('e2e-access-key');
  await page.locator('#login-submit').click();
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await page.locator('#message-input').fill('A persistent draft');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  await page.locator('#logout').click();
  await expect(page).toHaveURL(/\/login$/);
  await page.locator('#key').fill('e2e-access-key');
  await page.locator('#login-submit').click();
  await expect(page.locator('#message-input')).toHaveValue('A persistent draft');
});

test('second tab is read only and file limits are enforced', async ({ page, context }) => {
  await boot(page);
  await page.locator('#message-input').fill('Only one writer');
  await expect(page.locator('#save-state')).toHaveText('Saved');
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.locator('#notice')).toContainText('another tab');
  await expect(second.locator('#send')).toBeDisabled();
  await second.close();
  await page.locator('#file-input').setInputFiles({
    name: 'too-big.txt',
    mimeType: 'text/plain',
    buffer: Buffer.alloc(4 * 1024 * 1024 + 1, 'a'),
  });
  await expect(page.locator('#notice')).toContainText('limit');
  await expect(page.locator('#pending .attachment')).toHaveCount(0);
});

test('image previews, generated image persistence and remote cleanup', async ({ page }) => {
  await boot(page);
  const image =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6QWQAAAAASUVORK5CYII=';
  await page.locator('#file-input').setInputFiles({
    name: 'tiny.png',
    mimeType: 'image/png',
    buffer: Buffer.from(image, 'base64'),
  });
  await expect(page.locator('#pending img')).toBeVisible();
  await page.getByRole('button', { name: 'Remove tiny.png' }).click();
  await expect(page.locator('#pending .attachment')).toHaveCount(0);
  await page.locator('#file-input').setInputFiles({
    name: 'tiny.png',
    mimeType: 'image/png',
    buffer: Buffer.from(image, 'base64'),
  });
  await page.route('**/api/responses', (route) =>
    route.fulfill({
      contentType: 'application/x-ndjson',
      body: ndjson(
        { type: 'artifact', name: 'generated.png', mime: 'image/png', data: image },
        { type: 'done', status: 'complete' },
      ),
    }),
  );
  await page.locator('#message-input').fill('Create an image');
  await page.locator('#send').click();
  await expect(page.locator('.generated-image img')).toBeVisible();
  await expect(page.locator('#stop')).toBeHidden();
  await page.reload();
  await expect(page.locator('.generated-image img')).toBeVisible();
  let cleaned = false;
  await page.route('**/api/files/cleanup', (route) => {
    cleaned = true;
    return route.fulfill({ json: { deleted: 1 } });
  });
  await page.locator('#settings-button').click();
  await page.locator('.advanced summary').click();
  await page.locator('#cleanup').click();
  await page.locator('#confirm-accept').click();
  await expect.poll(() => cleaned).toBe(true);
  await page.locator('#close-settings').click();
  await expect(page.locator('.user img')).toBeVisible();
});
