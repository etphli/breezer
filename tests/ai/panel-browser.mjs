import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPanelFixture } from './panel-browser-fixture.mjs';
import { captureStablePanel } from './ui-evidence-capture.mjs';

// This exercises the shipped UI in a real browser, with a deterministic extension
// API fixture. Native Chromium integration and paid model inference are separate.
const { chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../features/ai/extension');
const evidence = process.env.BREEZER_AI_EVIDENCE || '/tmp/breezer-ai-evidence';
const captureChecks = [];
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
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined),
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 400, height: 850 }, deviceScaleFactor: 2 });
  const openModelOptions = async () => {
    if (await page.locator('#model-menu').isHidden()) await page.locator('#model-button').click();
    if (!await page.locator('#inference-options').evaluate(node => node.open)) {
      await page.locator('#inference-options > summary').focus();
      await page.keyboard.press('Enter');
    }
  };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
  await page.addInitScript(installPanelFixture);
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedCommand = text; } } }));
  await page.goto(`http://127.0.0.1:${server.address().port}/panel.html`);
  await page.getByRole('button', { name: /GPT-6.1 Sol/ }).waitFor();
  assert.equal(await page.title(), 'Breezer assistant');
  assert.match(await page.locator('h1').innerText(), /^What are we working on\?$/);
  assert.equal(await page.locator('#greeting-name').innerText(), '');
  assert.equal(await page.locator('#context-title').innerText(), 'Designing a calmer browser');
  assert.equal(await page.locator('#send').isDisabled(), true);
  assert.equal(await page.locator('#reasoning-select').inputValue(), 'high');
  assert.equal(await page.locator('#speed-select').inputValue(), 'standard');
  assert.equal(await page.locator('#welcome-status').isVisible(), false);
  assert.equal(await page.locator('#context-hint').innerText(), 'Page + screenshot');
  await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-welcome.png` });
  for (const width of [400, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 850 });
    await page.locator('#control-toggle').hover();
    await page.locator('#control-tip').waitFor({ state: 'visible' });
    const tip = await page.locator('#control-tip').boundingBox();
    assert.ok(tip.x >= 0 && tip.x + tip.width <= width && tip.y >= 0, 'Control explanation stays in the panel');
    const composer = await page.locator('.compose-area').boundingBox();
    assert.ok(tip.y + tip.height <= composer.y, 'Control explanation leaves the composer and sharing status uncovered');
    const trigger = await page.locator('#control-toggle').boundingBox();
    const pointer = await page.locator('#control-tip').evaluate(node => parseFloat(node.style.getPropertyValue('--tip-pointer')));
    assert.ok(Math.abs(tip.x + pointer - trigger.x - trigger.width / 2) < 1, 'Tooltip pointer follows the browser-control trigger');
    await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-control-tooltip${width === 320 ? '-narrow' : ''}.png` });
    await page.mouse.move(1, 1);
  }
  await page.setViewportSize({ width: 400, height: 850 });
  await page.locator('#control-toggle').focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#control-tip').isVisible(), false, 'Escape dismisses the control explanation');

  // Keyboard: the model menu opens onto the selected model, arrows move, Escape returns focus.
  await page.locator('#model-button').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'GPT-6.1 Sol✓');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'GPT-6 Luna');
  await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-model-menu.png` });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#model-menu').isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'model-button');
  assert.equal(await page.locator('#model-label').innerText(), 'GPT-6.1 Sol');

  // Enter sends; Shift+Enter keeps writing.
  const chatsBefore = await page.evaluate(() => window.sent.filter((message) => message.type === 'chat').length);
  await page.getByLabel('Message Breezer').fill('First line');
  await page.getByLabel('Message Breezer').press('Shift+Enter');
  await page.keyboard.type('second line');
  assert.equal(await page.getByLabel('Message Breezer').inputValue(), 'First line\nsecond line');
  assert.equal(await page.evaluate(() => window.sent.filter((message) => message.type === 'chat').length), chatsBefore);
  await page.getByLabel('Message Breezer').press('Enter');
  const keyboardChat = await page.evaluate(() => window.sent.filter((message) => message.type === 'chat').at(-1));
  assert.equal(keyboardChat.message, 'First line\nsecond line');
  assert.equal(await page.getByLabel('Message Breezer').inputValue(), '');
  // Escape cancels a reply that has not started, and the message can be reused without being resent.
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate((id) => window.sent.some((message) => message.type === 'cancel' && message.id === id), keyboardChat.id), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'prompt');
  await page.getByRole('button', { name: 'Edit and resend' }).click();
  assert.equal(await page.getByLabel('Message Breezer').inputValue(), 'First line\nsecond line');
  assert.equal(await page.evaluate(() => window.sent.filter((message) => message.type === 'chat').length), chatsBefore + 1, 'Edit and resend never sends by itself');
  await page.getByLabel('Message Breezer').fill('');
  await page.getByRole('button', { name: 'New conversation' }).click();

  await page.getByRole('button', { name: 'Edit your personal context' }).click();
  await page.getByLabel('Your name', { exact: true }).fill('Ethan');
  await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-profile-dialog.png` });
  await page.setViewportSize({ width: 320, height: 640 });
  assert.equal(await page.locator('#profile-dialog').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  captureChecks.push({ file: 'sidebar-profile-dialog-narrow.png', ...await captureStablePanel(page, `${evidence}/sidebar-profile-dialog-narrow.png`, { surfaceSelector: '#profile-dialog', corruptFixture: resolve('tests/ai/fixtures/panel-dialog-corrupt.png') }) });
  await page.setViewportSize({ width: 400, height: 850 });
  await page.getByLabel('What should Breezer know?').fill('I build thoughtful software. Keep explanations clear and concise.');
  await page.getByRole('button', { name: 'Save context' }).click();
  assert.equal(await page.locator('#profile-dialog').isVisible(), false);
  assert.equal(await page.evaluate(() => window.testStorage.local.breezerProfile.context), 'I build thoughtful software. Keep explanations clear and concise.');

  await openModelOptions();
  await page.getByLabel('Reasoning effort', { exact: true }).selectOption('medium');
  await page.getByLabel('Codex speed', { exact: true }).selectOption('fast');
  await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-model-options.png` });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const optionsBounds = await page.locator('#inference-options').boundingBox();
  assert.ok(optionsBounds.x >= 0 && optionsBounds.x + optionsBounds.width <= 320 && optionsBounds.y >= 0 && optionsBounds.y + optionsBounds.height <= 640);
  captureChecks.push({ file: 'sidebar-model-options-narrow.png', ...await captureStablePanel(page, `${evidence}/sidebar-model-options-narrow.png`, { surfaceSelector: '#model-menu' }) });
  await page.setViewportSize({ width: 400, height: 850 });
  assert.match(await page.locator('#speed-note').innerText(), /more Codex allowance/);
  assert.equal(await page.locator('#notice').isVisible(), false, 'Speed guidance stays beside its setting');
  await page.keyboard.press('Escape');
  await page.locator('#model-button').click();
  await page.getByRole('button', { name: 'GPT-6 Luna', exact: true }).click();
  assert.equal(await page.locator('#model-label').innerText(), 'GPT-6 Luna');
  assert.equal(await page.locator('#reasoning-select').inputValue(), 'low');
  assert.equal(await page.locator('#speed-select').inputValue(), 'standard');
  assert.equal(await page.locator('#speed-select option[value="fast"]').evaluate(option => option.disabled), true);
  await page.locator('#model-button').click();
  assert.match(await page.locator('#model-menu').innerText(), /Connect Claude/);
  assert.doesNotMatch(await page.locator('#model-menu').innerText(), /claude auth login/);
  await page.getByRole('button', { name: 'Connect Claude', exact: true }).click();
  assert.equal(await page.locator('#account-dialog').isVisible(), true);
  await page.locator('#account-dialog').getByRole('button', { name: 'Copy Claude sign-in command' }).click();
  await page.waitForFunction(() => window.copiedCommand === 'claude auth login');
  assert.equal(await page.locator('#account-dialog [data-copy-command]').innerText(), 'Copied');
  assert.equal(await page.locator('#account-instructions code').textContent(), 'claude auth login');
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [400, 320]) {
      await page.setViewportSize({ width, height: width === 320 ? 640 : 850 });
      const file = `sidebar-account-dialog-${scheme}${width === 320 ? '-narrow' : ''}.png`;
      captureChecks.push({ file, ...await captureStablePanel(page, `${evidence}/${file}`, { surfaceSelector: '#account-dialog' }) });
      assert.equal(await page.locator('#account-dialog').evaluate(node => node.scrollWidth <= node.clientWidth), true);
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 400, height: 850 });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#account-dialog').isVisible(), false);
  await page.locator('#model-button').click();
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
  await openModelOptions();
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
  await openModelOptions();
  assert.equal(await page.locator('#speed-setting').isVisible(), true);
  assert.equal(await page.locator('#speed-select').inputValue(), 'fast');
  await page.locator('#reasoning-select').selectOption('xhigh');
  await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-settings.png` });
  await page.keyboard.press('Escape');

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
  await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-conversation.png` });

  const controlToggle = page.getByRole('button', { name: 'Browser control', exact: true });
  await controlToggle.click();
  assert.match(await page.locator('#notice-text').innerText(), /until you turn this off.*cannot use other tabs or apps/);
  assert.equal(await page.locator('#context-hint').innerText(), 'Page + browser control');
  assert.equal(await page.locator('#prompt').getAttribute('placeholder'), 'Tell Breezer what to do in this tab…');
  await page.getByLabel('Message Breezer').fill('Type my name into the form.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const firstControlChat = await page.evaluate(() => window.sent.filter((message) => message.type === 'chat').at(-1));
  assert.equal(firstControlChat.control, true);
  await page.evaluate((id) => { window.emit({ type: 'delta', id, text: 'Typed it.' }); window.emit({ type: 'complete', id }); }, firstControlChat.id);
  // A completed reply keeps consent for the same tab, so a follow-up can still act.
  assert.equal(await controlToggle.getAttribute('aria-pressed'), 'true');
  await page.getByLabel('Message Breezer').fill('Now click Save.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const followUpChat = await page.evaluate(() => window.sent.filter((message) => message.type === 'chat').at(-1));
  assert.equal(followUpChat.control, true);
  assert.equal(followUpChat.includeContext, true);
  await page.evaluate((id) => { window.emit({ type: 'delta', id, text: 'Saved.' }); window.emit({ type: 'complete', id }); }, followUpChat.id);
  // Consent never follows the user to another tab.
  await page.evaluate(() => window.emit({ type: 'context', context: { title: 'Another tab', url: 'https://example.org/', tabId: 12 } }));
  assert.equal(await controlToggle.getAttribute('aria-pressed'), 'false');
  assert.match(await page.locator('#notice-text').innerText(), /active tab changed/);
  await page.evaluate(() => window.emit({ type: 'context', context: { title: 'Designing a calmer browser', url: 'https://example.com/design', tabId: 11 } }));
  assert.equal(await controlToggle.getAttribute('aria-pressed'), 'false');
  await controlToggle.click();
  await page.getByLabel('Message Breezer').fill('Scroll down to the next section.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const controlChat = await page.evaluate(() => window.sent.filter((message) => message.type === 'chat').at(-1));
  assert.equal(controlChat.control, true);
  assert.equal(controlChat.history.length, 6);
  await page.evaluate((id) => window.emit({ type: 'activity', id, active: true, label: 'Scrolling this page' }), controlChat.id);
  assert.equal(await page.locator('#activity-label').innerText(), 'Browser control · Scrolling this page');
  assert.equal(await page.locator('#send-arrow').isVisible(), false);
  await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-working.png` });
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  assert.equal(await page.evaluate((id) => window.sent.some((message) => message.type === 'cancel' && message.id === id), controlChat.id), true);
  assert.equal(await page.locator('#activity').isVisible(), false);
  assert.equal(await controlToggle.getAttribute('aria-pressed'), 'false', 'Stop ends browser-control consent');

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
  await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-narrow.png` });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.evaluate(() => {
    window.testProviders[0].models.push(
      { id: 'gpt-6-sol', label: 'GPT-6 Sol' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
      { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', reasoningEfforts: ['low', 'high'], speeds: ['standard'] },
    );
    window.emit({ type: 'status', providers: window.testProviders });
  });
  await page.locator('#model-button').click();
  assert.equal(await page.getByRole('button', { name: 'GPT-6 Sol', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'GPT-5.6 Terra', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'GPT-6.1 Terra', exact: true }).click();
  await page.getByLabel('Message Breezer').fill('Exercise the error path');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const failedChat = await page.evaluate(() => window.sent.filter(message => message.type === 'chat').at(-1));
  assert.equal(failedChat.model, 'gpt-6.1-terra');
  await page.evaluate(id => window.emit({ type: 'error', id, error: 'CLI test rejection' }), failedChat.id);
  assert.match(await page.locator('.assistant .message-body').last().innerText(), /The assistant could not complete this response/);
  assert.equal(await page.getByText('CLI test rejection', { exact: true }).isVisible(), false, 'technical provider detail is initially disclosed');
  await page.locator('.error-details summary').last().click();
  assert.equal(await page.getByText('CLI test rejection', { exact: true }).isVisible(), true, 'exact provider detail remains available');
  await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-error-details-narrow.png` });
  await page.locator('.error-details summary').last().click();
  assert.equal(await page.locator('.message.failed').count(), 1);
  assert.equal(await page.locator('#notice').isVisible(), false, 'The failure is shown once, in the reply');
  assert.match(await page.locator('#announcer').textContent(), /The assistant could not complete this response/);
  await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-error-narrow.png` });
  await page.getByRole('button', { name: 'Edit and resend' }).click();
  assert.equal(await page.getByLabel('Message Breezer').inputValue(), 'Exercise the error path');
  assert.equal(await page.evaluate(() => window.sent.filter(message => message.type === 'chat').at(-1).id), failedChat.id, 'No automatic retry');
  await page.getByLabel('Message Breezer').fill('A draft I care about');
  await page.getByRole('button', { name: 'Edit and resend' }).click();
  assert.equal(await page.getByLabel('Message Breezer').inputValue(), 'A draft I care about', 'Edit and resend keeps an unrelated draft');
  assert.match(await page.locator('#notice-text').innerText(), /draft is still in the message box/);
  await page.getByLabel('Message Breezer').fill('');

  // A failed browser-control turn turns control off; reusing the message does not turn it back on.
  await page.getByRole('button', { name: 'Browser control', exact: true }).click();
  await page.getByLabel('Message Breezer').fill('Click the second link.');
  await page.getByLabel('Message Breezer').press('Enter');
  const failedControl = await page.evaluate(() => window.sent.filter(message => message.type === 'chat').at(-1));
  assert.equal(failedControl.control, true);
  await page.evaluate(id => window.emit({ type: 'error', id, error: 'The page changed before Breezer could click.' }), failedControl.id);
  assert.equal(await page.locator('#control-toggle').getAttribute('aria-pressed'), 'false');
  await page.getByRole('button', { name: 'Edit and resend' }).last().click();
  assert.equal(await page.locator('#control-toggle').getAttribute('aria-pressed'), 'false');
  assert.match(await page.locator('#notice-text').innerText(), /Browser control is off/);
  assert.equal(await page.evaluate(() => window.sent.filter(message => message.type === 'chat').at(-1).id), failedControl.id);
  await page.getByLabel('Message Breezer').fill('');
  await page.getByRole('button', { name: 'Close assistant', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.closedPanel), { windowId: 7 });
  await page.locator('#model-button').click();
  await page.getByRole('button', { name: 'GPT-6.1 Sol', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 400, height: 850 });
  await page.reload();
  await page.getByRole('button', { name: /GPT-6.1 Sol/ }).waitFor();
  assert.equal(await page.locator('#reasoning-select').inputValue(), 'xhigh');
  assert.equal(await page.locator('#speed-select').inputValue(), 'fast');
  await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-dark.png` });
  await page.evaluate(() => window.emit({ type: 'context', context: { title: 'New tab', url: 'chrome://newtab/' } }));
  assert.equal(await page.locator('#context-toggle').isDisabled(), true);
  assert.equal(await page.locator('#prompt').getAttribute('placeholder'), 'Ask anything…');
  assert.equal(await page.locator('#context-hint').innerText(), 'Only web pages can be shared');
  assert.equal(await page.locator('#control-toggle').isDisabled(), true);
  assert.match(await page.locator('#welcome-status').innerText(), /Open a web page/);
  assert.equal(await page.getByRole('button', { name: 'Summarize this page' }).isDisabled(), true);
  await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-dark-no-page.png` });
  assert.equal(await page.locator('#context-toggle').isHidden(), true, 'unavailable pages have no Include affordance');
  assert.equal(await page.locator('#control-toggle').isVisible(), false, 'browser control is unavailable on a non-web page');
  // Reduced motion: the thinking indicator does not animate.
  await page.getByLabel('Message Breezer').fill('Plain question');
  await page.getByLabel('Message Breezer').press('Enter');
  await page.locator('.thinking').last().waitFor();
  assert.equal(await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').length), 0);
  await page.keyboard.press('Escape');

  for (const width of [320, 400]) {
    await page.setViewportSize({ width, height: 640 });
    await page.emulateMedia({ reducedMotion: width === 320 ? 'reduce' : 'no-preference' });
    await page.getByRole('button', { name: 'New conversation' }).click();
    await page.getByLabel('Message Breezer').fill('Exercise streamed scroll anchoring');
    await page.getByLabel('Message Breezer').press('Enter');
    const streamed = await page.evaluate(async () => {
      const { renderMessage } = await import('./render-message.js');
      const id = window.sent.filter(message => message.type === 'chat').at(-1).id;
      const scroller = document.getElementById('conversation');
      const body = [...document.querySelectorAll('.assistant .message-body')].at(-1);
      let text = '';
      const append = async delta => {
        text += delta;
        window.emit({ type: 'delta', id, text: delta });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const expected = document.createElement('div');
        renderMessage(expected, text);
        return body.innerHTML === expected.innerHTML;
      };
      const first = await append(Array.from({ length: 24 }, (_, i) => `## Section ${i}\n\nA **formatted** paragraph with a [safe link](https://example.com/) and enough text to wrap in this narrow view.\n\n`).join(''));
      const committed = body.firstChild;
      scroller.scrollTop = 0;
      const beforeTop = committed.getBoundingClientRect().top;
      const second = await append('More **unfinished');
      const staysAbove = Math.abs(scroller.scrollTop) < 2 && Math.abs(committed.getBoundingClientRect().top - beforeTop) < 2;
      const keptNode = body.firstChild === committed;
      scroller.scrollTop = scroller.scrollHeight;
      const third = await append(' emphasis**\n\n```js\n' + 'const value = "long code tail";\n'.repeat(100));
      const followsBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 3;
      const fourth = await append('```\n\n- First\n- Second\n');
      window.emit({ type: 'complete', id });
      const expected = document.createElement('div');
      renderMessage(expected, text);
      return { prefixesMatch: first && second && third && fourth, staysAbove, keptNode, followsBottom, finalMatches: body.innerHTML === expected.innerHTML };
    });
    assert.deepEqual(streamed, { prefixesMatch: true, staysAbove: true, keptNode: true, followsBottom: true, finalMatches: true });
    await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-stream-scroll-${width}.png` });
  }

  // Signed out everywhere: the empty state says how to connect, and Enter opens the model menu instead of failing silently.
  await page.evaluate(() => {
    window.testProviders = [
      { id: 'codex', available: true, authenticated: false, models: [] },
      { id: 'claude', available: false, authenticated: false, models: [], error: 'Claude Code is not installed.' },
    ];
    window.emit({ type: 'status', providers: window.testProviders });
  });
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.evaluate(() => window.emit({ type: 'context', context: { title: 'Designing a calmer browser', url: 'https://example.com/design', tabId: 11 } }));
  assert.match(await page.locator('#welcome-status').innerText(), /Sign in to Codex or Claude/);
  assert.equal(await page.locator('#model-label').innerText(), 'Accounts');
  await page.getByLabel('Message Breezer').fill('Hello');
  await page.getByLabel('Message Breezer').press('Enter');
  assert.equal(await page.locator('#notice').isVisible(), false);
  assert.match(await page.locator('#welcome-status-text').innerText(), /Sign in to Codex or Claude/);
  assert.equal(await page.getByLabel('Message Breezer').inputValue(), 'Hello');
  assert.equal(await page.locator('#model-menu').isVisible(), true);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 320, height: 640 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  const signInGap = await page.evaluate(() => document.querySelector('#welcome-status').getBoundingClientRect().top - document.querySelector('#welcome h1').getBoundingClientRect().bottom);
  assert.ok(signInGap >= 16, `Signed-out heading and recovery card must not overlap: ${signInGap}px`);
  const accountWidth = await page.locator('#model-button').evaluate(node => node.getBoundingClientRect().width);
  const composerWidth = await page.locator('#composer').evaluate(node => node.getBoundingClientRect().width);
  assert.ok(accountWidth < composerWidth * .65, 'Accounts keeps a content-width focus target');
  await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-signed-out-narrow.png` });
  assert.equal(await page.locator('#welcome-account-steps code').first().isVisible(), false, 'commands are secondary to the sign-in explanation');
  await page.getByRole('button', { name: 'Set up an account', exact: true }).click();
  assert.equal(await page.locator('#welcome-account-steps code').first().isVisible(), true, 'sign-in instructions remain available');
  await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-signed-out-instructions-narrow.png` });
  await page.getByRole('button', { name: 'Copy Codex sign-in command' }).click();
  await page.waitForFunction(() => window.copiedCommand === 'codex login');
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Clipboard unavailable'); }; });
  await page.getByRole('button', { name: 'Copy Claude sign-in command' }).click();
  await page.waitForFunction(() => window.getSelection().toString() === 'claude auth login');
  assert.match(await page.locator('.copy-feedback').innerText(), /keyboard to copy/);
  await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-command-copy-fallback-narrow.png` });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const sentInits = await page.evaluate(() => window.sent.filter(message => message.type === 'init').length);
  await page.getByRole('button', { name: 'Refresh accounts' }).click();
  assert.equal(await page.evaluate(() => window.sent.filter(message => message.type === 'init').length), sentInits + 1);
  assert.deepEqual(errors, []);
  await writeFile(`${evidence}/panel-capture-geometry.json`, JSON.stringify(captureChecks, null, 2));
  const loading = await browser.newPage({ viewport: { width: 320, height: 640 } });
  await loading.addInitScript(installPanelFixture, { contextDelay: 30_000 });
  await loading.goto(`http://127.0.0.1:${server.address().port}/panel.html`);
  await loading.getByRole('button', { name: /GPT-6.1 Sol/ }).waitFor();
  assert.equal(await loading.locator('#context-toggle').isHidden(), true, 'unresolved page context has no sharing control');
  assert.equal(await loading.locator('#context-hint').innerText(), 'Loading current page…');
  await loading.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-page-loading-narrow.png` });
  await loading.evaluate(() => window.emit({ type: 'context', context: { title: 'Designing a calmer browser', url: 'https://example.com/design', tabId: 11 } }));
  assert.equal(await loading.locator('.context-row').isVisible(), true);
  assert.equal(await loading.locator('#context-hint').innerText(), 'Page + screenshot');
  await loading.close();
  console.log('PASS: real-browser sidebar rendering, profile, model/reasoning/speed selection and persistence, provider capability changes, chat settings/context, streaming Markdown, Enter/Shift+Enter, keyboard model menu, per-tab control consent across replies, control/cancel, Edit and resend without automatic retry, page and control status, signed-out and no-page empty states, injection safety, narrow, dark and reduced-motion layouts.');
  console.log(`Screenshots: ${evidence}`);
} finally {
  try { await browser?.close(); } finally {
    await new Promise(done => server.close(done));
  }
}
