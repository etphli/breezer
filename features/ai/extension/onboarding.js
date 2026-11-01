// First-run setup: workspace.html#/welcome. Each choice is saved where the rest of
// Breezer already reads it: appearance through chrome.breezerPrivate, the name in
// breezerProfile (the assistant's profile), and the Organato key through the
// background helper, which keeps it in Keychain. This page stores only its progress.
import { APPEARANCE_REV_KEY, TONES, TONE_NAMES, normalizeAppearance, validateAppearancePatch } from './workspace-store.js';
import { SETUP_KEY, STEPS, normalizeSetup } from './setup-state.js';
import { createPasswordActions } from './passwords.js';

export const PROFILE_KEY = 'breezerProfile';
// The Chrome import card in Settings; finishing setup covers what it explains.
const IMPORT_CARD_KEY = 'settings.onboarding.v1';
export const NAME_MAX = 80;

const SIDEBAR_SLIDES = [
  { focus: 'tabs', title: 'Your tabs run down the side', body: 'Click a tab to switch to it. Drag tabs to reorder them, and right-click one to pin it or put it in a folder.', keys: [['⌘ T', 'New tab'], ['⌘ W', 'Close tab']] },
  { focus: 'favorites', title: 'Favorites and spaces', body: 'Favorites sit at the top in every space. Spaces keep separate sets of tabs for school, work or anything else. Switch with the dots at the bottom.', keys: [['⌃ 1–4', 'Switch space']] },
  { focus: 'settings', title: 'Settings, one click away', body: 'The slider icon at the bottom of the sidebar opens Settings, where you can change anything you chose today.', keys: [['⌘ ,', 'Open Settings']] },
];
const TOP_SLIDES = [
  { focus: 'toptabs', title: 'Your tabs stay across the top', body: 'Tabs work the way you’re used to. To get spaces and favorites later, switch to the sidebar in Settings under Layout.', keys: [['⌘ T', 'New tab'], ['⌘ ,', 'Open Settings']] },
];
const AI_SLIDES = [
  { focus: 'ai', title: 'Meet Breezer AI', body: 'Press ⌘K to open the assistant beside any page. With Current page on, it reads the page you’re looking at, so you can ask for a summary or an answer.', keys: [['⌘ K', 'Open or close Breezer AI']] },
  { focus: 'control', title: 'Let it help, on your terms', body: 'Turn on Browser control and Breezer AI can click, type and scroll in the current tab until you turn it off. It asks before buying, sending or deleting anything.', keys: [['esc', 'Stop a reply']] },
];

export function tourSlides(layout) {
  return [...(layout === 'top' ? TOP_SLIDES : SIDEBAR_SLIDES), ...AI_SLIDES];
}

export function cleanName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

const NEXT_LABELS = { welcome: 'Get started', organato: 'Continue', done: 'Start browsing' };
const PROGRESS_LABELS = { welcome: 'Start', you: 'Name', layout: 'Tabs', theme: 'Color', import: 'Import', organato: 'Organato', tour: 'Tour', done: 'Done' };
const errorText = (error) => (error instanceof Error ? error.message : String(error || 'Something went wrong.'));

export async function mountWelcome({ api, callBridge, loadAppearance, applyAppearance, darkQuery, doc = document }) {
  const $ = (id) => doc.getElementById(id);
  const root = $('welcome');
  const mini = $('wl-mini');
  const passwords = createPasswordActions({ api });
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  doc.title = 'Welcome to Breezer';
  doc.body.classList.add('route-welcome');

  // The stylesheet only loads on this route, so the sidebar never pays for it.
  await new Promise((resolve) => {
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'onboarding.css';
    link.addEventListener('load', resolve, { once: true });
    link.addEventListener('error', resolve, { once: true });
    doc.head.append(link);
  });

  const local = api.storage.local;
  const [loaded, saved] = await Promise.all([
    loadAppearance(),
    local.get([SETUP_KEY, PROFILE_KEY]).catch(() => ({})),
  ]);
  let { appearance, available, error: bridgeError } = loaded;
  const profile = saved[PROFILE_KEY] && typeof saved[PROFILE_KEY] === 'object' ? saved[PROFILE_KEY] : {};
  let savedName = typeof profile.name === 'string' ? profile.name : '';
  let setup = normalizeSetup(saved[SETUP_KEY]);
  let index = setup.completed ? 0 : STEPS.indexOf(setup.step);
  let slide = 0;
  let organatoConnected = false;
  // Organato is on unless the helper reports it was turned off.
  let organatoEnabled = true;

  // ------------------------------------------------------------ appearance

  const swatches = $('wl-swatches');
  for (const tone of TONES) {
    const swatch = doc.createElement('button');
    swatch.type = 'button';
    swatch.className = 'wl-swatch';
    swatch.setAttribute('role', 'radio');
    swatch.dataset.value = tone;
    const chip = doc.createElement('span');
    chip.className = 'wl-swatch-chip';
    chip.dataset.tone = tone;
    chip.setAttribute('aria-hidden', 'true');
    const name = doc.createElement('span');
    name.textContent = TONE_NAMES[tone];
    swatch.append(chip, name);
    swatches.append(swatch);
  }
  const groups = [...root.querySelectorAll('[role="radiogroup"][data-field]')];

  function setRadio(group, value) {
    const radios = [...group.querySelectorAll('[role="radio"]')];
    const match = radios.some((radio) => radio.dataset.value === value);
    radios.forEach((radio, at) => {
      const checked = radio.dataset.value === value;
      radio.setAttribute('aria-checked', String(checked));
      radio.tabIndex = checked || (!match && at === 0) ? 0 : -1;
    });
  }

  function renderAppearance() {
    applyAppearance(appearance);
    for (const group of groups) setRadio(group, appearance[group.dataset.field]);
    if (/^#[0-9a-fA-F]{6}$/.test(appearance.theme) && doc.activeElement !== $('wl-custom-color')) $('wl-custom-color').value = appearance.theme;
    mini.dataset.layout = appearance.layout;
    mini.dataset.sidebarMode = appearance.sidebarMode;
    $('wl-sidebar-mode-row').classList.toggle('muted-row', appearance.layout === 'top');
    for (const group of groups) for (const radio of group.querySelectorAll('[role="radio"]')) radio.setAttribute('aria-disabled', String(!available));
    $('wl-custom-color').disabled = !available;
    $('wl-custom-apply').disabled = !available;
    const note = $('wl-bridge-note');
    note.hidden = available;
    note.textContent = available ? '' : (bridgeError
      ? `Couldn’t read browser appearance settings: ${bridgeError} You can change them later in Settings.`
      : 'Layout and color need Breezer’s browser integration, which this build doesn’t include. Defaults are shown.');
  }

  // Writes go to the browser one at a time; the page shows what the browser reports back.
  let writes = Promise.resolve();
  function write(field, value) {
    if (!available) return writes;
    const previous = appearance;
    appearance = { ...appearance, [field]: value };
    renderAppearance();
    writes = writes.then(async () => {
      try {
        let result = await callBridge('setAppearance', validateAppearancePatch({ [field]: value }));
        if (!result || typeof result !== 'object') result = await callBridge('getAppearance');
        appearance = normalizeAppearance(result);
        await api.storage.session?.set({ [APPEARANCE_REV_KEY]: Date.now() }).catch(() => {});
      } catch (failure) {
        appearance = { ...previous };
        $('wl-bridge-note').textContent = `Couldn’t change that setting. ${errorText(failure)}`;
        $('wl-bridge-note').hidden = false;
        renderAppearance();
        return;
      }
      renderAppearance();
    });
    return writes;
  }

  for (const group of groups) {
    group.addEventListener('click', (event) => {
      const radio = event.target.closest('[role="radio"]');
      if (radio && group.contains(radio) && radio.getAttribute('aria-disabled') !== 'true') void write(group.dataset.field, radio.dataset.value);
    });
    group.addEventListener('keydown', (event) => {
      const radios = [...group.querySelectorAll('[role="radio"]')];
      const at = radios.indexOf(event.target.closest('[role="radio"]'));
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (at < 0 || !step) return;
      event.preventDefault();
      const next = radios[(at + step + radios.length) % radios.length];
      next.focus();
      if (next.getAttribute('aria-disabled') !== 'true') void write(group.dataset.field, next.dataset.value);
    });
  }
  $('wl-custom-apply').addEventListener('click', () => void write('theme', $('wl-custom-color').value));
  darkQuery.addEventListener('change', () => applyAppearance(appearance));
  api.storage.onChanged?.addListener((changes, area) => {
    if (area === 'session' && changes[APPEARANCE_REV_KEY]) {
      void writes.then(async () => { ({ appearance, available, error: bridgeError } = await loadAppearance()); renderAppearance(); });
    }
  });

  // ------------------------------------------------------------ name

  const nameInput = $('wl-name');
  nameInput.value = savedName;
  const showName = () => { $('wl-mini-name').textContent = cleanName(nameInput.value) || 'there'; };
  nameInput.addEventListener('input', showName);
  nameInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void next(); } });
  showName();

  async function saveName() {
    const name = cleanName(nameInput.value);
    nameInput.value = name;
    if (name === savedName) return true;
    try {
      const current = (await local.get(PROFILE_KEY))[PROFILE_KEY];
      const context = typeof current?.context === 'string' ? current.context : '';
      await local.set({ [PROFILE_KEY]: { name, context } });
      savedName = name;
      $('wl-name-error').hidden = true;
      return true;
    } catch (failure) {
      $('wl-name-error').textContent = `Couldn’t save your name. ${errorText(failure)}`;
      $('wl-name-error').hidden = false;
      nameInput.focus();
      return false;
    }
  }

  // ------------------------------------------------------------ import

  async function openImport(button, destination, done) {
    $('wl-import-error').hidden = true;
    $('wl-import-status').textContent = '';
    button.disabled = true;
    try {
      await passwords.open(destination);
      // Opening a page is not an import; the user checks the result there.
      $('wl-import-status').textContent = done;
    } catch (failure) {
      $('wl-import-error').textContent = `${errorText(failure)} You can also import later from Settings.`;
      $('wl-import-error').hidden = false;
    } finally {
      button.disabled = false;
    }
  }
  $('wl-import-browser').addEventListener('click', (event) => void openImport(event.currentTarget, 'browserImport',
    'Import dialog opened in a new tab. Come back here when you’re done.'));
  $('wl-import-passwords').addEventListener('click', (event) => void openImport(event.currentTarget, 'import',
    'Password import opened in a new tab. Choose the file you exported from Chrome.'));

  // ------------------------------------------------------------ Organato

  const organato = (() => {
    let port = null, pending = null, pendingType = null, done = null, sequence = 0, timer;
    const status = $('wl-organato-status');
    const off = $('wl-organato-off');
    const busy = (value) => {
      for (const id of ['wl-organato-connect', 'wl-organato-key', 'wl-organato-off', 'wl-next', 'wl-back', 'wl-skip']) $(id).disabled = value;
      root.classList.toggle('wl-connecting', value);
    };
    const finish = (text) => {
      const kind = pendingType;
      clearTimeout(timer); pending = null; pendingType = null; done = null; busy(false);
      if (text !== undefined) status.textContent = text;
      // A failed opt-out leaves focus where the person can try again.
      if (kind === 'off' && organatoEnabled) off.focus();
    };
    // Shows the saved choice. Off is only shown once the helper confirms it.
    const show = (value) => {
      organatoConnected = value?.connected === true;
      organatoEnabled = value?.enabled !== false;
      mini.classList.toggle('organato-on', organatoConnected && organatoEnabled);
      off.hidden = !organatoEnabled;
    };
    const connect = () => {
      if (port) return port;
      const connection = api.runtime.connect({ name: 'breezer-organato-settings' });
      port = connection;
      connection.onMessage.addListener((message) => {
        if (port !== connection || message.id !== pending) return;
        if (message.type === 'progress') { status.textContent = typeof message.stage === 'string' ? message.stage : 'Connecting to Organato…'; return; }
        if (!message.ok) {
          finish(pendingType === 'off' ? `Couldn’t turn Organato off. ${message.error || 'Try again.'}` : message.error);
          return;
        }
        const after = done;
        show(message.value);
        if (after) { after(message.value); return; }
        finish(!organatoEnabled ? 'Organato is turned off. You can turn it on in Settings.'
          : organatoConnected ? 'Organato is connected. Your deadlines will appear on new tabs.' : '');
      });
      connection.onDisconnect.addListener(() => {
        void api.runtime.lastError;
        if (port !== connection) return;
        port = null;
        if (pending) finish('Connection closed. Try again.');
      });
      return connection;
    };
    // A change replaces a pending read; nothing replaces a pending change.
    const request = (type, settings, { kind = type, then = null } = {}) => {
      if ((pending && pendingType !== 'view') || typeof api.runtime?.connect !== 'function') return false;
      clearTimeout(timer);
      pending = String(++sequence);
      pendingType = kind;
      done = then;
      busy(type === 'configure');
      timer = setTimeout(() => finish(kind === 'off'
        ? 'Organato didn’t respond, so it’s still on. Try again, or turn it off later in Settings.'
        : 'Organato didn’t respond. Check your connection and try again, or skip for now.'), 85_000);
      try { connect().postMessage({ id: pending, type, settings }); }
      catch { port = null; finish(kind === 'off' ? 'The Organato helper is unavailable, so Organato is still on. Try again, or turn it off later in Settings.' : 'The Organato helper is unavailable. You can connect later in Settings.'); }
      return true;
    };
    // One click: save "off" in the helper, and only then move on.
    off.addEventListener('click', () => {
      status.textContent = 'Turning Organato off…';
      request('configure', { enabled: false }, { kind: 'off', then: (value) => {
        if (value?.enabled !== false) { finish('Couldn’t turn Organato off. Try again.'); return; }
        finish('Organato is turned off. You can turn it on in Settings.');
        if (STEPS[index] === 'organato') void next();
      } });
    });
    $('wl-organato-connect').addEventListener('click', () => {
      const key = $('wl-organato-key').value.trim();
      if (!key) { status.textContent = 'Paste your API key first, or choose Continue to skip.'; $('wl-organato-key').focus(); return; }
      $('wl-organato-key').value = '';
      status.textContent = 'Connecting to Organato…';
      request('configure', { key });
    });
    $('wl-organato-key').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); $('wl-organato-connect').click(); } });
    return { view: () => request('view'), dispose: () => { clearTimeout(timer); port?.disconnect(); port = null; } };
  })();
  if (typeof api.runtime?.connect === 'function') organato.view();
  else {
    $('wl-organato-connect').disabled = true;
    $('wl-organato-off').disabled = true;
    $('wl-organato-status').textContent = 'Open this page in Breezer to connect Organato.';
  }
  addEventListener('pagehide', () => organato.dispose(), { once: true });

  // ------------------------------------------------------------ tour and summary

  function renderSlide() {
    const slides = tourSlides(appearance.layout);
    slide = Math.min(slide, slides.length - 1);
    const current = slides[slide];
    $('wl-tour-count').textContent = `${slide + 1} of ${slides.length}`;
    $('wl-h-tour').textContent = current.title;
    $('wl-tour-body').textContent = current.body;
    $('wl-tour-keys').replaceChildren(...current.keys.map(([keys, label]) => {
      const item = doc.createElement('li');
      const kbd = doc.createElement('kbd');
      kbd.textContent = keys;
      const text = doc.createElement('span');
      text.textContent = label;
      item.append(kbd, text);
      return item;
    }));
    mini.dataset.focus = current.focus;
    $('wl-mini').querySelector('.mini-key').textContent = current.keys[0][0];
    replay(root.querySelector('[data-step="tour"]'), 'wl-swap');
  }

  function renderSummary() {
    const theme = /^#/.test(appearance.theme) ? 'Your own color' : TONE_NAMES[appearance.theme] ?? appearance.theme;
    const rows = [
      ['Breezer AI calls you', savedName || 'No name'],
      ['Tabs', appearance.layout === 'top' ? 'Across the top' : `Sidebar, ${{ expanded: 'expanded', compact: 'compact', autoHide: 'auto-hide' }[appearance.sidebarMode] ?? 'expanded'}`],
      ['Color', `${theme}, ${{ system: 'following your Mac', light: 'light', dark: 'dark' }[appearance.colorMode] ?? appearance.colorMode}`],
      ['Organato', !organatoEnabled ? 'Turned off' : organatoConnected ? 'Connected' : 'Not connected'],
    ];
    $('wl-summary').replaceChildren(...rows.flatMap(([term, value]) => {
      const dt = doc.createElement('dt'); dt.textContent = term;
      const dd = doc.createElement('dd'); dd.textContent = value;
      const row = doc.createElement('div'); row.append(dt, dd);
      return [row];
    }));
    $('wl-h-done').textContent = savedName ? `You’re all set, ${savedName}` : 'You’re all set';
  }

  // ------------------------------------------------------------ steps

  const progress = $('wl-progress');
  progress.replaceChildren(...STEPS.map((step) => {
    const item = doc.createElement('li');
    item.dataset.step = step;
    const label = doc.createElement('span');
    label.className = 'sr-only';
    label.textContent = PROGRESS_LABELS[step];
    item.append(label);
    return item;
  }));

  // Restarts a CSS animation class on an element (skipped when motion is reduced).
  function replay(element, className) {
    element.classList.remove('wl-enter-next', 'wl-enter-prev', 'wl-swap');
    if (reducedMotion?.matches) return;
    void element.offsetWidth;
    element.classList.add(className);
  }

  function render(direction = 0, { focus = true } = {}) {
    const step = STEPS[index];
    for (const section of root.querySelectorAll('.wl-step')) section.hidden = section.dataset.step !== step;
    const section = root.querySelector(`.wl-step[data-step="${step}"]`);
    if (direction) replay(section, direction > 0 ? 'wl-enter-next' : 'wl-enter-prev');
    mini.dataset.step = step;
    if (step !== 'tour') delete mini.dataset.focus;
    if (step === 'tour') renderSlide();
    if (step === 'done') renderSummary();
    for (const [at, item] of [...progress.children].entries()) {
      item.classList.toggle('done', at < index);
      if (at === index) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    }
    $('wl-back').hidden = index === 0;
    const slides = tourSlides(appearance.layout);
    $('wl-next').textContent = step === 'tour' && slide < slides.length - 1 ? 'Next' : NEXT_LABELS[step] ?? 'Continue';
    $('wl-skip').hidden = step === 'done';
    if (focus) (step === 'you' ? nameInput : section.querySelector('h1')).focus({ preventScroll: true });
    if (!setup.completed && setup.step !== step) {
      setup = { ...setup, step };
      void local.set({ [SETUP_KEY]: { step, completed: false } }).catch(() => {});
    }
  }

  async function finish({ skipped = false } = {}) {
    $('wl-next').disabled = true;
    $('wl-skip').disabled = true;
    await writes;
    const values = { [SETUP_KEY]: { step: 'done', completed: true, skipped } };
    if (!skipped) values[IMPORT_CARD_KEY] = { dismissed: true };
    await local.set(values).catch(() => {});
    setup = normalizeSetup(values[SETUP_KEY]);
    // Turn this tab into a new tab, so closing setup never closes the only window.
    try {
      const current = await api.tabs?.getCurrent?.();
      if (current?.id != null) { await api.tabs.update(current.id, { url: 'chrome://newtab/' }); return 'tab'; }
    } catch { /* fall through */ }
    location.assign(api.runtime?.getURL?.('newtab.html') ?? 'newtab.html');
    return 'page';
  }

  async function next() {
    const step = STEPS[index];
    if (step === 'you' && !(await saveName())) return;
    if (step === 'tour' && slide < tourSlides(appearance.layout).length - 1) {
      slide += 1;
      render(0, { focus: true });
      return;
    }
    if (step === 'done') { await finish(); return; }
    index += 1;
    slide = 0;
    render(1);
  }

  function back() {
    if (STEPS[index] === 'tour' && slide > 0) { slide -= 1; render(0); return; }
    if (index === 0) return;
    if (STEPS[index] === 'you') void saveName();
    index -= 1;
    if (STEPS[index] === 'tour') slide = tourSlides(appearance.layout).length - 1;
    render(-1);
  }

  $('wl-next').addEventListener('click', () => void next());
  $('wl-back').addEventListener('click', back);
  $('wl-skip').addEventListener('click', () => void finish({ skipped: true }));

  renderAppearance();
  root.hidden = false;
  render(0, { focus: true });
  // One orchestrated entrance: the miniature Breezer assembles itself.
  if (!reducedMotion?.matches) root.classList.add('wl-intro');
  root.dataset.ready = 'true';
  return { next, back, finish, get step() { return STEPS[index]; }, get slide() { return slide; } };
}
