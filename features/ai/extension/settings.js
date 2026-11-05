// Full-page settings route: workspace.html#/settings/<category>. Layout and theme go through
// chrome.breezerPrivate (native prefs); spaces and tab behavior live in the workspace store.
import {
  APPEARANCE_REV_KEY, MAX_SPACES, STORE_KEY, TONES, TONE_NAMES,
  addSpace, moveSpace, normalizeAppearance, normalizeStore, removeSpace, renameSpace, setPrefs, setSpaceTone,
  validateAppearancePatch,
} from './workspace-store.js';
import { mountPasswords } from './passwords.js';
import { mountUsageSettings } from './usage-settings.js';
import { mountContextSettings } from './context-settings.js';
import { mountOnboarding } from './settings-onboarding.js';
import { mountSettingsNav } from './settings-nav.js';

// Settings owned by feature modules. Each entry names an empty container in workspace.html
// and loads a function called as mount({ container, api }). It may be async and may return
// { dispose }, which runs on pagehide. Categories marked data-optional stay out of the
// navigation and search until their container has content. Search indexes the rendered
// headings, .setting-row labels and descriptions, buttons and data-search-terms.
//   { container: 'sync-settings', load: () => import('./sync-settings.js').then((m) => m.mountSyncSettings) }
export const FEATURE_MOUNTS = Object.freeze([
  { container: 'sync-settings', load: () => import('./sync-settings.js').then((m) => m.mountSyncSettings) },
  { container: 'translation-settings', load: () => import('./translation-settings.js').then((m) => m.mountTranslationSettings) },
]);

const $ = (id) => document.getElementById(id);
const FIELD_LABELS = {
  layout: 'tab layout', sidebarMode: 'sidebar behavior', theme: 'theme',
  colorMode: 'appearance', showBookmarks: 'bookmarks bar', bookmarkBarMode: 'bookmarks bar', sidebarWidth: 'sidebar width',
  sidebarFontSize: 'sidebar font size', centeredAddressBar: 'centered address bar',
  minimalUrl: 'minimal URL', showLoadProgress: 'loading progress',
  frameless: 'frameless mode', alwaysShowSidebar: 'sidebar visibility',
  alwaysShowTopBar: 'top bar visibility',
};
const FIELD_ERRORS = {
  layout: 'layout-error', sidebarMode: 'layout-error', sidebarWidth: 'layout-error',
  showBookmarks: 'layout-error', bookmarkBarMode: 'layout-error', theme: 'theme-error', colorMode: 'theme-error',
  sidebarFontSize: 'typography-error', centeredAddressBar: 'address-error',
  minimalUrl: 'address-error', showLoadProgress: 'address-error', frameless: 'frameless-error',
  alwaysShowSidebar: 'frameless-error', alwaysShowTopBar: 'frameless-error',
};
const VALUE_LABELS = { sidebar: 'Sidebar', top: 'Top', expanded: 'Expanded', compact: 'Compact', autoHide: 'Auto-hide', system: 'System', light: 'Light', dark: 'Dark', true: 'On', false: 'Off', ...TONE_NAMES };

function el(tag, className, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function showError(id, message) {
  const node = $(id);
  node.textContent = message || '';
  node.hidden = !message;
}

const errorText = (error) => (error instanceof Error ? error.message : String(error || 'Something went wrong.'));

// Arrow keys move and select inside a role="radiogroup" (roving tabindex).
function wireRadioGroup(group, onSelect) {
  group.addEventListener('click', (event) => {
    const radio = event.target.closest('[role="radio"]');
    if (radio && group.contains(radio) && radio.getAttribute('aria-disabled') !== 'true') onSelect(radio.dataset.value);
  });
  group.addEventListener('keydown', (event) => {
    const radios = [...group.querySelectorAll('[role="radio"]')];
    const at = radios.indexOf(event.target.closest('[role="radio"]'));
    if (at < 0) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = radios[(at + step + radios.length) % radios.length];
    next.focus();
    if (next.getAttribute('aria-disabled') !== 'true') onSelect(next.dataset.value);
  });
}

function setRadioValue(group, value) {
  for (const radio of group.querySelectorAll('[role="radio"]')) {
    const checked = radio.dataset.value === value;
    radio.setAttribute('aria-checked', String(checked));
    radio.tabIndex = checked ? 0 : -1;
  }
}

// Older components render a heading followed by loose content. Keep the heading and its
// leading notes above, and put the rest in a rounded group like the other settings.
export function groupSection(container) {
  const section = container?.querySelector('.settings-section');
  if (!section || section.querySelector('.setting-group')) return;
  const group = el('div', 'setting-group panel');
  let leading = true;
  for (const child of [...section.children]) {
    if (child.tagName === 'H2') continue;
    if (leading && child.matches('.section-note')) continue;
    leading = false;
    group.append(child);
  }
  section.append(group);
}

async function mountFeatures(api) {
  await Promise.all(FEATURE_MOUNTS.map(async ({ container, load }) => {
    const node = $(container);
    if (!node) return;
    const loading = el('p', 'section-note', { role: 'status' });
    loading.textContent = 'Loading settings…';
    node.replaceChildren(loading);
    try {
      const handle = await (await load())({ container: node, api });
      loading.remove();
      if (typeof handle?.dispose === 'function') addEventListener('pagehide', () => handle.dispose(), { once: true });
    } catch (failure) {
      // One feature failing to load must not take the rest of Settings with it.
      node.replaceChildren();
      console.error(`Settings: ${container} failed to load.`, failure);
    }
  }));
}

export async function mountSettings({ api, workspace, callBridge, loadAppearance, applyAppearance, darkQuery }) {
  $('settings').hidden = false;
  document.title = 'Settings';
  const featuresReady = mountFeatures(api);
  void mountUsageSettings({ api, container: $('usage-settings') });
  groupSection($('usage-settings'));
  const passwords = mountPasswords({ container: $('password-settings'), api });
  groupSection($('password-settings'));
  let nav = null;
  // The card's password steps live in the Passwords category; show it before revealing them.
  const passwordSteps = { showImport() { nav?.open('passwords'); passwords.showImport(); } };
  const onboarding = mountOnboarding({ container: $('settings-onboarding'), api, passwords: passwordSteps });
  addEventListener('pagehide', () => onboarding.dispose(), { once: true });
  if (typeof api.runtime?.connect === 'function') {
    mountUpdates(api);
    mountOrganato(api);
    const contextSettings = mountContextSettings({ container: $('context-settings'), api });
    groupSection($('context-settings'));
    window.addEventListener('pagehide', () => contextSettings.dispose(), { once: true });
  }
  nav = mountSettingsNav({ api });
  void featuresReady.then(() => nav.refreshAvailability());
  let { appearance, available, error } = await loadAppearance();
  let store = (await workspace.read()).store;

  // ------------------------------------------------------------ appearance

  const swatches = $('theme-swatches');
  for (const tone of TONES) {
    const swatch = el('button', 'swatch', { role: 'radio', type: 'button' });
    swatch.dataset.value = tone;
    const preview = el('span', 'preview', { 'aria-hidden': 'true' });
    preview.dataset.tone = tone;
    preview.append(el('span', 'p-bar'), el('span', 'p-side'), el('span', 'p-card'));
    preview.querySelector('.p-side').append(el('span', 'p-row'), el('span', 'p-row active'), el('span', 'p-row'));
    const name = el('span', 'swatch-name');
    name.textContent = TONE_NAMES[tone];
    swatch.append(preview, name);
    swatches.append(swatch);
  }

  const groups = [...document.querySelectorAll('.segmented[data-field]')];
  const width = $('sidebar-width');
  const switches = [...document.querySelectorAll('.switch[data-field]')];
  const ranges = [...document.querySelectorAll('input[type="range"][data-field]')];
  const appearanceControls = [...groups.flatMap((group) => [...group.querySelectorAll('[role="radio"]')]), ...swatches.children, $('custom-theme-color'), $('custom-theme-apply'), ...ranges, ...switches];
  const rowOf = (selector) => document.querySelector(selector).closest('.setting-row');
  // Rows whose setting is kept but has no visible effect with the current layout or frame.
  const mutedRows = [
    [rowOf('[data-field="sidebarMode"]'), () => appearance.layout === 'top'],
    [width.closest('.setting-row'), () => appearance.layout === 'top'],
    [rowOf('[data-field="sidebarFontSize"]'), () => appearance.layout === 'top'],
    [rowOf('[data-field="alwaysShowSidebar"]'), () => !appearance.frameless],
    [rowOf('[data-field="alwaysShowTopBar"]'), () => !appearance.frameless],
  ];

  // Writes go to the browser one at a time. The newest request per field waits
  // its turn, so controls stay enabled and keep focus while a write is pending.
  const queued = new Map();
  let writing = null;
  const drafts = new Set();
  const settled = (field) => (writing?.field === field ? writing.value : appearance[field]);
  const wanted = (field) => (queued.has(field) ? queued.get(field) : settled(field));
  const saving = (field) => queued.has(field) || writing?.field === field;

  function renderAppearance() {
    applyAppearance(appearance);
    for (const group of groups) setRadioValue(group, appearance[group.dataset.field]);
    setRadioValue(swatches, appearance.theme);
    const customSelected = /^#[0-9a-fA-F]{6}$/.test(appearance.theme);
    $('custom-theme-note').textContent = customSelected ? 'Custom color selected' : 'Create a theme for the browser and sidebar.';
    $('custom-theme-apply').setAttribute('aria-pressed', String(customSelected));
    if (/^#[0-9a-fA-F]{6}$/.test(appearance.theme) && document.activeElement !== $('custom-theme-color')) $('custom-theme-color').value = appearance.theme;
    for (const range of ranges) {
      const field = range.dataset.field;
      if (!drafts.has(field) && !saving(field)) range.value = String(appearance[field]);
      $(`${range.id}-value`).textContent = `${range.value} px`;
    }
    for (const control of switches) control.setAttribute('aria-checked', String(appearance[control.dataset.field]));
    for (const [row, muted] of mutedRows) row.classList.toggle('muted-row', muted());
    for (const control of appearanceControls) {
      const disabled = !available;
      if (control.tagName === 'INPUT') control.disabled = disabled;
      else control.setAttribute('aria-disabled', String(disabled));
    }
    const note = $('bridge-note');
    if (!available) {
      note.textContent = error
        ? `Couldn’t read browser appearance settings: ${error} Reopen this page to try again.`
        : 'Browser appearance settings need Breezer’s browser integration, which this build doesn’t include. Defaults are shown and can’t be changed here.';
      note.hidden = false;
    } else {
      note.hidden = true;
    }
  }

  function request(field, value) {
    if (!available) return;
    queued.delete(field);
    if (value !== settled(field)) queued.set(field, value);
    void drain();
  }

  async function drain() {
    if (writing) return;
    while (queued.size) {
      const [field, value] = queued.entries().next().value;
      queued.delete(field);
      if (value === appearance[field]) continue;
      writing = { field, value };
      await write(field, value);
      writing = null;
    }
    renderAppearance();
  }

  // Applies one field through the bridge. The UI only shows the value the browser reports back.
  async function write(field, value) {
    const errorId = FIELD_ERRORS[field];
    showError(errorId, '');
    try {
      const patch = validateAppearancePatch({ [field]: value });
      let result = await callBridge('setAppearance', patch);
      if (!result || typeof result !== 'object') result = await callBridge('getAppearance');
      appearance = normalizeAppearance(result);
      if (appearance[field] !== value) {
        showError(errorId, `The browser kept ${FIELD_LABELS[field]} at ${VALUE_LABELS[appearance[field]] ?? appearance[field]}.`);
      }
      await api.storage.session.set({ [APPEARANCE_REV_KEY]: Date.now() }).catch(() => {});
    } catch (failure) {
      showError(errorId, `Couldn’t change the ${FIELD_LABELS[field]}. ${errorText(failure)}`);
    } finally {
      renderAppearance();
    }
  }

  for (const group of groups) wireRadioGroup(group, (value) => request(group.dataset.field, value));
  wireRadioGroup(swatches, (value) => request('theme', value));
  $('custom-theme-apply').addEventListener('click', () => request('theme', $('custom-theme-color').value));
  for (const control of switches) {
    control.addEventListener('click', () => {
      if (control.getAttribute('aria-disabled') !== 'true') request(control.dataset.field, !wanted(control.dataset.field));
    });
  }
  for (const range of ranges) {
    range.addEventListener('input', () => {
      drafts.add(range.dataset.field);
      $(`${range.id}-value`).textContent = `${range.value} px`;
    });
    range.addEventListener('change', () => {
      drafts.delete(range.dataset.field);
      request(range.dataset.field, Number(range.value));
      renderAppearance();
    });
  }

  const refreshAppearance = async () => {
    if (writing || queued.size) return;
    ({ appearance, available, error } = await loadAppearance());
    renderAppearance();
  };
  darkQuery.addEventListener('change', () => applyAppearance(appearance));
  addEventListener('focus', () => void refreshAppearance());

  // ------------------------------------------------------------ spaces

  // Set when the store changed while a name was being edited; rendered once editing ends.
  let spacesStale = false;

  async function mutateSpaces(fn) {
    showError('spaces-error', '');
    try {
      await workspace.update(fn);
    } catch (failure) {
      showError('spaces-error', errorText(failure));
    }
    // Re-read either way so a rejected edit shows the saved value again.
    try {
      store = (await workspace.read()).store;
      renderSpaces();
    } catch {}
  }

  function renderSpaces() {
    spacesStale = false;
    const list = $('space-list');
    const focused = document.activeElement?.closest?.('[data-space]');
    const restore = focused ? { id: focused.dataset.space, control: document.activeElement.dataset.control } : null;
    list.replaceChildren(...store.spaces.map((space, index) => {
      const item = el('li', 'space-item');
      item.dataset.space = space.id;
      item.dataset.tone = space.tone;

      const dot = el('span', 'space-swatch', { 'aria-hidden': 'true' });
      const nameId = `space-name-${space.id}`;
      const name = el('input', 'space-name-input', { id: nameId, type: 'text', maxlength: '60', 'aria-label': `Name of space ${index + 1}` });
      name.value = space.name;
      name.dataset.control = 'name';
      name.addEventListener('change', () => void mutateSpaces((draft) => renameSpace(draft, space.id, name.value)));
      name.addEventListener('keydown', (event) => { if (event.key === 'Enter') name.blur(); });

      const toneLabel = el('label', 'tone-select');
      const toneText = el('span', 'sr-only');
      toneText.textContent = `Color for ${space.name}`;
      const tone = el('select');
      tone.dataset.control = 'tone';
      for (const value of TONES) {
        const option = el('option');
        option.value = value;
        option.textContent = TONE_NAMES[value];
        option.selected = value === space.tone;
        tone.append(option);
      }
      tone.addEventListener('change', () => void mutateSpaces((draft) => setSpaceTone(draft, space.id, tone.value)));
      toneLabel.append(toneText, tone);

      const actions = el('div', 'space-actions');
      const up = el('button', 'small-button', { type: 'button', 'aria-label': `Move ${space.name} up` });
      up.textContent = '↑';
      up.title = `Move ${space.name} up`;
      up.dataset.control = 'up';
      up.disabled = index === 0;
      up.addEventListener('click', () => void mutateSpaces((draft) => moveSpace(draft, space.id, -1)));
      const down = el('button', 'small-button', { type: 'button', 'aria-label': `Move ${space.name} down` });
      down.textContent = '↓';
      down.title = `Move ${space.name} down`;
      down.dataset.control = 'down';
      down.disabled = index === store.spaces.length - 1;
      down.addEventListener('click', () => void mutateSpaces((draft) => moveSpace(draft, space.id, 1)));
      const remove = el('button', 'small-button danger', { type: 'button' });
      remove.textContent = 'Delete';
      remove.dataset.control = 'delete';
      remove.setAttribute('aria-label', `Delete ${space.name}`);
      remove.disabled = store.spaces.length <= 1;
      remove.addEventListener('click', () => {
        if (remove.dataset.confirm !== 'true') {
          remove.dataset.confirm = 'true';
          remove.textContent = 'Confirm delete';
          remove.setAttribute('aria-label', `Confirm deleting ${space.name}. Its tabs move to the first space.`);
          return;
        }
        void mutateSpaces((draft) => removeSpace(draft, space.id));
      });
      remove.addEventListener('blur', () => {
        remove.dataset.confirm = 'false';
        remove.textContent = 'Delete';
        remove.setAttribute('aria-label', `Delete ${space.name}`);
      });
      actions.append(up, down, remove);
      item.append(dot, name, toneLabel, actions);
      return item;
    }));
    if (restore) {
      const target = list.querySelector(`[data-space="${CSS.escape(restore.id)}"] [data-control="${restore.control}"]`);
      (target && !target.disabled ? target : list.querySelector(`[data-space="${CSS.escape(restore.id)}"] input`))?.focus();
    }
    $('settings-add-space').hidden = store.spaces.length >= MAX_SPACES;
    for (const group of document.querySelectorAll('.segmented[data-pref]')) setRadioValue(group, store.prefs[group.dataset.pref]);
  }

  $('space-list').addEventListener('focusout', () => {
    setTimeout(() => {
      if (spacesStale && !document.activeElement?.matches?.('.space-name-input')) renderSpaces();
    });
  });

  $('settings-add-space').addEventListener('click', () => {
    const used = new Set(store.spaces.map((space) => space.tone));
    const tone = TONES.find((value) => !used.has(value)) || appearance.theme;
    void mutateSpaces((draft) => addSpace(draft, { tone })).then(() => {
      const inputs = $('space-list').querySelectorAll('input');
      inputs[inputs.length - 1]?.focus();
      inputs[inputs.length - 1]?.select();
    });
  });

  // ------------------------------------------------------------ tab behavior

  for (const group of document.querySelectorAll('.segmented[data-pref]')) {
    wireRadioGroup(group, async (value) => {
      showError('tabs-error', '');
      try {
        await workspace.update((draft) => setPrefs(draft, { [group.dataset.pref]: value }));
        store = (await workspace.read()).store;
        setRadioValue(group, store.prefs[group.dataset.pref]);
      } catch (failure) {
        showError('tabs-error', `Couldn’t save that change. ${errorText(failure)}`);
      }
    });
  }

  // ------------------------------------------------------------ browser settings links

  for (const button of document.querySelectorAll('.link-list [data-url]')) {
    button.addEventListener('click', async () => {
      try {
        const [current] = await api.tabs.query({ active: true, currentWindow: true });
        await api.tabs.create({ url: button.dataset.url, ...(current ? { index: current.index + 1, windowId: current.windowId } : {}) });
      } catch (failure) {
        button.closest('li').dataset.error = 'true';
        button.title = `Couldn’t open ${button.dataset.url}. ${errorText(failure)}`;
      }
    });
  }

  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORE_KEY]) {
      store = normalizeStore(changes[STORE_KEY].newValue);
      const editing = document.activeElement?.matches?.('.space-name-input');
      if (editing) spacesStale = true;
      else renderSpaces();
    }
    if (area === 'session' && changes[APPEARANCE_REV_KEY]) void refreshAppearance();
  });

  renderAppearance();
  renderSpaces();
}

export function mountUpdates(api) {
  const container = $('update-settings');
  if (!container) return;
  const status = $('update-status'), check = $('update-check'), install = $('update-install');
  let sequence = 0, pending = null, timer, poll, port = null, closed = false, available = false, installing = false;
  const disconnected = () => {
    const needsCheck = pending !== null || available || installing;
    clearTimeout(timer); clearInterval(poll); poll = null; pending = null;
    available = false; installing = false;
    check.disabled = false; check.hidden = false; install.disabled = true; install.hidden = true;
    if (needsCheck) { status.textContent = 'The update check disconnected. Choose Check for updates to retry.'; status.dataset.state = 'error'; }
  };
  const connect = () => {
    if (port) return port;
    const connection = api.runtime.connect({ name: 'breezer-updates' });
    port = connection;
    connection.onMessage.addListener(message => {
      if (closed || port !== connection || message.id !== pending) return;
      clearTimeout(timer); pending = null;
      check.disabled = false;
      if (!message.ok) { check.hidden = false; status.textContent = String(message.error).replace(/Update helper unavailable\.?/i, 'The update check is unavailable.').replace(/Try again\.?$/i, 'Choose Check for updates to retry.'); status.dataset.state = 'error'; return; }
      const value = message.value;
      status.dataset.state = value.phase === 'failed' ? 'error' : '';
      status.textContent = value.notice || (value.available ? `Breezer ${value.version} is available.` : status.textContent);
      if (value.available !== undefined) { available = value.available === true; install.hidden = !available; }
      check.hidden = available && value.phase !== 'failed';
      install.disabled = !available;
      if (['downloading', 'verifying', 'restarting'].includes(value.phase)) check.disabled = true;
      if (value.installing) {
        installing = true; available = false; check.disabled = true; install.hidden = true;
        if (!poll) poll = setInterval(() => request('update-status'), 2000);
      }
      if (['installed', 'failed'].includes(value.phase)) { installing = false; clearInterval(poll); poll = null; check.disabled = false; }
    });
    connection.onDisconnect.addListener(() => {
      void api.runtime.lastError;
      if (closed || port !== connection) return;
      port = null; disconnected();
    });
    return connection;
  };
  const request = type => {
    if (closed || pending || (type === 'update-install' && !available)) return;
    pending = String(++sequence);
    status.dataset.state = '';
    check.disabled = true; install.disabled = true;
    if (type === 'update-check') status.textContent = 'Checking GitHub releases…';
    timer = setTimeout(() => { pending = null; check.disabled = false; check.hidden = false; install.hidden = true; status.textContent = 'The update check did not respond. Choose Check for updates to retry.'; status.dataset.state = 'error'; }, 65_000);
    try { connect().postMessage({ type, id: pending }); }
    catch {
      const connection = port; port = null;
      try { connection?.disconnect(); } catch {}
      disconnected();
    }
  };
  check.addEventListener('click', () => request('update-check'));
  install.addEventListener('click', () => request('update-install'));
  const dispose = () => { closed = true; clearTimeout(timer); clearInterval(poll); port?.disconnect(); port = null; };
  window.addEventListener('pagehide', dispose, { once: true });
  request('update-check');
  return { dispose };
}

export function mountOrganato(api, { timeoutMs = 85000 } = {}) {
  const mappings = { 'dashboard-enabled': 'dashboardEnabled', 'organato-enabled': 'enabled', 'organato-ai': 'allowAI' };
  const controls = ['organato-connect', 'organato-disconnect', 'organato-key', ...Object.keys(mappings)];
  let next = 0, pending, timer, closed = false, port = null, connected = false;
  const busy = value => {
    for (const id of controls) $(id).disabled = value;
    $('organato-disconnect').disabled = value || !connected;
    $('organato-disconnect').hidden = !connected;
  };
  const finish = (text, error = false) => {
    clearTimeout(timer); pending = null; busy(false);
    $('organato-status').dataset.state = error ? 'error' : '';
    if (text) $('organato-status').textContent = text;
  };
  const connect = () => {
    if (port) return port;
    const connection = api.runtime.connect({ name: 'breezer-organato-settings' });
    port = connection;
    connection.onMessage.addListener(message => {
      if (closed || port !== connection || message.id !== pending?.id) return;
      if (message.type === 'progress') {
        $('organato-status').textContent = typeof message.stage === 'string' ? message.stage : 'Connecting to Organato…';
        return;
      }
      if (!message.ok) { finish(message.error, true); return; }
      connected = message.value.connected === true;
      for (const [id, field] of Object.entries(mappings)) $(id).checked = message.value[field];
      finish(message.value.connected ? 'Organato connected.' : 'Connect Organato to show deadlines on your new tab.');
    });
    connection.onDisconnect.addListener(() => {
      void api.runtime.lastError;
      if (closed || port !== connection) return;
      port = null;
      if (pending) finish('Connection closed. Try again.', true);
    });
    return connection;
  };
  const request = (type, settings) => {
    if (closed || pending?.type === 'configure') return;
    clearTimeout(timer);
    pending = { id: String(++next), type };
    $('organato-status').dataset.state = '';
    busy(type === 'configure');
    timer = setTimeout(() => finish('Organato connection timed out. Check your connection and try again.', true), timeoutMs);
    try { connect().postMessage({ id: pending.id, type, settings }); }
    catch {
      const connection = port; port = null;
      try { connection?.disconnect(); } catch {}
      finish('Breezer could not connect to Organato. Try again.', true);
    }
  };
  for (const [id, field] of Object.entries(mappings)) $(id).addEventListener('change', () => request('configure', { [field]: $(id).checked }));
  $('organato-connect').addEventListener('click', () => {
    const key = $('organato-key').value.trim(); $('organato-key').value = '';
    $('organato-status').textContent = 'Connecting to Organato…'; request('configure', { key });
  });
  $('organato-disconnect').addEventListener('click', () => request('configure', { disconnect: true }));
  const dispose = () => { closed = true; clearTimeout(timer); port?.disconnect(); port = null; };
  window.addEventListener('pagehide', dispose, { once: true });
  request('view');
  return { dispose };
}
