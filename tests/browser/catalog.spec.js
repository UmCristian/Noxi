import { test, expect } from '@playwright/test';

const ids = [
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.4-mini-2026-03-17',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
];
async function boot(page) {
  await page.request.post('/login', { form: { key: 'e2e-access-key' } });
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), configured: true } });
  });
  await page.goto('/');
  await expect(page.locator('#save-state')).toHaveText('Saved');
}

test('real server catalog produces only the six ordered picker entries', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#model')).toHaveValue(ids[0]);
  expect(
    await page.locator('#model optgroup').evaluateAll((groups) => groups.map((g) => g.label)),
  ).toEqual(['Recommended', 'Other models']);
  expect(
    await page.locator('#model option').evaluateAll((options) => options.map((o) => o.value)),
  ).toEqual(ids);
});

test('stored legacy chats reopen and send valid model IDs without JavaScript errors', async ({
  page,
}) => {
  const errors = [];
  const requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await boot(page);
  await page.route('**/api/responses', (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      contentType: 'application/x-ndjson',
      body: '{"type":"delta","text":"New reply"}\n{"type":"done","status":"complete"}\n',
    });
  });
  for (const oldId of ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5.5', 'gpt-5.4-nano', 'gpt-4.1']) {
    await page.evaluate(async (oldModel) => {
      const storage = await import('/core/storage.js');
      const { newChat } = await import('/core/backup.js');
      const chat = newChat();
      chat.settings.model = oldModel;
      chat.settings.reasoningEffort = 'max';
      chat.messages = [
        {
          id: crypto.randomUUID(),
          role: 'user',
          text: 'Legacy message',
          attachments: [],
          status: 'complete',
        },
      ];
      await storage.saveChat(chat);
      await storage.setPreference('activeChat', chat.id);
    }, oldId);
    await page.reload();
    await expect(page.locator('#save-state')).toHaveText('Saved');
    const expected = oldId === 'gpt-5.4-mini' ? ids[2] : ids[0];
    await expect(page.locator('#model')).toHaveValue(expected);
    await expect(page.locator('.user')).toContainText('Legacy message');
    await page.locator('#message-input').fill('Continue');
    await page.locator('#send').click();
    await expect(page.locator('.assistant')).toContainText('New reply');
    await expect(page.locator('#stop')).toBeHidden();
    expect(requests.at(-1).settings.model).toBe(expected);
  }
  expect(errors).toEqual([]);
});
