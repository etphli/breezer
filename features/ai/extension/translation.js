import { PROVIDERS } from './translation-provider.js';
import { startPanelTheme } from './panel-theme.js';

const api = chrome;
const $ = id => document.getElementById(id);
void startPanelTheme({ api });
const port = api.runtime.connect({ name: 'breezer-translation-ui' });
// MV3 ports alone do not retain a worker. Keep restore/new-text controls alive
// only for the lifetime of this visible translation window, with no network I/O.
const heartbeat = setInterval(() => { try { port.postMessage({ type: 'ping' }); } catch {} }, 20000);
addEventListener('pagehide', () => { clearInterval(heartbeat); clearInterval(retryTicker); port.disconnect(); }, { once: true });
let prefs, ready = false, running = false, connected = true, languages = [], translatedTotal = 0, retryAt = 0, retryTicker, recovery = false;
const status = (message, state = '') => {
  $('status').textContent = message;
  $('status').dataset.state = state;
  $('translate').dataset.recovery = String(state === 'error');
};
function controls() {
  const remaining = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
  $('translate').disabled = !connected || !ready || running || remaining > 0 || !$('consent').checked || !$('target').value || $('source').value === $('target').value;
  $('translate').textContent = remaining ? `Retry in ${remaining}s` : recovery ? 'Retry translation' : 'Translate page';
  $('translate').hidden = running;
  $('cancel').disabled = !running;
  $('cancel').hidden = !running;
  $('cancel').classList.toggle('primary', running);
  $('restore').disabled = !connected || translatedTotal === 0;
  $('restore').hidden = translatedTotal === 0;
  $('languages').disabled = !connected || !prefs || running || remaining > 0;
  $('source').disabled = $('target').disabled = !ready || running;
  $('dynamic').disabled = $('consent').disabled = running;
  $('languages').textContent = ready ? 'Reload languages' : 'Connect and load languages';
  $('languages').classList.toggle('reload', ready);
  $('setup-help').hidden = ready;
}
function readinessStatus() {
  if (!connected || !ready || running || Date.now() < retryAt) return;
  const target = $('target').value;
  status(!target || $('source').value === target ? 'Choose different source and target languages.'
    : $('consent').checked ? 'Ready to translate.' : 'Confirm sharing to translate this page.', 'ready');
  recovery = false;
}
const option = (value, text) => { const node = document.createElement('option'); node.value = value; node.textContent = text; return node; };
function targets() {
  const previous = $('target').value || prefs.target;
  const source = $('source').value;
  const supported = source === 'auto' ? languages.map(l => l.code) : (languages.find(l => l.code === source)?.targets || []);
  $('target').replaceChildren(...languages.filter(l => supported.includes(l.code) && l.code !== source).map(l => option(l.code, l.name)));
  if ([...$('target').options].some(o => o.value === previous)) $('target').value = previous;
}
port.onMessage.addListener(message => {
  if (message.type === 'init') {
    prefs = message.prefs;
    try { $('page').textContent = new URL(message.origin).host; } catch { $('page').textContent = message.origin; }
    $('page').title = message.origin;
    $('provider').textContent = prefs.provider === 'local' ? 'Local LibreTranslate receives page text on this device.' : 'LibreTranslate.com receives text outside this device.';
    $('provider').title = prefs.provider === 'local' ? 'Local server: http://localhost:5000' : 'https://libretranslate.com';
    $('dynamic').checked = prefs.dynamic;
  }
  if (message.type === 'languages') {
    languages = message.languages;
    $('source').replaceChildren(option('auto', 'Auto-detect'), ...languages.map(l => option(l.code, l.name)));
    $('source').value = languages.some(l => l.code === prefs.source) ? prefs.source : 'auto';
    targets();
    if ([...$('target').options].some(o => o.value === prefs.target)) $('target').value = prefs.target;
    ready = true; readinessStatus();
  }
  if (message.type === 'status') {
    if (Number.isInteger(message.total)) translatedTotal = message.total;
    running = message.state === 'loading' || (message.state === 'done' && prefs?.dynamic);
    if (message.state === 'navigation' || message.unavailable) { connected = false; ready = false; }
    recovery = message.state === 'error' || message.state === 'cancelled';
    if (Number.isFinite(message.retryAt) && message.retryAt > Date.now()) {
      retryAt = Math.max(retryAt, message.retryAt);
      clearInterval(retryTicker);
      retryTicker = setInterval(() => {
        if (Date.now() >= retryAt) {
          clearInterval(retryTicker);
          status('Rate limit reached. You can retry now.', 'error');
        }
        controls();
      }, 1000);
    }
    status(`${message.message}${message.skipped ? ` ${message.skipped} text sections exceed the safety limit and were left unchanged.` : ''}`, message.state);
  }
  controls();
});
port.onDisconnect.addListener(() => { clearInterval(heartbeat); clearInterval(retryTicker); connected = false; running = false; status('Translation window disconnected. Reopen Translate page to retry.', 'error'); controls(); });
$('languages').addEventListener('click', async () => {
  try {
    const granted = await api.permissions.request({ origins: [PROVIDERS[prefs.provider].origin] });
    if (!granted) throw new Error('Provider connection was not allowed. Try again when ready.');
    status('Loading provider languages…'); port.postMessage({ type: 'languages' });
  } catch (error) { status(error.message, 'error'); }
});
$('translate').addEventListener('click', () => {
  prefs.dynamic = $('dynamic').checked;
  running = true; controls(); status('Preparing translation…');
  port.postMessage({ type: 'start', source: $('source').value, target: $('target').value, dynamic: $('dynamic').checked, consent: $('consent').checked });
});
for (const [id, type] of [['cancel', 'cancel'], ['restore', 'restore']]) $(id).addEventListener('click', () => port.postMessage({ type }));
$('source').addEventListener('change', () => { targets(); readinessStatus(); controls(); });
for (const id of ['target', 'consent']) $(id).addEventListener('change', () => { readinessStatus(); controls(); });
$('settings').addEventListener('click', () => api.tabs.create({ url: api.runtime.getURL('workspace.html#/settings/languages') }));
controls();
