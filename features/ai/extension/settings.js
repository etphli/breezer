// Full-page settings route: workspace.html#/settings. Layout and theme go through
// chrome.breezerPrivate (native prefs); spaces and tab behavior live in the workspace store.
import {
  APPEARANCE_REV_KEY, MAX_SPACES, STORE_KEY, TONES, TONE_NAMES,
  addSpace, moveSpace, normalizeAppearance, normalizeStore, removeSpace, renameSpace, setPrefs, setSpaceTone,
  validateAppearancePatch,
} from './workspace-store.js';
import { mountPasswords } from './passwords.js';
import { mountContextSettings } from './context-settings.js';

const $ = (id) => document.getElementById(id);
const FIELD_LABELS = {
  layout: 'tab layout', sidebarMode: 'sidebar behavior', theme: 'theme',
  colorMode: 'appearance', showBookmarks: 'bookmarks bar', sidebarWidth: 'sidebar width',
  sidebarFontSize: 'sidebar font size', centeredAddressBar: 'centered address bar',
  minimalUrl: 'minimal URL', showLoadProgress: 'loading progress',
  frameless: 'frameless mode', alwaysShowSidebar: 'sidebar visibility',
  alwaysShowTopBar: 'top bar visibility',
};
const FIELD_ERRORS = {
  layout: 'layout-error', sidebarMode: 'layout-error', sidebarWidth: 'layout-error',
  showBookmarks: 'layout-error', theme: 'theme-error', colorMode: 'theme-error',
  sidebarFontSize: 'typography-error', centeredAddressBar: 'layout-error',
  minimalUrl: 'layout-error', showLoadProgress: 'layout-error', frameless: 'layout-error',
  alwaysShowSidebar: 'layout-error', alwaysShowTopBar: 'layout-error',
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

export async function mountSettings({ api, workspace, callBridge, loadAppearance, applyAppearance, darkQuery }) {
  $('settings').hidden = false;
  document.title = 'Settings';
  mountPasswords({ container: $('password-settings'), api });
  if (typeof api.runtime?.connect === 'function') {
    mountUpdates(api);
    mountOrganato(api);
    const contextSettings = mountContextSettings({ container: $('context-settings'), api });
    window.addEventListener('pagehide', () => contextSettings.dispose(), { once: true });
  }
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
      up.textContent = 'Up';
      up.dataset.control = 'up';
      up.disabled = index === 0;
      up.addEventListener('click', () => void mutateSpaces((draft) => moveSpace(draft, space.id, -1)));
      const down = el('button', 'small-button', { type: 'button', 'aria-label': `Move ${space.name} down` });
      down.textContent = 'Down';
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
  const port = api.runtime.connect({ name: 'breezer-updates' });
  const status = $('update-status'), check = $('update-check'), install = $('update-install');
  let sequence = 0, pending = null, timer, poll;
  const request = type => {
    if (pending) return;
    pending = String(++sequence);
    check.disabled = true; install.disabled = true;
    if (type === 'update-check') status.textContent = 'Checking GitHub releases…';
    timer = setTimeout(() => { pending = null; check.disabled = false; status.textContent = 'Update helper did not respond. Try again.'; }, 65_000);
    port.postMessage({ type, id: pending });
  };
  port.onMessage.addListener(message => {
    if (message.id !== pending) return;
    clearTimeout(timer); pending = null;
    check.disabled = false;
    if (!message.ok) { status.textContent = message.error; return; }
    const value = message.value;
    status.textContent = value.notice || (value.available ? `Breezer ${value.version} is available.` : status.textContent);
    if (value.available !== undefined) install.hidden = !value.available;
    install.disabled = !value.available;
    if (['downloading', 'verifying', 'restarting'].includes(value.phase)) check.disabled = true;
    if (value.installing) { check.disabled = true; install.hidden = true; poll = setInterval(() => request('update-status'), 2000); }
    if (['installed', 'failed'].includes(value.phase)) { clearInterval(poll); check.disabled = false; }
  });
  port.onDisconnect.addListener(() => { clearTimeout(timer); clearInterval(poll); check.disabled = false; install.disabled = true; status.textContent = 'Update helper disconnected. Reopen Settings to retry.'; });
  check.addEventListener('click', () => request('update-check'));
  install.addEventListener('click', () => request('update-install'));
  const dispose = () => { clearTimeout(timer); clearInterval(poll); port.disconnect(); };
  window.addEventListener('pagehide', dispose, { once: true });
  request('update-check');
  return { dispose };
}

function mountOrganato(api) {
  const port = api.runtime.connect({ name: 'breezer-organato-settings' });
  let next = 0;
  const request = (type, settings) => port.postMessage({ id: String(++next), type, settings });
  const mappings = { 'dashboard-enabled': 'dashboardEnabled', 'organato-enabled': 'enabled', 'organato-ai': 'allowAI' };
  port.onMessage.addListener(message => {
    if (!message.ok) { $('organato-status').textContent = message.error; return; }
    for (const [id, field] of Object.entries(mappings)) $(id).checked = message.value[field];
    $('organato-status').textContent = message.value.connected ? 'Organato connected.' : 'Connect Organato to show your deadlines here.';
    $('organato-key').value = '';
  });
  port.onDisconnect.addListener(() => { $('organato-status').textContent = 'Connection closed. Reopen Settings to retry.'; });
  for (const [id, field] of Object.entries(mappings)) $(id).addEventListener('change', () => request('configure', { [field]: $(id).checked }));
  $('organato-connect').addEventListener('click', () => {
    const key = $('organato-key').value.trim(); $('organato-key').value = '';
    $('organato-status').textContent = 'Connecting to Organato…'; request('configure', { key });
  });
  $('organato-disconnect').addEventListener('click', () => request('configure', { disconnect: true }));
  window.addEventListener('pagehide', () => port.disconnect(), { once: true });
  request('view');
}
