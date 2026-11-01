// Trusted browser input against real DOM. No injected replacement Enter handler.
// Use --baseline on stock Chrome; omit it for compiled Breezer acceptance.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || '../ai/node_modules/playwright/index.mjs');
const baseline = process.argv.includes('--baseline');
const fixture = await readFile(new URL('./enter.html', import.meta.url), 'utf8');
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(fixture); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined) });
let passed = 0;
try {
  let page;
  const reset = async extra => {
    if (page) await page.close();
    page = await browser.newPage();
    await page.goto(origin);
    if (extra) await page.evaluate(extra);
    await page.locator('#username').fill('dummy@example.test');
    await page.locator('#password').fill('dummy-only');
  };
  const count = () => page.evaluate(() => window.submissions);
  const focused = () => page.evaluate(() => document.activeElement.id);
  const check = async (name, fn) => { await reset(); await fn(); passed++; console.log(`PASS ${name}`); };
  await check('annotated no-button username advances to password', async () => {
    await page.locator('#username').press('Enter');
    assert.equal(await focused(), baseline ? 'username' : 'password');
  });
  await check('annotated no-button final password submits once', async () => {
    await page.locator('#password').press('Enter');
    assert.equal(await count(), baseline ? 0 : 1);
    if (process.env.BREEZER_ENTER_EVIDENCE) {
      await mkdir(process.env.BREEZER_ENTER_EVIDENCE, { recursive: true });
      await page.screenshot({ path: `${process.env.BREEZER_ENTER_EVIDENCE}/login-enter.png` });
    }
  });
  await check('native submit-button form submits once', async () => {
    await page.evaluate(() => login.insertAdjacentHTML('beforeend', '<button>Sign in</button>'));
    await page.locator('#password').press('Enter'); assert.equal(await count(), 1);
  });
  await check('native username Enter submits a complete form once', async () => {
    await page.evaluate(() => login.insertAdjacentHTML('beforeend', '<button>Sign in</button>'));
    await page.locator('#username').press('Enter'); assert.equal(await count(), 1);
  });
  await check('native validation focuses missing password', async () => {
    await page.evaluate(() => login.insertAdjacentHTML('beforeend', '<button>Sign in</button>'));
    await page.locator('#password').fill(''); await page.locator('#username').press('Enter');
    assert.equal(await count(), 0); assert.equal(await focused(), 'password');
  });
  for (const [name, markup] of [
    ['disabled submit', '<button disabled>Sign in</button>'],
    ['custom next step', '<button type="button">Next</button>'],
    ['MFA', '<input autocomplete="one-time-code" required>'],
    ['consent', '<input type="checkbox" required>'],
    ['textarea', '<textarea></textarea>'],
  ]) await check(name, async () => {
    await page.evaluate(markup => login.insertAdjacentHTML('beforeend', markup), markup);
    await page.locator('#password').press('Enter'); assert.equal(await count(), 0);
  });
  await check('empty password never submits', async () => {
    await page.locator('#password').fill(''); await page.locator('#password').press('Enter'); assert.equal(await count(), 0);
  });
  await check('invalid username never submits', async () => {
    await page.evaluate(() => username.type = 'email'); await page.locator('#username').fill('invalid');
    await page.locator('#password').press('Enter'); assert.equal(await count(), 0);
  });
  await check('site cancellation takes precedence', async () => {
    await page.evaluate(() => login.addEventListener('keydown', e => e.preventDefault()));
    await page.locator('#username').press('Enter'); assert.equal(await focused(), 'username'); assert.equal(await count(), 0);
  });
  await check('form ownership rather than nearest ancestor', async () => {
    await page.evaluate(() => {
      login.insertAdjacentHTML('afterend', '<form id="other"><input id="other-user" autocomplete="username"><input type="password" autocomplete="current-password"></form>');
      password.setAttribute('form', 'other');
    });
    await page.locator('#username').press('Enter');
    assert.notEqual(await focused(), 'password');
  });
  await check('canceled native submit-button click is not retried', async () => {
    await page.evaluate(() => {
      login.insertAdjacentHTML('beforeend', '<button id="sign-in">Sign in</button>');
      document.getElementById('sign-in').addEventListener('click', e => e.preventDefault());
    });
    await page.locator('#password').press('Enter'); assert.equal(await count(), 0);
  });
  await check('multi-step native username Next stays native', async () => {
    await page.evaluate(() => {
      password.remove(); login.insertAdjacentHTML('beforeend', '<button>Next</button>');
      login.addEventListener('submit', e => { e.preventDefault(); login.innerHTML = '<label>Code <input id="code" autocomplete="one-time-code"></label><button>Verify</button>'; });
    });
    await page.locator('#username').press('Enter'); assert.equal(await count(), 1); assert.equal(await page.locator('#code').count(), 1);
  });
  await check('synthetic Enter does not trigger fallback', async () => {
    await page.locator('#password').focus();
    await page.evaluate(() => password.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', charCode: 13, bubbles: true })));
    assert.equal(await count(), 0);
  });
  await check('multiple forms stay isolated', async () => {
    await page.evaluate(() => login.insertAdjacentHTML('afterend', '<form id="other"><input autocomplete="username"><input type="password" autocomplete="current-password"><button>Other sign in</button></form>'));
    await page.locator('#password').press('Enter'); assert.equal(await count(), baseline ? 0 : 1);
  });
  for (const [name, edit] of [
    ['unannotated login', () => username.removeAttribute('autocomplete')],
    ['new-password registration', () => password.autocomplete = 'new-password'],
    ['read-only field', () => username.readOnly = true],
    ['hidden password', () => password.style.display = 'none'],
    ['GET form', () => login.method = 'get'],
    ['novalidate form', () => login.noValidate = true],
  ]) await check(name, async () => {
    await page.evaluate(edit);
    await page.locator('#username').press('Enter');
    assert.equal(await focused(), 'username'); assert.equal(await count(), 0);
  });
  await check('site custom validity is preserved', async () => {
    await page.evaluate(() => password.setCustomValidity('Dummy site validation'));
    await page.locator('#password').press('Enter'); assert.equal(await count(), 0);
  });
  await check('modifier Enter does not trigger fallback', async () => {
    await page.locator('#password').press('Shift+Enter'); assert.equal(await count(), 0);
  });
  await check('held Enter cannot advance then immediately submit', async () => {
    await page.locator('#username').focus();
    await page.keyboard.down('Enter'); await page.keyboard.down('Enter'); await page.keyboard.up('Enter');
    assert.equal(await count(), 0);
  });
  await check('change handler removal aborts the fallback', async () => {
    await page.locator('#password').focus(); await page.keyboard.type('x');
    await page.evaluate(() => password.addEventListener('change', () => login.remove()));
    await page.locator('#password').press('Enter'); assert.equal(await count(), 0);
  });
  await check('first Enter belongs to an open site picker', async () => {
    // Site picker fixture only. Native saved-password picker acceptance is separate.
    await page.evaluate(() => {
      window.pickerOpen = true;
      username.addEventListener('keydown', e => {
        if (e.key === 'Enter' && window.pickerOpen) { e.preventDefault(); window.pickerOpen = false; }
      });
    });
    await page.locator('#username').press('Enter');
    assert.equal(await focused(), 'username'); assert.equal(await count(), 0);
    assert.equal(await page.evaluate(() => window.pickerOpen), false);
    await page.locator('#username').press('Enter');
    assert.equal(await focused(), baseline ? 'username' : 'password');
  });
  await check('textarea and contenteditable Enter remain editing', async () => {
    await page.evaluate(() => login.insertAdjacentHTML('afterend', '<textarea id="notes"></textarea><div id="editor" contenteditable="true"></div>'));
    await page.locator('#notes').fill('note'); await page.locator('#notes').press('Enter');
    assert.equal(await page.locator('#notes').inputValue(), 'note\n');
    await page.locator('#editor').fill('text'); await page.locator('#editor').press('Enter');
    assert.equal(await count(), 0);
  });
  for (const host of ['127.0.0.1', 'localhost']) await check(`frame-local login on ${host}`, async () => {
    await page.evaluate(url => { const frame = document.createElement('iframe'); frame.src = url; document.body.append(frame); }, origin.replace('127.0.0.1', host));
    const frame = page.frameLocator('iframe');
    await frame.locator('#username').fill('dummy@example.test'); await frame.locator('#password').fill('dummy-only');
    await frame.locator('#password').press('Enter');
    assert.equal(await frame.locator('#status').innerText(), baseline ? 'Ready' : 'Submitted 1 time(s)');
    assert.equal(await count(), 0);
  });
  console.log(`PASS ${passed} real-page scenarios (${baseline ? 'stock browser baseline; enhancement absent' : 'compiled browser acceptance'})`);
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
