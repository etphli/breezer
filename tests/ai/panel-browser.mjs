import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

// This exercises the shipped UI in a real browser, with a deterministic extension
// API fixture. Native Chromium integration and paid model inference are separate.
const { chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../features/ai/extension');
const evidence = process.env.BREEZER_AI_EVIDENCE || '/tmp/breezer-ai-evidence';
await mkdir(evidence, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const path = resolve(root, `.${pathname}`);
    if (!path.startsWith(`${root}/`)) throw new Error('Outside fixture root');
    const content = await readFile(path);
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png' })[extname(path)] || 'application/octet-stream');
    response.end(content);
  } catch { response.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({
  executablePath: process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 400, height: 850 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
try {
  await page.addInitScript(() => {
    const storage = { local: JSON.parse(localStorage.getItem('breezer-fixture-local') || '{}'), session: {} };
    const callbacks = [];
    window.sent = [];
    window.emit = (message) => callbacks.forEach((callback) => callback(message));
    const area = (name) => ({
      get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in storage[name]).map((key) => [key, storage[name][key]])),
      set: async (items) => {
        Object.assign(storage[name], items);
        if (name === 'local') localStorage.setItem('breezer-fixture-local', JSON.stringify(storage.local));
      },
    });
    window.testStorage = storage;
    window.testProviders = [
      { id: 'codex', available: true, authenticated: true, defaultModel: 'gpt-6.1-sol', models: [
        { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'low', speeds: ['standard', 'fast'] },
        { id: 'gpt-6-luna', label: 'GPT-6 Luna', reasoningEfforts: ['low', 'medium'], defaultReasoningEffort: 'low', speeds: ['standard'] },
      ] },
      { id: 'claude', available: true, authenticated: false, models: [], error: 'Sign in with claude auth login, then refresh.' },
    ];
    window.chrome = {
      storage: { local: area('local'), session: area('session') },
      windows: { getCurrent: async () => ({ id: 7 }) },
      runtime: {
        connect: () => ({
          onMessage: { addListener: (fn) => callbacks.push(fn) },
          onDisconnect: { addListener: () => {} },
          postMessage: (message) => {
            window.sent.push(message);
            if (message.type === 'init') setTimeout(() => window.emit({ type: 'status', providers: window.testProviders }), 10);
            if (message.type === 'context') setTimeout(() => window.emit({ type: 'context', context: { title: 'Designing a calmer browser', url: 'https://example.com/design' } }), 10);
          },
        }),
      },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/panel.html`);
  await page.getByRole('button', { name: /GPT-6.1 Sol/ }).waitFor();
  assert.equal(await page.title(), 'Breezer assistant');
  assert.match(await page.locator('body').innerText(), /What are we working on,/);
  assert.equal(await page.locator('#greeting-name').innerText(), 'Ethan');
  assert.equal(await page.locator('#context-title').innerText(), 'Designing a calmer browser');
  assert.equal(await page.locator('#send').isDisabled(), true);
  assert.equal(await page.locator('#reasoning-select').inputValue(), 'high');
  assert.equal(await page.locator('#speed-select').inputValue(), 'standard');
  await page.screenshot({ path: `${evidence}/sidebar-welcome.png` });

  await page.getByRole('button', { name: 'Edit your personal context' }).click();
  await page.getByLabel('Your name', { exact: true }).fill('Ethan');
  await page.getByLabel('What should Breezer know?').fill('I build thoughtful software. Keep explanations clear and concise.');
  await page.getByRole('button', { name: 'Save context' }).click();
  assert.equal(await page.locator('dialog').isVisible(), false);
  assert.equal(await page.evaluate(() => window.testStorage.local.breezerProfile.context), 'I build thoughtful software. Keep explanations clear and concise.');

  await page.getByLabel('Reasoning effort', { exact: true }).selectOption('medium');
  await page.getByLabel('Codex speed', { exact: true }).selectOption('fast');
  assert.match(await page.locator('#notice-text').innerText(), /more of your Codex allowance/);
  await page.locator('#dismiss-notice').click();
  await page.locator('#model-button').click();
  await page.getByRole('button', { name: 'GPT-6 Luna', exact: true }).click();
  assert.equal(await page.locator('#model-label').innerText(), 'GPT-6 Luna');
  assert.equal(await page.locator('#reasoning-select').inputValue(), 'low');
  assert.equal(await page.locator('#speed-select').inputValue(), 'standard');
  assert.equal(await page.locator('#speed-select option[value="fast"]').evaluate(option => option.disabled), true);
  await page.locator('#model-button').click();
  assert.match(await page.locator('#model-menu').innerText(), /Sign in required/);
  await page.getByRole('button', { name: 'GPT-6.1 Sol', exact: true }).click();
  assert.equal(await page.locator('#reasoning-select').inputValue(), 'medium');
  assert.equal(await page.locator('#speed-select').inputValue(), 'fast');
  await page.reload();
  await page.getByRole('button', { name: /GPT-6.1 Sol/ }).waitFor();
  assert.equal(await page.locator('#reasoning-select').inputValue(), 'medium');
  assert.equal(await page.locator('#speed-select').inputValue(), 'fast');
  assert.deepEqual(await page.evaluate(() => window.testStorage.local.breezerModelPreferences['codex:gpt-6.1-sol']), { reasoning: 'medium', speed: 'fast' });

  await page.evaluate(() => {
    window.testProviders[1] = { id: 'claude', available: true, authenticated: true, models: [
      { id: 'opus', label: 'Claude Opus', reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: null },
      { id: 'haiku', label: 'Claude Haiku', reasoningEfforts: [], defaultReasoningEffort: null },
    ] };
    window.emit({ type: 'status', providers: window.testProviders });
  });
  await page.locator('#model-button').click();
  await page.getByRole('button', { name: 'Claude Opus', exact: true }).click();
  assert.equal(await page.locator('#speed-setting').isVisible(), false);
  assert.equal(await page.locator('#reasoning-select').inputValue(), 'high');
  await page.locator('#reasoning-select').selectOption('low');
  await page.getByLabel('Message Breezer').fill('A Claude settings check');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const claudeChat = await page.evaluate(() => window.sent.filter(message => message.type === 'chat').at(-1));
  assert.equal(claudeChat.reasoning, 'low');
  assert.equal(Object.hasOwn(claudeChat, 'speed'), false);
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.locator('#model-button').click();
  await page.getByRole('button', { name: 'Claude Haiku', exact: true }).click();
  assert.equal(await page.locator('#reasoning-select').isDisabled(), true);
  assert.equal(await page.locator('#reasoning-select').inputValue(), '');
  await page.getByLabel('Message Breezer').fill('Use the CLI default');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const defaultChat = await page.evaluate(() => window.sent.filter(message => message.type === 'chat').at(-1));
  assert.equal(Object.hasOwn(defaultChat, 'reasoning'), false);
  assert.equal(Object.hasOwn(defaultChat, 'speed'), false);
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.locator('#model-button').click();
  await page.getByRole('button', { name: 'Claude Opus', exact: true }).click();
  assert.equal(await page.locator('#reasoning-select').inputValue(), 'low');
  await page.locator('#model-button').click();
  await page.getByRole('button', { name: 'GPT-6.1 Sol', exact: true }).click();
  assert.equal(await page.locator('#speed-setting').isVisible(), true);
  assert.equal(await page.locator('#speed-select').inputValue(), 'fast');
  await page.locator('#reasoning-select').selectOption('xhigh');
  await page.screenshot({ path: `${evidence}/sidebar-settings.png` });

  await page.getByRole('button', { name: 'Summarize this page' }).click();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const firstChat = await page.evaluate(() => window.sent.filter((message) => message.type === 'chat').at(-1));
  assert.equal(firstChat.provider, 'codex');
  assert.equal(firstChat.model, 'gpt-6.1-sol');
  assert.equal(firstChat.includeContext, true);
  assert.equal(firstChat.control, false);
  assert.equal(firstChat.profile.name, 'Ethan');
  assert.equal(firstChat.reasoning, 'xhigh');
  assert.equal(firstChat.speed, 'fast');
  for (const id of ['model-button', 'reasoning-select', 'speed-select']) assert.equal(await page.locator(`#${id}`).isDisabled(), true);
  await page.evaluate((id) => {
    window.emit({ type: 'delta', id, text: 'The page makes a simple point: **a browser should give you room to think**.\n\n- Keep the page at the centre.\n- Make useful actions easy to find.\n- Let people stay in control.\n\nThe strongest idea is to show the assistant only when you need a hand.' });
    window.emit({ type: 'complete', id });
  }, firstChat.id);
  await page.locator('.assistant .message-body strong').waitFor();
  assert.equal(await page.locator('.assistant .message-body li').count(), 3);
  assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isVisible(), true);
  for (const id of ['model-button', 'reasoning-select', 'speed-select']) assert.equal(await page.locator(`#${id}`).isDisabled(), false);
  await page.screenshot({ path: `${evidence}/sidebar-conversation.png` });

  await page.getByRole('button', { name: 'Browser control', exact: true }).click();
  await page.getByLabel('Message Breezer').fill('Scroll down to the next section.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const controlChat = await page.evaluate(() => window.sent.filter((message) => message.type === 'chat').at(-1));
  assert.equal(controlChat.control, true);
  assert.equal(controlChat.history.length, 2);
  await page.evaluate((id) => window.emit({ type: 'activity', id, active: true, label: 'Scrolling this page' }), controlChat.id);
  assert.equal(await page.locator('#activity-label').innerText(), 'Scrolling this page');
  assert.equal(await page.locator('#send-arrow').isVisible(), false);
  await page.screenshot({ path: `${evidence}/sidebar-working.png` });
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  assert.equal(await page.evaluate((id) => window.sent.some((message) => message.type === 'cancel' && message.id === id), controlChat.id), true);
  assert.equal(await page.locator('#activity').isVisible(), false);

  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.locator('#context-toggle').click();
  await page.getByLabel('Message Breezer').fill('Test untrusted formatting');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const untrustedChat = await page.evaluate(() => window.sent.filter((message) => message.type === 'chat').at(-1));
  assert.equal(untrustedChat.includeContext, false);
  assert.equal(untrustedChat.control, false);
  await page.evaluate((id) => {
    window.emit({ type: 'delta', id, text: '<img src=x onerror="window.injected=true">\n\n[unsafe](javascript:alert(1))\n\n[safe](https://example.com/)' });
    window.emit({ type: 'complete', id });
  }, untrustedChat.id);
  assert.equal(await page.locator('.message-body img').count(), 0);
  assert.equal(await page.locator('.message-body a').count(), 1);
  assert.equal(await page.evaluate(() => window.injected), undefined);

  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.setViewportSize({ width: 320, height: 640 });
  await page.screenshot({ path: `${evidence}/sidebar-narrow.png` });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 400, height: 850 });
  await page.reload();
  await page.getByRole('button', { name: /GPT-6.1 Sol/ }).waitFor();
  assert.equal(await page.locator('#reasoning-select').inputValue(), 'xhigh');
  assert.equal(await page.locator('#speed-select').inputValue(), 'fast');
  await page.screenshot({ path: `${evidence}/sidebar-dark.png` });
  await page.evaluate(() => window.emit({ type: 'context', context: { title: 'New tab', url: 'chrome://newtab/' } }));
  assert.equal(await page.locator('#context-toggle').isDisabled(), true);
  assert.equal(await page.locator('#prompt').getAttribute('placeholder'), 'Ask anything…');
  assert.equal(await page.locator('#context-hint').innerText(), 'Page not shared');
  assert.deepEqual(errors, []);
  console.log('PASS: real-browser sidebar rendering, profile, model/reasoning/speed selection and persistence, provider capability changes, chat settings/context, streaming Markdown, control/cancel, injection safety, narrow and dark layouts.');
  console.log(`Screenshots: ${evidence}`);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
