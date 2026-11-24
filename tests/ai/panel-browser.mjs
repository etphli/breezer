import { attachmentParts } from '../../features/ai/host/attachments.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPanelFixture } from './panel-browser-fixture.mjs';
import { installPanelAreaEvents } from './fixtures/host-main-port/panel-storage-fixture.mjs';
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
    if (!path.startsWith(`${root}${sep}`)) throw new Error('Outside fixture root');
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
  // Reasoning and speed share the model picker's surface, so opening it is enough.
  const openModelOptions = async () => {
    if (await page.locator('#model-menu').isHidden()) await page.locator('#model-button').click();
  };
  const checked = name => page.evaluate(name => document.querySelector(`input[name="${name}"]:checked`)?.value ?? '', name);
  const choose = (group, label) => page.locator(group).getByRole('radio', { name: label, exact: true }).check();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    window.panelOpacityFrames = [];
    const sample = () => {
      const panel = document.querySelector('.panel');
      if (panel) window.panelOpacityFrames.push(getComputedStyle(panel).opacity);
      if (window.panelOpacityFrames.length < 12) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.addInitScript({ content: `(${installPanelFixture.toString()})(); (${installPanelAreaEvents.toString()})();` });
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedCommand = text; } } }));
  await page.goto(`http://127.0.0.1:${server.address().port}/panel.html`);
  await page.getByRole('button', { name: /GPT-6.1 Sol/ }).waitFor();
  assert.equal(await page.title(), 'Breezer assistant');
  await page.waitForFunction(() => window.panelOpacityFrames.length >= 12);
  assert.equal(await page.evaluate(() => window.panelOpacityFrames.every(opacity => opacity === '1')), true, 'assistant text remains opaque through its entrance');
  assert.match(await page.locator('h1').innerText(), /^What are we working on\?$/);
  assert.equal(await page.locator('#greeting-name').innerText(), '');
  assert.equal(await page.locator('#context-title').innerText(), 'Designing a calmer browser');
  assert.equal(await page.locator('#send').isDisabled(), true);
  assert.equal(await checked('reasoning'), 'high');
  assert.equal(await checked('speed'), 'standard');
  assert.equal(await page.locator('#model-effort').innerText(), 'High', 'the composer names the linked reasoning level');
  assert.equal(await page.locator('#welcome-status').isVisible(), false);
  assert.equal(await page.locator('#context-hint').innerText(), 'Page + screenshot');
  await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-welcome.png` });
  for (const width of [400, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 850 });
    await page.locator('#control-toggle').hover();
    await page.locator('#control-tip').waitFor({ state: 'visible' });
    const tip = await page.locator('#control-tip').boundingBox();
    assert.ok(tip.x >= 0 && tip.x + tip.width <= width && tip.y >= 0, 'Control explanation stays in the panel');
    const writing = await page.locator('#prompt').boundingBox();
    assert.ok(tip.y + tip.height <= writing.y, 'Control explanation leaves the writing area uncovered');
    const trigger = await page.locator('#control-toggle').boundingBox();
    assert.ok(tip.y + tip.height <= trigger.y, 'Control explanation sits above the permission controls');
    const suggestion = await page.locator('[data-control="true"]').boundingBox();
    assert.ok(tip.y >= suggestion.y + suggestion.height, 'Control explanation leaves the suggestion uncovered');
    const sharing = await page.locator('#context-toggle').boundingBox();
    assert.ok(sharing.x + sharing.width < trigger.x, 'Sharing and control fit side by side without overlap');
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

  const closeModelPicker = page.getByRole('button', { name: 'Close model picker' });
  const modelMenu = page.locator('#model-menu');
  await page.setViewportSize({ width: 320, height: 400 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('#model-button').click();
  assert.equal(await closeModelPicker.isVisible(), true, 'the model list has a visible close button');
  await modelMenu.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-model-menu-close.png` });
  await page.setViewportSize({ width: 320, height: 340 });
  assert.ok(await modelMenu.evaluate(node => {
    node.scrollTop = node.scrollHeight;
    return node.scrollTop;
  }), 'the model list scrolls in a short panel');
  assert.equal(await closeModelPicker.evaluate(button => {
    const { x, y, width, height } = button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(x + width / 2, y + height / 2));
  }), true, 'the close button stays reachable after scrolling');
  await closeModelPicker.click();
  assert.equal(await modelMenu.isHidden(), true);
  assert.equal(await page.locator('#model-button').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'model-button');
  assert.equal(await page.locator('#model-label').innerText(), 'GPT-6.1 Sol');

  // Search, provider filter and layout at the narrowest and a roomy sidebar width.
  const visibleModels = () => page.locator('#model-options .model-option').evaluateAll(nodes => nodes.map(node => node.firstChild.textContent));
  for (const width of [280, 450]) {
    await page.setViewportSize({ width, height: 640 });
    await page.locator('#model-button').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.modelKey), 'codex:gpt-6.1-sol', 'opening focuses the current model');
    const menuBox = await modelMenu.boundingBox();
    assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= width, `the picker fits a ${width}px sidebar`);
    assert.equal(await modelMenu.evaluate(node => node.scrollWidth <= node.clientWidth), true, 'no sideways scrolling');
    const list = await page.locator('#model-options').boundingBox();
    const tuning = await page.locator('#inference-options').boundingBox();
    if (width === 450) assert.ok(tuning.x >= list.x + list.width - 1 && tuning.y < list.y + list.height, 'reasoning sits beside the models when there is room');
    else assert.ok(tuning.y >= list.y + list.height - 1, 'reasoning stacks below the models in a narrow sidebar');
    const attach = page.getByRole('button', { name: 'Attach files', exact: true });
    const plus = await attach.locator('svg').boundingBox();
    assert.ok(plus && plus.width >= 14 && plus.x + plus.width <= width, 'the attach plus stays visible');
    assert.equal(await attach.innerText(), '', 'the attach button has no visible caption');
    await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-model-picker-${width}.png` });
    // Typing on a model moves into search.
    await page.keyboard.type('lu');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'model-search');
    assert.equal(await page.locator('#model-search').inputValue(), 'lu');
    assert.deepEqual(await visibleModels(), ['GPT-6 Luna']);
    assert.equal(await page.locator('#model-results').textContent(), '1 model');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.modelKey), 'codex:gpt-6-luna', 'ArrowDown moves from search into results');
    await page.locator('#model-search').fill('nothing like this');
    assert.match(await page.locator('.model-empty').innerText(), /No models match/);
    await page.locator('#model-search').press('Escape');
    assert.equal(await modelMenu.isVisible(), true, 'the first Escape clears the search');
    assert.deepEqual(await visibleModels(), ['GPT-6.1 Sol', 'GPT-6 Luna']);
    await page.getByRole('button', { name: 'Claude', exact: true }).click();
    assert.equal(await page.locator('#provider-filter [aria-pressed="true"]').innerText(), 'Claude');
    assert.deepEqual(await visibleModels(), [], 'the filter shows only Claude');
    assert.equal(await page.getByRole('button', { name: 'Connect Claude', exact: true }).isVisible(), true, 'a disconnected provider offers a way to connect');
    await page.getByRole('button', { name: 'All', exact: true }).click();
    assert.deepEqual(await visibleModels(), ['GPT-6.1 Sol', 'GPT-6 Luna']);
    await page.keyboard.press('Escape');
    assert.equal(await modelMenu.isHidden(), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'model-button');
  }
  await page.locator('#model-button').click();
  assert.equal(await page.locator('#model-search').inputValue(), '', 'reopening starts from the full list');
  assert.equal(await page.locator('#provider-filter [aria-pressed="true"]').innerText(), 'All');
  await closeModelPicker.click();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 400, height: 850 });

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
  await choose('#reasoning-setting', 'Medium');
  await choose('#speed-setting', 'Fast');
  assert.equal(await page.locator('#model-menu').isVisible(), true, 'changing reasoning or speed keeps the picker open');
  assert.equal(await page.locator('#model-options').getByRole('button', { name: 'GPT-6.1 Sol', exact: true }).isVisible(), true, 'models and tuning share one surface');
  assert.equal(await page.locator('#inference-model').innerText(), 'GPT-6.1 Sol');
  assert.equal(await page.locator('#model-effort').innerText(), 'Medium, Fast');
  assert.equal(await page.locator('.suggestions').isVisible(), false, 'no clipped starter text behind the menu');
  await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-model-options.png` });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const optionsBounds = await page.locator('#inference-options').boundingBox();
  assert.ok(optionsBounds.x >= 0 && optionsBounds.x + optionsBounds.width <= 320 && optionsBounds.y >= 0 && optionsBounds.y + optionsBounds.height <= 640);
  captureChecks.push({ file: 'sidebar-model-options-narrow.png', ...await captureStablePanel(page, `${evidence}/sidebar-model-options-narrow.png`, { surfaceSelector: '#model-menu' }) });
  await page.setViewportSize({ width: 400, height: 850 });
  assert.match(await page.locator('#speed-note').innerText(), /more Codex allowance/);
  assert.equal(await page.locator('#notice').isVisible(), false, 'Speed guidance stays beside its setting');
  await closeModelPicker.press('Enter');
  assert.equal(await modelMenu.isHidden(), true, 'the close button also dismisses model settings');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'model-button');
  await page.locator('#model-button').click();
  await page.getByRole('button', { name: 'GPT-6 Luna', exact: true }).click();
  assert.equal(await page.locator('#model-label').innerText(), 'GPT-6 Luna');
  assert.equal(await checked('reasoning'), 'low');
  assert.equal(await checked('speed'), 'standard');
  assert.equal(await page.locator('input[name="speed"][value="fast"]').isDisabled(), true);
  assert.deepEqual(await page.locator('#reasoning-options input').evaluateAll(inputs => inputs.map(input => input.value)), ['low', 'medium'], 'reasoning lists only the levels the selected model reports');
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
    await page.waitForFunction(scheme => document.documentElement.dataset.scheme === scheme, scheme);
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
  assert.equal(await checked('reasoning'), 'medium');
  assert.equal(await checked('speed'), 'fast');
  await page.reload();
  await page.getByRole('button', { name: /GPT-6.1 Sol/ }).waitFor();
  assert.equal(await checked('reasoning'), 'medium');
  assert.equal(await checked('speed'), 'fast');
  assert.deepEqual(await page.evaluate(() => window.testStorage.local.breezerModelPreferences['codex:gpt-6.1-sol']), { reasoning: 'medium', speed: 'fast' });
  await page.evaluate(() => chrome.storage.local.set({ breezerModel: { provider: 'codex', model: 'gpt-6-luna' } }));
  await page.locator('#model-button').getByText('GPT-6 Luna', { exact: true }).waitFor();
  await page.evaluate(() => chrome.storage.local.set({ breezerModel: null }));
  await page.locator('#model-button').getByText('GPT-6.1 Sol', { exact: true }).waitFor();

  await page.getByLabel('Message Breezer').fill('Keep this reply running');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const modelRefreshes = () => page.evaluate(() => window.sent.filter(({ type }) => type === 'refresh-models').length);
  const initialDiscoveryCount = await modelRefreshes();
  await page.evaluate(async () => {
    window.testProviders[0].models.push({ id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' });
    await chrome.storage.local.set({ breezerModel: { provider: 'codex', model: 'gpt-6.1-terra' } });
  });
  assert.equal(await modelRefreshes(), initialDiscoveryCount);
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  await page.locator('#model-button').getByText('GPT-6.1 Terra', { exact: true }).waitFor();
  assert.equal(await modelRefreshes(), initialDiscoveryCount + 1);
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.evaluate(() => {
    window.testProviders[0].models.pop();
    return chrome.storage.local.set({ breezerModel: null });
  });
  await page.locator('#model-button').getByText('GPT-6.1 Sol', { exact: true }).waitFor();
  await openModelOptions();
  await page.evaluate(() => { window.testProviders[0].models[0].defaultReasoningEffort = 'high'; });
  await page.getByRole('button', { name: 'Refresh models', exact: true }).click();
  const defaultReasoning = page.locator('#reasoning-options label:has(small) input');
  await page.waitForFunction(() => document.querySelector('#reasoning-options label:has(small) input')?.value === 'high');
  assert.equal(await defaultReasoning.inputValue(), 'high');
  await page.getByRole('button', { name: 'Close model picker', exact: true }).click();

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
  assert.equal(await checked('reasoning'), 'high');
  await choose('#reasoning-setting', 'Low');
  await page.getByLabel('Message Breezer').fill('A Claude settings check');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const claudeChat = await page.evaluate(() => window.sent.filter(message => message.type === 'chat').at(-1));
  assert.equal(claudeChat.reasoning, 'low');
  assert.equal(Object.hasOwn(claudeChat, 'speed'), false);
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.locator('#model-button').click();
  await page.getByRole('button', { name: 'Claude Haiku', exact: true }).click();
  assert.equal(await page.locator('#reasoning-setting').evaluate(node => node.disabled), true);
  assert.equal(await page.locator('#reasoning-options').innerText(), 'Set by the model');
  assert.equal(await checked('reasoning'), '');
  await page.getByLabel('Message Breezer').fill('Use the CLI default');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const defaultChat = await page.evaluate(() => window.sent.filter(message => message.type === 'chat').at(-1));
  assert.equal(Object.hasOwn(defaultChat, 'reasoning'), false);
  assert.equal(Object.hasOwn(defaultChat, 'speed'), false);
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.locator('#model-button').click();
  await page.getByRole('button', { name: 'Claude Opus', exact: true }).click();
  assert.equal(await checked('reasoning'), 'low');
  await page.locator('#model-button').click();
  await page.getByRole('button', { name: 'GPT-6.1 Sol', exact: true }).click();
  await openModelOptions();
  assert.equal(await page.locator('#speed-setting').isVisible(), true);
  assert.equal(await checked('speed'), 'fast');
  await choose('#reasoning-setting', 'Extra high');
  await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-settings.png` });
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 320, height: 640 });
  await page.getByRole('button', { name: 'New conversation' }).click();
  const originalPrompt = 'Make this into a table\nKeep the examples.';
  await page.getByLabel('Message Breezer').fill(originalPrompt);
  await page.getByLabel('Message Breezer').press('Enter');
  await page.evaluate(async () => {
    const id = window.sent.filter(message => message.type === 'chat').at(-1).id;
    for (const text of [
      '### Short Story Versus Novel\n\n| Feature | Novel | Short story |\n| ---',
      ' | :---: | ---: |\n| **Plot** | Often has subplots | One plot |',
      '\n| Setting | Multiple places | Often one place |\n\nThe scope differs.',
    ]) {
      window.emit({ type: 'delta', id, text });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
  });
  const table = page.getByRole('table');
  assert.deepEqual(await table.getByRole('columnheader').allTextContents(), ['Feature', 'Novel', 'Short story']);
  assert.equal(await table.getByRole('row').count(), 3);
  assert.equal(await table.locator('strong').innerText(), 'Plot');
  assert.equal(await table.getByRole('cell', { name: 'One plot' }).evaluate(node => getComputedStyle(node).textAlign), 'right');
  assert.equal(await page.locator('#conversation').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.evaluate(() => window.emit({ type: 'complete', id: window.sent.filter(message => message.type === 'chat').at(-1).id }));
  await page.waitForFunction(() => window.testStorage.session['breezer-conversation-7']?.some(message => message.text.endsWith('The scope differs.')));
  await page.evaluate(() => sessionStorage.setItem('breezer-fixture-session', JSON.stringify(window.testStorage.session)));
  await page.reload();
  await table.waitFor();
  await page.evaluate(() => sessionStorage.removeItem('breezer-fixture-session'));
  assert.equal(await table.getByRole('row').count(), 3, 'completed tables render again from history');
  await page.getByLabel('Message Breezer').fill('Unsaved draft');
  const oldPrompt = page.locator('.message.user').first();
  const copyPrompt = oldPrompt.getByRole('button', { name: 'Copy prompt' });
  await copyPrompt.focus();
  assert.equal(await copyPrompt.innerText(), '');
  const copyPath = copyPrompt.locator('svg path');
  const copyGlyph = await copyPath.getAttribute('d');
  assert.ok(copyGlyph);
  await page.locator('#conversation').evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-table-and-copy.png` });
  await page.keyboard.press('Enter');
  await page.waitForFunction(text => window.copiedCommand === text, originalPrompt);
  assert.notEqual(await copyPath.getAttribute('d'), copyGlyph);
  assert.equal(await page.getByLabel('Message Breezer').inputValue(), 'Unsaved draft');
  assert.equal(await page.evaluate(() => window.sent.filter(message => message.type === 'chat').length), 0);
  const selectedPrompt = await copyPrompt.evaluate(async button => {
    const writeText = navigator.clipboard.writeText;
    navigator.clipboard.writeText = async () => { throw new Error('Clipboard access denied'); };
    button.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    navigator.clipboard.writeText = writeText;
    return window.getSelection().toString();
  });
  assert.equal(selectedPrompt, originalPrompt);
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.getByLabel('Message Breezer').fill('');
  await page.setViewportSize({ width: 400, height: 850 });

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
  for (const id of ['model-button', 'reasoning-setting', 'speed-setting']) assert.equal(await page.locator(`#${id}`).evaluate(node => node.disabled), true);
  await page.evaluate((id) => {
    window.emit({ type: 'delta', id, text: 'The page makes a simple point: **a browser should give you room to think**.\n\n- Keep the page at the centre.\n- Make useful actions easy to find.\n- Let people stay in control.\n\nThe strongest idea is to show the assistant only when you need a hand.' });
    window.emit({ type: 'complete', id });
  }, firstChat.id);
  await page.locator('.assistant .message-body strong').waitFor();
  assert.equal(await page.locator('.assistant .message-body li').count(), 3);
  assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isVisible(), true);
  for (const id of ['model-button', 'reasoning-setting', 'speed-setting']) assert.equal(await page.locator(`#${id}`).evaluate(node => node.disabled), false);
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
  await page.evaluate(id => window.emit({ type: 'error', id, source: 'browser-control', error: 'The page changed before Breezer could click.' }), failedControl.id);
  assert.equal(await page.locator('.assistant .message-body').last().innerText(), 'Browser control stopped.');
  await page.locator('.error-details summary').last().click();
  assert.equal(await page.getByText('The page changed before Breezer could click.', { exact: true }).isVisible(), true);
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
  assert.equal(await checked('reasoning'), 'xhigh');
  assert.equal(await checked('speed'), 'fast');
  await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-dark.png` });
  await page.evaluate(() => window.emit({ type: 'context', context: { title: 'New tab', url: 'chrome://newtab/' } }));
  assert.equal(await page.locator('#context-toggle').isDisabled(), true);
  assert.equal(await page.locator('#prompt').getAttribute('placeholder'), 'Ask anything…');
  assert.equal(await page.locator('#context-hint').innerText(), 'Chat without sharing this tab');
  assert.equal(await page.locator('#control-toggle').isDisabled(), true);
  assert.match(await page.locator('#welcome-status').innerText(), /Open a web page/);
  assert.equal(await page.locator('.suggestions').isHidden(), true, 'non-web pages omit unavailable page actions');
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

  // Attachments use actual browser File APIs and remain in follow-up history.
  await page.getByRole('button', { name: 'New conversation' }).click();
  await page.locator('#prompt').fill('');
  await page.locator('#context-toggle').click();
  await page.locator('#file-input').setInputFiles([
    { name: 'review.js', mimeType: 'text/javascript', buffer: Buffer.from('const answer = 42;') },
    { name: 'notes.csv', mimeType: 'text/csv', buffer: Buffer.from('item,count\napples,3') },
  ]);
  await page.getByRole('button', { name: 'Remove notes.csv' }).click();
  assert.equal(await page.locator('.attachment-chip').count(), 1);
  await page.locator('#file-input').setInputFiles({ name: 'document.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7') });
  await page.waitForFunction(() => document.getElementById('notice-text').textContent.includes('Export PDF'));
  assert.equal(await page.locator('.attachment-chip').count(), 1);
  await page.locator('#file-input').setInputFiles({ name: 'huge.txt', mimeType: 'text/plain', buffer: Buffer.from('x'.repeat(24001)) });
  await page.waitForFunction(() => document.getElementById('notice-text').textContent.includes('24,000'));
  const image = await page.locator('#attach-files').screenshot();
  await page.locator('#file-input').setInputFiles({ name: 'button.png', mimeType: 'image/png', buffer: image });
  await page.getByRole('button', { name: 'Remove button.png' }).waitFor();
  await page.setViewportSize({ width: 320, height: 850 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: `${evidence}/sidebar-files.png` });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('#send').click();
  const attachedChat = await page.evaluate(() => window.sent.filter(message => message.type === 'chat').at(-1));
  assert.equal(attachedChat.message, 'Review the attached files.');
  assert.equal(attachedChat.attachments[0].text, 'const answer = 42;');
  assert.match(attachedChat.attachments[1].image, /^data:image\/png;base64,/);
  assert.equal(await page.locator('#attach-files').isDisabled(), true);
  await page.evaluate(id => window.emit({ type: 'error', id, error: 'Synthetic file review failure' }), attachedChat.id);
  await page.getByRole('button', { name: 'Edit and resend' }).click();
  assert.equal(await page.locator('.attachment-chip').count(), 2);
  await page.getByRole('button', { name: 'Remove button.png' }).click();
  await page.locator('#send').click();
  const retriedChat = await page.evaluate(() => window.sent.filter(message => message.type === 'chat').at(-1));
  assert.equal(attachmentParts(retriedChat).some(part => part.type === 'image'), false, 'Removing a retry file removes it from the provider payload, including history');
  await page.evaluate(() => {
    const id = window.sent.filter(message => message.type === 'chat').at(-1).id;
    window.emit({ type: 'delta', id, text: 'The file defines answer as 42.' });
    window.emit({ type: 'complete', id });
  });
  await page.locator('#prompt').fill('What is the value?');
  await page.locator('#send').click();
  const followUp = await page.evaluate(() => window.sent.filter(message => message.type === 'chat').at(-1));
  assert.ok(followUp.history.some(message => message.attachments?.[0]?.text === 'const answer = 42;'));
  assert.equal(attachmentParts(followUp).some(part => part.type === 'image'), false, 'Removed retry files stay absent from later requests');
  await page.evaluate(id => window.emit({ type: 'complete', id }), followUp.id);
  await page.getByRole('button', { name: 'New conversation' }).click();
  assert.equal(await page.locator('.attachment-chip').count(), 0);
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['Dropped text'], 'dropped.txt', { type: 'text/plain' }));
    document.getElementById('composer').dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  });
  await page.getByRole('button', { name: 'Remove dropped.txt' }).click();
  assert.equal(await page.locator('.attachment-chip').count(), 0);

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
  await page.getByRole('button', { name: 'Write a draft', exact: true }).click();
  await page.getByLabel('Message Breezer').fill('Hello');
  await page.getByLabel('Message Breezer').press('Enter');
  assert.equal(await page.locator('#notice').isVisible(), false);
  assert.match(await page.locator('#welcome-status-text').innerText(), /Sign in to Codex or Claude/);
  assert.equal(await page.getByLabel('Message Breezer').inputValue(), 'Hello');
  assert.equal(await page.locator('#model-menu').isVisible(), true);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Hide draft', exact: true }).click();
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
  assert.equal(await page.locator('#prompt').isVisible(), false, 'the draft stays collapsed while signing in');
  await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-signed-out-instructions-narrow.png` });
  await page.getByRole('button', { name: 'Copy Codex sign-in command' }).click();
  await page.waitForFunction(() => window.copiedCommand === 'codex login');
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Clipboard unavailable'); }; });
  await page.getByRole('button', { name: 'Copy Claude sign-in command' }).click();
  await page.waitForFunction(() => window.getSelection().toString() === 'claude auth login');
  assert.match(await page.locator('.copy-feedback').innerText(), /keyboard to copy/);
  await page.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-command-copy-fallback-narrow.png` });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const sentRefreshes = await modelRefreshes();
  await page.getByRole('button', { name: 'Refresh accounts' }).click();
  assert.equal(await modelRefreshes(), sentRefreshes + 1);
  assert.deepEqual(errors, []);
  await writeFile(`${evidence}/panel-capture-geometry.json`, JSON.stringify(captureChecks, null, 2));
  const loading = await browser.newPage({ viewport: { width: 320, height: 640 } });
  await loading.addInitScript({ content: `(${installPanelFixture.toString()})({ contextDelay: 30_000 }); (${installPanelAreaEvents.toString()})();` });
  await loading.goto(`http://127.0.0.1:${server.address().port}/panel.html`);
  await loading.getByRole('button', { name: /GPT-6.1 Sol/ }).waitFor();
  assert.equal(await loading.locator('#context-toggle').isHidden(), true, 'unresolved page context has no sharing control');
  assert.equal(await loading.locator('#context-hint').innerText(), 'Loading current page…');
  await loading.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-page-loading-narrow.png` });
  await loading.evaluate(() => window.emit({ type: 'context', context: { title: 'Designing a calmer browser', url: 'https://example.com/design', tabId: 11 } }));
  assert.equal(await loading.locator('.context-row').isVisible(), true);
  assert.equal(await loading.locator('#context-hint').innerText(), 'Page + screenshot');
  await loading.close();
  const studio = await browser.newPage({ viewport: { width: 320, height: 720 }, reducedMotion: 'reduce' });
  await studio.addInitScript({ content: `(${installPanelFixture.toString()})(); (${installPanelAreaEvents.toString()})();` });
  await studio.goto(`http://127.0.0.1:${server.address().port}/panel.html`);
  await studio.evaluate(() => {
    chrome.breezerPrivate.authorizeCurrentPage = async () => { throw new Error('Browser tasks must not authorize a page'); };
    chrome.breezerPrivate.getResearchTabs = async () => [{ tabId: 11, documentId: 'source', title: 'A research source', url: 'https://example.com/source', loading: false }];
    chrome.breezerPrivate.readResearchTab = async () => { window.readSource = true; throw new Error('Browser tasks must not capture research sources'); };
    window.testAppearance = { theme: 'mint', colorMode: 'system', themeCanRestore: true };
    chrome.breezerPrivate.getAppearance = async () => window.testAppearance;
    chrome.breezerPrivate.setAppearance = async ({ expectedThemeState, ...patch }) => {
      if (expectedThemeState?.theme !== window.testAppearance.theme || expectedThemeState?.colorMode !== window.testAppearance.colorMode) {
        throw new Error('Browser appearance changed. Try again.');
      }
      return (window.testAppearance = { ...window.testAppearance, ...patch });
    };
  });
  await studio.getByRole('button', { name: /GPT-6.1 Sol/ }).waitFor();
  await studio.getByRole('button', { name: 'Browser tools' }).click();
  await studio.screenshot({ path: `${evidence}/sidebar-browser-tools.png` });
  await studio.getByRole('button', { name: 'Close browser tools' }).click();
  await studio.getByLabel('Message Breezer').fill('What browser tabs are open and which one uses the most RAM?');
  await studio.getByRole('button', { name: 'Clear Browser stats' }).waitFor();
  await studio.getByRole('button', { name: 'Clear Browser stats' }).click();
  assert.equal(await studio.locator('#context-toggle').isVisible(), true, 'dismissing inferred stats restores the ordinary composer');
  await studio.getByLabel('Message Breezer').fill('');
  await studio.getByLabel('Message Breezer').fill('What browser tabs are open and which one uses the most RAM?');
  await studio.getByRole('button', { name: 'Clear Browser stats' }).waitFor();
  await studio.getByRole('button', { name: 'Send message', exact: true }).click();
  const statsChat = await studio.evaluate(() => window.sent.findLast(message => message.type === 'chat'));
  assert.equal(statsChat.browserTask, 'stats');
  assert.equal(statsChat.includeContext, false);
  assert.equal(statsChat.control, false);
  await studio.evaluate(id => {
    window.emit({ type: 'browser-stats', id, stats: {
      windowTabCount: 3, totalTabCount: 4,
      browserMemory: { footprintBytes: 512 * 1024 ** 2, sampleComplete: true },
      systemMemory: { availableBytes: 2 * 1024 ** 3, totalBytes: 8 * 1024 ** 3 },
    } });
  }, statsChat.id);
  const stats = studio.locator('.browser-stats');
  assert.deepEqual(await stats.locator('dt').allTextContents(), ['Tabs in this window', 'Tabs in all regular windows', 'Breezer memory', 'System RAM available']);
  assert.deepEqual(await stats.locator('dd').allTextContents(), ['3', '4', '512 MiB', '2 GiB of 8 GiB']);
  await studio.screenshot({ animations: 'disabled', path: `${evidence}/sidebar-measured-browser-stats.png` });
  await studio.evaluate(id => {
    window.emit({ type: 'delta', id, text: 'The 3 tabs in this window use two renderer processes.' });
    window.emit({ type: 'complete', id });
  }, statsChat.id);
  await studio.getByText('The 3 tabs in this window', { exact: false }).waitFor();
  const ordinaryPaste = await studio.evaluate(async () => {
    const prompt = document.getElementById('prompt');
    const text = new DataTransfer();
    text.setData('text/plain', 'Ordinary pasted text');
    const ordinary = prompt.dispatchEvent(new ClipboardEvent('paste', { clipboardData: text, bubbles: true, cancelable: true }));
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 96;
    const drawing = canvas.getContext('2d');
    drawing.fillStyle = '#273e66';
    drawing.fillRect(0, 0, 160, 96);
    drawing.fillStyle = '#ecf1df';
    drawing.beginPath();
    drawing.arc(116, 31, 9, 0, Math.PI * 2);
    drawing.fill();
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([blob], 'Night sky.png', { type: 'image/png' }));
    prompt.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
    return ordinary;
  });
  assert.equal(ordinaryPaste, true, 'plain text paste keeps normal textarea behavior');
  await studio.getByRole('button', { name: 'Remove Night sky.png' }).waitFor();
  await studio.getByLabel('Message Breezer').fill('Use this image as my New Tab background and make a theme from it.');
  await studio.getByRole('button', { name: 'Clear Theme design' }).waitFor();
  await studio.getByRole('button', { name: 'Send message', exact: true }).click();
  const themeChat = await studio.evaluate(() => window.sent.findLast(message => message.type === 'chat'));
  assert.equal(themeChat.browserTask, 'theme');
  assert.equal(themeChat.includeContext, false);
  assert.equal(themeChat.control, false);
  assert.match(themeChat.attachments[0].image, /^data:image\/png;base64,/);
  await studio.evaluate(id => {
    window.emit({ type: 'complete', id, themeProposal: {
      name: 'Moonlit sky', theme: '#273e66', colorMode: 'dark',
      imageAttachment: 1,
      html: '<div style="height:100vh;background:radial-gradient(circle at 30% 25%,#ecf1df 0 1px,transparent 2px)"></div>',
    } });
  }, themeChat.id);
  await studio.getByText('Moonlit sky', { exact: true }).waitFor();
  assert.equal(await studio.locator('.assistant iframe').count(), 1, 'the completed theme appears as a live preview');
  assert.equal(await studio.locator('.assistant iframe').getAttribute('sandbox'), '');
  assert.equal(await studio.locator('.assistant img[src^="data:image/png;"]').count(), 1, 'the completed theme previews the attached photo');
  await studio.screenshot({ path: `${evidence}/sidebar-theme-preview.png` });
  assert.equal(await studio.evaluate(() => window.testAppearance.theme), 'mint', 'preview leaves the active theme alone');
  await studio.getByRole('button', { name: 'Apply theme', exact: true }).click();
  await studio.waitForFunction(() => window.testAppearance.theme === '#273e66');
  await studio.getByLabel('Message Breezer').fill('Make it a little darker.');
  await studio.getByRole('button', { name: 'Clear Theme design' }).waitFor();
  await studio.getByRole('button', { name: 'Send message', exact: true }).click();
  const revision = await studio.evaluate(() => window.sent.findLast(message => message.type === 'chat'));
  assert.match(revision.history.at(-1).content, /Previous theme proposal[^\n]*\nMoonlit sky/);
  await studio.evaluate(id => window.emit({ type: 'error', id, error: 'Fixture failure' }), revision.id);
  await studio.getByRole('button', { name: 'Choose source tabs' }).click();
  await studio.getByRole('checkbox', { name: /A research source/ }).check();
  await studio.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await studio.locator('#research-chips button').count(), 1);
  await studio.getByRole('button', { name: 'Edit and resend' }).click();
  assert.equal(await studio.locator('#research-chips button').count(), 0, 'browser task retry clears research sources');
  await studio.getByRole('button', { name: 'Send message', exact: true }).click();
  const retried = await studio.evaluate(() => window.sent.findLast(message => message.type === 'chat'));
  assert.equal(retried.browserTask, 'theme');
  assert.equal(retried.researchSources, undefined);
  assert.equal(await studio.evaluate(() => window.readSource), undefined);
  await studio.evaluate(id => {
    window.emit({ type: 'delta', id, text: 'The image has a cool palette.' });
    window.emit({ type: 'complete', id });
  }, retried.id);
  await studio.getByLabel('Message Breezer').fill('Use this as my background.');
  assert.equal(await studio.locator('#browser-task-clear').isVisible(), true);
  assert.equal(await studio.locator('#context-toggle').isHidden(), true);
  await studio.getByRole('button', { name: 'Send message', exact: true }).click();
  const wallpaper = await studio.evaluate(() => window.sent.findLast(message => message.type === 'chat'));
  assert.equal(wallpaper.browserTask, 'theme');
  assert.equal(wallpaper.includeContext, false);
  assert.equal(wallpaper.attachments.length, 0);
  assert.ok(wallpaper.history.some(message => message.attachments?.some(file => file.image === themeChat.attachments[0].image)));
  await studio.getByRole('button', { name: 'New conversation' }).click();
  await studio.getByRole('button', { name: 'Browser tools' }).click();
  await studio.getByRole('dialog', { name: 'Browser tools' }).getByRole('button', { name: 'Restore previous look' }).click();
  await studio.waitForFunction(() => window.testAppearance.theme === 'mint');
  await studio.getByRole('button', { name: 'Close browser tools' }).click();
  await studio.getByLabel('Message Breezer').fill('Make my browser dark purple');
  await studio.getByRole('button', { name: 'Clear Theme design' }).waitFor();
  await studio.getByRole('button', { name: 'Send message', exact: true }).click();
  const resumed = await studio.evaluate(() => window.sent.findLast(message => message.type === 'chat'));
  await studio.locator('#close-panel').click();
  assert.equal(await studio.evaluate(id => window.sent.some(message => message.type === 'cancel' && message.id === id), resumed.id), false);
  await studio.reload();
  await studio.getByRole('button', { name: /GPT-6.1 Sol/ }).waitFor();
  await studio.evaluate(({ id, message, browserTask }) => window.emit({
    type: 'turn-state', id, user: { id, role: 'user', text: message }, text: 'A dark purple', browserTask,
  }), resumed);
  await studio.getByText('A dark purple', { exact: true }).waitFor();
  await studio.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
  await studio.evaluate(id => {
    window.emit({ type: 'delta', id, text: ' palette.' });
    window.emit({ type: 'complete', id, themeProposal: { name: 'Blackberry', theme: '#39255a', colorMode: 'dark' } });
  }, resumed.id);
  await studio.getByText('A dark purple palette.', { exact: true }).waitFor();
  await studio.getByText('Blackberry', { exact: true }).waitFor();
  await studio.waitForFunction(id => window.sent.some(message => message.type === 'turn-saved' && message.id === id), resumed.id);
  await studio.close();
  const draft = await browser.newPage({ viewport: { width: 380, height: 680 }, colorScheme: 'dark' });
  const draftOrigin = `http://127.0.0.1:${server.address().port}`;
  await draft.addInitScript({ content: `
    (${installPanelFixture})(); (${installPanelAreaEvents})();
    chrome.tabs = { getCurrent: async () => ({ id: 11, windowId: 7 }), query: async () => [{ id: 11, incognito: false }] };
    Object.assign(testStorage.session, {
      'breezer-conversation-7': [{ id: 'sidebar-user', role: 'user', text: 'Existing sidebar conversation' }],
      'breezer-handoff-7': { source: 'newtab', prompt: 'Legacy handoff', tabId: 11, createdAt: Date.now() },
      'breezer-full-conversation-tab-12': [{ id: 'other-user', role: 'user', text: 'A different full chat' }],
    });
    testStorage.local.breezerExperiments = { newTabComposer: true, personality: 'warm' };
    chrome.storage.session.remove = async key => { delete testStorage.session[key]; };
    if (sessionStorage.getItem('draft-no-model')) testProviders[0].authenticated = false;
  ` });
  await draft.goto(draftOrigin + '/panel.html');
  await draft.getByRole('button', { name: /GPT-6.1 Sol/ }).waitFor();
  assert.equal(await draft.locator('#prompt').inputValue(), '');
  assert.equal(await draft.evaluate(() => sent.some(message => message.type === 'chat')), false);
  assert.ok(await draft.evaluate(() => testStorage.session['breezer-handoff-7']), 'the sidebar leaves legacy drafts alone');
  await draft.evaluate(() => {
    sessionStorage.setItem('breezer-handoff-11', JSON.stringify({ prompt: 'What should I read next?', createdAt: Date.now() }));
    sessionStorage.setItem('draft-no-model', 'true');
  });
  await draft.reload();
  await draft.getByText('Existing sidebar conversation', { exact: true }).waitFor();
  assert.equal(await draft.locator('#prompt').inputValue(), '');
  assert.equal(await draft.evaluate(() => sent.some(message => message.type === 'chat')), false, 'the sidebar ignores both handoff stores');
  await draft.goto(draftOrigin + '/panel.html?view=chat');
  await draft.waitForFunction(() => document.querySelector('#prompt').value === 'What should I read next?');
  await draft.waitForFunction(() => document.querySelector('.panel').dataset.accountState === 'signed-out');
  assert.equal(await draft.evaluate(() => sent.some(message => message.type === 'chat')), false);
  assert.equal(await draft.locator('#prompt').isVisible(), true);
  assert.equal(await draft.locator('#send').isDisabled(), true);
  assert.equal(await draft.getByText('Existing sidebar conversation', { exact: true }).count(), 0);
  assert.equal(await draft.getByText('A different full chat', { exact: true }).count(), 0);
  await draft.locator('#prompt').fill('What short story should I read next?');
  await draft.evaluate(() => sessionStorage.removeItem('draft-no-model'));
  await draft.reload();
  await draft.getByRole('button', { name: /GPT-6.1 Sol/ }).waitFor();
  assert.equal(await draft.locator('#prompt').inputValue(), 'What short story should I read next?');
  assert.equal(await draft.evaluate(() => sent.some(message => message.type === 'chat')), false, 'an edited draft requires Send');
  await draft.locator('#send').click();
  const handedOff = await draft.evaluate(() => sent.find(message => message.type === 'chat'));
  assert.equal(handedOff.message, 'What short story should I read next?');
  assert.equal(handedOff.includeContext, false);
  assert.equal(handedOff.control, false);
  assert.equal(await draft.evaluate(() => sessionStorage.getItem('breezer-handoff-11')), null);
  assert.equal(await draft.locator('.context-row').isHidden(), true);
  await draft.evaluate(id => {
    emit({ type: 'delta', id, text: 'Start with a short story tonight. Pick a book you can finish in one sitting.' });
    emit({ type: 'complete', id });
  }, handedOff.id);
  await draft.getByText('Start with a short story tonight.', { exact: false }).waitFor();
  await draft.waitForFunction(() => testStorage.session['breezer-full-conversation-tab-11']?.length === 2);
  await draft.screenshot({ animations: 'disabled', path: `${evidence}/experimental-ask-chat.png` });
  await draft.close();

  const pdf = await browser.newPage({ viewport: { width: 360, height: 650 } });
  await pdf.addInitScript({ content: `
    (${installPanelFixture})(); (${installPanelAreaEvents})();
    chrome.breezerPrivate.isCurrentPdf = async tabId => tabId === 11;
    chrome.breezerPrivate.captureCurrentPdfContext = async () => ({isPdf:true,imageDataUrl:'data:image/jpeg;base64,AA=='});
  ` });
  await pdf.goto(`http://127.0.0.1:${server.address().port}/panel.html`);
  await pdf.getByRole('button', { name: 'PDF view', exact: false }).waitFor();
  assert.equal(await pdf.locator('#control-toggle').isDisabled(), true);
  await pdf.getByLabel('Message Breezer').fill('What is stated on the visible PDF page?');
  await pdf.getByRole('button', { name: 'Send message', exact: true }).click();
  await pdf.waitForFunction(() => sent.some(message => message.type === 'chat'));
  const pdfRequest = await pdf.evaluate(() => sent.find(message => message.type === 'chat'));
  assert.equal(pdfRequest.pdfView, 'data:image/jpeg;base64,AA==');
  assert.equal(pdfRequest.contextTitle, 'Current PDF');
  assert.equal(pdfRequest.control, false);
  assert.equal(pdfRequest.includeContext, true);
  await pdf.close();
  const opening = await browser.newPage();
  await opening.addInitScript({ content: `
    (${installPanelFixture})();
    (${installPanelAreaEvents})();
    const next = new URLSearchParams(location.search).get('choice');
    window.testStorage.local.breezerModel = { provider: 'codex', model: next ? 'gpt-6.1-sol' : 'gpt-6-luna' };
    chrome.windows.getCurrent = () => new Promise(resolve => { window.finishOpening = () => resolve({ id: 7 }); });
  ` });
  for (const [choice, expected] of [['gpt-6-luna', 'GPT-6 Luna'], ['', 'GPT-6.1 Sol']]) {
    await opening.goto(`http://127.0.0.1:${server.address().port}/panel.html?choice=${choice}`);
    await opening.waitForFunction(() => typeof window.finishOpening === 'function');
    await opening.evaluate(async choice => {
      await chrome.storage.local.set({ breezerModel: choice ? { provider: 'codex', model: choice } : null });
      window.finishOpening();
    }, choice);
    await opening.locator('#model-button').getByText(expected, { exact: true }).waitFor();
  }
  await opening.close();

  const visuals = await browser.newPage({ viewport: { width: 320, height: 750 } });
  await visuals.addInitScript({ content: '(' + installPanelFixture + ')(); (' + installPanelAreaEvents + ')();' });
  let mapRequests = 0;
  await visuals.route('https://www.openstreetmap.org/**', route => {
    mapRequests++;
    assert.equal(new URL(route.request().url()).searchParams.get('marker'), '38.6916,-9.216');
    return route.fulfill({ body: '<p>Map fixture</p>', contentType: 'text/html' });
  });
  const fixtureOrigin = new URL(page.url()).origin;
  await visuals.goto(fixtureOrigin + '/panel.html');
  await visuals.getByRole('button', { name: /GPT-6.1 Sol/ }).waitFor();
  await visuals.getByLabel('Message Breezer').fill('Create an image of a blue pear');
  await visuals.getByRole('button', { name: 'Send message', exact: true }).click();
  const imageTask = await visuals.evaluate(() => sent.find(message => message.type === 'chat'));
  assert.equal(imageTask.browserTask, 'image');
  assert.equal(imageTask.includeContext, false);
  assert.deepEqual(imageTask.history, []);
  const imageSample = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
  await visuals.evaluate(({ id, image }) => emit({ type: 'complete', id, generatedImage: image }), { id: imageTask.id, image: imageSample });
  await visuals.getByRole('link', { name: 'Save image' }).waitFor();
  assert.equal(await visuals.getByRole('link', { name: 'Save image' }).getAttribute('download'), 'breezer-image.webp');
  await visuals.waitForFunction(() => testStorage.session['breezer-conversation-7']?.some(message => message.generatedImage));
  await visuals.getByLabel('Message Breezer').fill('Show the trip as a flow, chart, map, and cards.');
  await visuals.getByRole('button', { name: 'Send message', exact: true }).click();
  const visualId = await visuals.evaluate(() => sent.filter(message => message.type === 'chat').at(-1).id);
  const widgets = [
    { type: 'flow', title: 'Weekend plan', nodes: [{id:'a', label:'Pack'}, {id:'b', label:'Train'}, {id:'c', label:'Bus'}],
      edges: [{from:'a',to:'b',label:'Quickest'}, {from:'a',to:'c'}, {from:'c',to:'a',label:'Return'}] },
    { type: 'chart', title: 'Travel time', unit: 'min', items: [{ label:'Train', value:25 },{label:'Bus',value:40}] },
    { type: 'map', title: 'Belém Tower', lat:38.6916, lon:-9.216, zoom:15 },
    { type: 'cards', title: 'Travel tips', items: [{label:'Pack light',detail:'Bring water.'}] },
    { type: 'map', title: 'Invalid coordinates', lat:120, lon:180 },
  ];
  const fence = String.fromCharCode(96).repeat(3);
  const blocks = widgets.map(widget => fence + 'breezer\n' + JSON.stringify(widget) + '\n' + fence).join('\n\n');
  await visuals.evaluate(({ id, blocks }) => emit({ type: 'delta', id, text: 'A short trip.\n\n' + blocks }), { id: visualId, blocks });
  await visuals.getByText('A short trip.').waitFor();
  assert.equal(await visuals.locator('.reply-widget figcaption').getByText('Weekend plan').count(), 0, 'render validated widgets only after the reply completes');
  await visuals.evaluate(id => emit({ type: 'complete', id }), visualId);
  await visuals.locator('.reply-flow').waitFor();
  assert.equal(await visuals.locator('.reply-flow-node').count(), 3);
  assert.equal(await visuals.locator('.reply-flow-edge').count(), 3);
  const fills = await visuals.evaluate(() => {
    const node = document.querySelector('.reply-flow-node');
    const old = getComputedStyle(node).fill;
    document.documentElement.dataset.tone = 'rose';
    document.documentElement.dataset.scheme = 'dark';
    return [old, getComputedStyle(node).fill];
  });
  assert.notEqual(...fills, 'diagram nodes follow live theme changes');
  assert.equal(await visuals.locator('.reply-chart-bar').count(), 2);
  assert.equal(await visuals.locator('.reply-widget iframe').count(), 0);
  assert.equal(mapRequests, 0, 'generated maps never contact the provider before opening');
  await visuals.getByRole('button', { name: 'Load interactive map' }).click();
  await visuals.frameLocator('.reply-widget iframe').getByText('Map fixture').waitFor();
  assert.equal(mapRequests, 1);
  await visuals.getByRole('button', { name: 'Hide map' }).click();
  assert.equal(await visuals.locator('.reply-widget iframe').count(), 0);
  await visuals.locator('summary').getByText('Pack light', { exact: true }).click();
  assert.equal(await visuals.getByText('Bring water.', { exact:true }).isVisible(), true);
  assert.equal(await visuals.locator('.reply-widget figcaption').getByText('Invalid coordinates').count(), 0);
  assert.equal(await visuals.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await visuals.locator('.reply-flow').scrollIntoViewIfNeeded();
  await visuals.screenshot({ animations: 'disabled', path: evidence + '/sidebar-visual-replies.png' });
  await visuals.close();

  const full = await browser.newPage({ viewport: { width: 1050, height: 800 } });
  await full.addInitScript({ content: `
    (${installPanelFixture})(); (${installPanelAreaEvents})();
    chrome.tabs = { getCurrent: async () => ({ id: 11, windowId: 7 }) };
    testProviders[1].authenticated = true;
    testProviders[1].models = [{id:'claude-opus-5-5', label:'Claude Opus 5.5', reasoningEfforts:['medium']}];
    testStorage.local.breezerModel = { provider: 'claude', model: 'claude-opus-5-5' };
  ` });
  await full.goto(fixtureOrigin + '/panel.html?view=chat');
  await full.locator('#model-button').getByText('Claude Opus 5.5', { exact: true }).waitFor();
  assert.equal(await full.locator('#research-open').isVisible(), false);
  await full.getByLabel('Message Breezer').fill('Compare the options');
  await full.getByRole('button', { name: 'Send message', exact: true }).click();
  await full.locator('#activity-label').getByText('Finding a tailwind…').waitFor();
  const fullRequest = await full.evaluate(() => sent.find(message => message.type === 'chat'));
  assert.equal(fullRequest.provider, 'claude');
  assert.equal(fullRequest.includeContext, false);
  await full.evaluate(({ id, blocks }) => emit({ type: 'delta', id, text: blocks }), { id: fullRequest.id, blocks });
  await full.locator('#activity-label').getByText('Writing…').waitFor();
  await full.evaluate(id => emit({ type: 'complete', id }), fullRequest.id);
  assert.equal(await full.locator('.reply-flow-node').count(), 3);
  const [conversation, composer] = await Promise.all([full.locator('#messages').boundingBox(), full.locator('.compose-area').boundingBox()]);
  assert.ok(Math.abs((conversation.x + conversation.width / 2) - (composer.x + composer.width / 2)) < 3, 'conversation and composer align');
  await full.waitForFunction(() => testStorage.session['breezer-full-conversation-tab-11']?.length === 2);
  await full.locator('.reply-flow').scrollIntoViewIfNeeded();
  await full.screenshot({ animations: 'disabled', path: evidence + '/full-chat-visual-replies.png' });
  await full.close();

  console.log('PASS: file picker, drop, removal, unsupported/oversize errors, image decoding, attachment-only send, retry restoration and follow-up history; real-browser sidebar rendering, profile, model/reasoning/speed selection and persistence, provider capability changes, chat settings/context, streaming Markdown, Enter/Shift+Enter, keyboard model menu, per-tab control consent across replies, control/cancel, Edit and resend without automatic retry, page and control status, signed-out and no-page empty states, injection safety, narrow, dark and reduced-motion layouts.');
  console.log(`Screenshots: ${evidence}`);
} finally {
  try { await browser?.close(); } finally {
    await new Promise(done => server.close(done));
  }
}
