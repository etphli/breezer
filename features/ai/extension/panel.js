import { localStorageChanges } from './storage-events.js';
import { ResearchSources, maskSecrets } from './research-sources.js';
import { renderMessage, createMessageStream } from './render-message.js';
import { MODEL_KEY, connectedModel, modelProviders, preferredModel, providerLabel, selectModel } from './model-catalog.js';
import { startPanelTheme } from './panel-theme.js';
import { normalizeThemeProposal, readThemeState, renderThemeProposal, restorePreviousLook } from './browser-theme.js';
import { detectBrowserTask } from './browser-task-intent.js';
import { preparePastedImage } from './clipboard-image.js';
import { themeReferenceImages } from './theme-references.js';
import { PLATFORM } from './platform.js';
import { HANDOFF_TTL_MS, handoffKey, readExperiments, startPersonalityLook } from './experiments.js';

const BROWSER_TASKS = {
  stats: { label: 'Browser stats', placeholder: 'Ask about your tabs or memory…', prompt: 'How many tabs are open, and how much memory are they using?', sharing: 'Tab titles and memory figures' },
  theme: { label: 'Theme design', placeholder: 'Describe a theme, background, or animation…', prompt: '', sharing: 'Page sharing off' },
  restore: { label: 'Restore previous look', sharing: 'Changes appearance on this device' },
};

const MAX_ATTACHMENT_TOTAL = 2 * 1024 * 1024;
const attachmentSize = file => (file.text || file.image || '').length;
const textExtension = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|css|scss|js|jsx|mjs|cjs|ts|tsx|py|rb|rs|go|java|kt|swift|c|h|cpp|hpp|cs|sh|bash|zsh|sql|ya?ml|toml|ini|cfg|log|svg)$/i;

async function readAttachment(file, { validatedImage = false } = {}) {
  if (!file.size) throw new Error('This file is empty.');
  if (file.name.length > 255) throw new Error('Use a filename shorter than 256 characters.');
  if (['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    if (file.size > 512 * 1024) throw new Error('Images must be 512 KB or smaller.');
    const image = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read this image.'));
      reader.readAsDataURL(file);
    });
    if (!validatedImage) {
      const bitmap = await createImageBitmap(file).catch(() => { throw new Error('This image could not be decoded.'); });
      bitmap.close();
    }
    return { name: file.name, image };
  }
  if (!file.type.startsWith('text/') && !textExtension.test(file.name)) throw new Error('Use text, code, CSV, PNG, JPEG, or WebP. Export PDF and Word documents as text first.');
  if (file.size > 96 * 1024) throw new Error('Text files must be 96 KB or smaller.');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error('Save this file as UTF-8 text and try again.'); }
  if (!text.trim() || /[\u0000-\u0008\u000e-\u001f]/.test(text)) throw new Error('This file has no readable text or contains binary data.');
  if (text.length > 24000) throw new Error('Text files must contain at most 24,000 characters. Split this file into smaller files.');
  return { name: file.name, text };
}

const $ = (id) => document.getElementById(id);
const state = {
  profile: { name: '', context: '' },
  providers: [],
  discoveryPending: true,
  selection: null,
  preferredModel: null,
  modelRefreshQueued: false,
  preferences: {},
  modelQuery: '',
  modelProvider: '',
  messages: [],
  attachments: [],
  readingFiles: false,
  retryMessage: null,
  fileGeneration: 0,
  includeContext: true,
  control: false,
  controlTabId: null,
  browserTask: null,
  running: null,
  page: null,
  pageKnown: false,
  pageRevision: 0,
  restoringLook: false,
  newTabDraft: null,
  newTabChatId: null,
  port: null,
  sessionKey: 'breezer-conversation',
  windowId: null,
};
const research = new ResearchSources({ api: chrome, root: document,
  onChange: () => { if (research.size) { state.browserTask = null; setControl(false); } updateControls(); },
  onRevoke: reason => { if (state.running) stop(); notify(reason); },
});
const messageNodes = new Map();
const themeCards = new Set();
let lastContextTitle = null;
let scheduledRender = false;
let modelChangeObserved = false;

function notify(text) {
  $('notice-text').textContent = text;
  $('notice').hidden = !text;
}

function post(message) {
  try {
    if (!state.port) throw new Error('The assistant disconnected. Reopen it with ⌘ K to reconnect.');
    state.port.postMessage(message);
    return true;
  } catch (error) {
    notify(error.message);
    finish(`Could not reach the assistant. ${error.message}`);
    return false;
  }
}

function selectedModel() {
  return connectedModel(state.providers, state.selection);
}

function effortLabel(level) {
  return ({ xhigh: 'Extra high' })[level] || level.charAt(0).toUpperCase() + level.slice(1);
}

function selectedSettings(selected = selectedModel()) {
  if (!selected) return { reasoning: '', speed: 'standard' };
  const { provider, model } = selected;
  const saved = state.preferences[`${provider.id}:${model.id}`];
  const levels = model.reasoningEfforts || [];
  const reported = levels.includes(model.defaultReasoningEffort) ? model.defaultReasoningEffort : '';
  const fallback = levels.includes('high') ? 'high' : reported;
  // An older saved "Default" choice means the model's own default level.
  return {
    reasoning: levels.includes(saved?.reasoning) ? saved.reasoning : saved?.reasoning === '' ? reported : fallback,
    speed: model.speeds?.includes('fast') && saved?.speed === 'fast' ? 'fast' : 'standard',
  };
}

function reasoningOptions(model) {
  const levels = model.reasoningEfforts || [];
  if (!levels.length) {
    const fixed = document.createElement('p');
    fixed.className = 'option-note';
    fixed.textContent = 'Set by the model';
    return [fixed];
  }
  return levels.map((level) => {
    const option = document.createElement('label');
    option.className = 'tuning-option';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'reasoning';
    input.value = level;
    const text = document.createElement('span');
    text.textContent = effortLabel(level);
    option.append(input, text);
    if (level === model.defaultReasoningEffort) {
      const tag = document.createElement('small');
      tag.textContent = 'Default';
      option.append(tag);
    }
    return option;
  });
}

// Reasoning and speed are radio groups that always describe the selected model.
function renderSettings(selected, running) {
  $('inference-model').textContent = selected ? selected.model.label || selected.model.id : '';
  const settings = selectedSettings(selected);
  const levels = selected?.model.reasoningEfforts || [];
  // Rebuild only when the model changes; typing in the composer calls this often.
  const signature = selected
    ? `${selected.provider.id}:${selected.model.id}:${levels.join(',')}:${selected.model.defaultReasoningEffort ?? ''}` : '';
  if ($('reasoning-options').dataset.signature !== signature) {
    $('reasoning-options').dataset.signature = signature;
    $('reasoning-options').replaceChildren(...(selected ? reasoningOptions(selected.model) : []));
  }
  for (const input of document.querySelectorAll('input[name="reasoning"]')) input.checked = input.value === settings.reasoning;
  $('reasoning-setting').disabled = running || !levels.length;
  const codex = selected?.provider.id === 'codex';
  const fastAvailable = Boolean(selected?.model.speeds?.includes('fast'));
  $('speed-setting').hidden = !codex;
  $('speed-setting').disabled = running || !codex;
  for (const input of document.querySelectorAll('input[name="speed"]')) input.checked = input.value === settings.speed;
  const fast = document.querySelector('input[name="speed"][value="fast"]');
  fast.disabled = !fastAvailable;
  $('speed-fast').title = fastAvailable ? 'Uses more of your Codex allowance' : 'Not available for this model';
  $('speed-note').hidden = !codex || settings.speed !== 'fast';
  // The composer shows the linked settings next to the model name.
  const fastOn = codex && settings.speed === 'fast';
  $('model-effort').textContent = [settings.reasoning ? effortLabel(settings.reasoning) : '', fastOn ? 'Fast' : ''].filter(Boolean).join(', ');
  $('model-effort').dataset.fast = String(fastOn);
}

function saveSettings() {
  const selected = selectedModel();
  if (!selected || state.running) return;
  const reasoning = document.querySelector('input[name="reasoning"]:checked')?.value ?? selectedSettings(selected).reasoning;
  const speed = document.querySelector('input[name="speed"]:checked')?.value || 'standard';
  state.preferences[`${selected.provider.id}:${selected.model.id}`] = {
    reasoning,
    ...(selected.provider.id === 'codex' ? { speed } : {}),
  };
  chrome.storage.local.set({ breezerModelPreferences: state.preferences }).catch(() => notify('Your model preferences could not be saved.'));
  updateControls();
}

function draftBrowserTask() {
  if (research.size) return '';
  return state.browserTask ?? detectBrowserTask($('prompt').value, {
    get hasImage() { return themeReferenceImages(state.attachments, recentRequestMessages()).length > 0; },
    get hasTheme() { return Boolean(state.messages.findLast(message => message.role === 'assistant')?.themeProposal); },
  });
}

function updateControls() {
  const running = Boolean(state.running);
  const task = BROWSER_TASKS[state.running?.browserTask || draftBrowserTask()];
  document.querySelector('.panel').dataset.running = String(running);
  document.querySelector('.panel').dataset.pageState = state.pageKnown ? 'ready' : 'loading';
  $('send').disabled = state.restoringLook || (!running && ((task !== BROWSER_TASKS.restore && !selectedModel()) || (!$('prompt').value.trim() && !state.attachments.length) || state.readingFiles));
  $('send').dataset.running = String(running);
  $('send').setAttribute('aria-label', running ? 'Stop response' : 'Send message');
  $('send').title = running ? 'Stop response' : 'Send message';
  $('send-arrow').toggleAttribute('hidden', running);
  $('send-stop').hidden = !running;
  $('attach-files').disabled = running || state.readingFiles;
  $('file-input').disabled = running || state.readingFiles;
  document.querySelectorAll('.attachment-remove').forEach(button => { button.disabled = running || state.readingFiles; });
  research.setBusy(running);
  $('control-toggle').disabled = running || !state.page || state.page.pdf || research.size > 0;
  $('context-toggle').hidden = Boolean(task) || research.size > 0 || !state.page;
  $('context-toggle').disabled = running || !state.page || research.size > 0;
  $('browser-task-open').disabled = running;
  $('browser-task-clear').hidden = !task;
  $('browser-task-clear').disabled = running;
  $('browser-task-clear').textContent = task ? `${task.label} ×` : '';
  if (task) $('browser-task-clear').setAttribute('aria-label', `Clear ${task.label}`);
  $('control-toggle').setAttribute('aria-pressed', String(state.control));
  $('context-toggle').setAttribute('aria-pressed', String(state.includeContext));
  $('sharing-label').textContent = state.page?.pdf ? 'PDF view' : state.control ? 'Page' : 'Page + screenshot';
  const share = !state.page ? 'unavailable' : state.control ? 'control' : state.includeContext ? 'shared' : 'off';
  $('context-hint').dataset.state = share;
  $('context-hint').textContent = task ? task.sharing : !state.pageKnown ? 'Loading current page…' : research.size ? 'Text only · screenshots and control off' : ({ unavailable: 'Chat without sharing this tab', control: 'Page + browser control', shared: state.page?.pdf ? 'Visible PDF only' : 'Page + screenshot', off: 'Page not shared' })[share];
  $('research-label').textContent = research.size ? `${research.size} ${research.size === 1 ? 'source' : 'sources'}` : 'Sources';
  $('research-open').dataset.active = String(research.size > 0);
  $('control-tip').textContent = state.page ? 'Click, type, scroll, and navigate in this tab.' : 'Available on ordinary web pages.';
  $('prompt').placeholder = task?.placeholder ?? (research.size ? 'Compare, summarize, or ask about your sources…' : state.control ? 'Tell Breezer what to do in this tab…' : state.includeContext ? 'Ask about this page…' : 'Ask anything…');
  const selected = selectedModel();
  if (!selected && !state.discoveryPending) $('prompt').placeholder = 'Draft a message…';
  renderWelcomeStatus(selected);
  document.querySelector('.panel').dataset.accountState = selected ? 'ready' : state.discoveryPending ? 'connecting' : 'signed-out';
  $('model-label').textContent = selected ? selected.model.label || selected.model.id : state.discoveryPending ? 'Loading models…' : 'Accounts';
  $('provider-dot').classList.toggle('connected', Boolean(selected));
  $('model-button').title = selected ? `${providerLabel(selected.provider.id)} · ${selected.model.label || selected.model.id}` : state.discoveryPending ? 'Checking connected accounts' : 'Choose a model';
  $('model-button').disabled = running;
  $('inference-options').hidden = !selected;
  if (running) setModelMenu(false);
  const summarize = document.querySelector('[data-prompt^="Summarize"]');
  if (summarize) {
    summarize.dataset.prompt = research.size ? 'Summarize these selected pages and cite the sources.' : 'Summarize this page. What should I take away from it?';
    summarize.querySelector('span').textContent = research.size ? 'Summarize selected sources' : 'Summarize this page';
  }
  renderSettings(selected, running);
}

// The empty state names whatever is stopping the next message, with one way forward.
function renderWelcomeStatus(selected) {
  let text = '';
  let action = '';
  let showAccounts = false;
  if (!selected && !state.discoveryPending) {
    const connected = state.providers.some((item) => item.available && item.authenticated);
    showAccounts = !connected;
    text = connected ? 'Choose a model to start.' : 'Sign in to Codex or Claude to start.';
    action = connected ? 'Choose a model' : $('welcome-account-steps').open ? 'Refresh accounts' : 'Set up an account';
  } else if (state.pageKnown && !state.page) {
    text = 'Open a web page to summarize it or get help with it. You can still ask anything below.';
  }
  $('welcome-status').hidden = !text;
  $('welcome-status-text').textContent = text;
  $('welcome-account-steps').hidden = !showAccounts;
  $('welcome-action').hidden = !action;
  $('welcome-action').textContent = action;
  $('draft-toggle').hidden = !action;
  document.querySelector('.suggestions').hidden = !selected && !state.discoveryPending || state.pageKnown && !state.page && !research.size;
  document.querySelectorAll('[data-page]').forEach((button) => { button.disabled = button.dataset.control ? research.size > 0 || state.page?.pdf || state.pageKnown && !state.page : !research.size && state.pageKnown && !state.page; });
}

function refreshModels() {
  state.discoveryPending = true;
  updateControls();
  if (!post({ type: 'refresh-models' })) {
    state.discoveryPending = false;
    applyModelSelection(state.preferredModel);
  }
}

function refreshQueuedModel() {
  if (!state.modelRefreshQueued || state.discoveryPending || state.running || !state.port) return;
  state.modelRefreshQueued = false;
  state.selection = null;
  refreshModels();
}

function renderModels() {
  if (PLATFORM === 'windows') {
    const codex = state.providers.find((provider) => provider.id === 'codex');
    const steps = $('welcome-account-steps');
    const instructions = steps.querySelector('[data-provider="codex"]');
    instructions.hidden = typeof codex?.setup !== 'string';
    instructions.querySelector('code').textContent = codex?.setup || '';
    steps.querySelector('[data-account-shell-hint]').textContent = 'Open PowerShell and paste the command. Follow the sign-in prompts, then return here and refresh accounts.';
  }
  renderProviderFilter();
  const focusKey = document.activeElement?.dataset?.modelKey;
  const query = state.modelQuery.trim().toLowerCase();
  const groups = [];
  let matches = 0;
  if (!state.providers.length) {
    const note = document.createElement('p');
    note.className = 'provider-error';
    note.textContent = 'Checking your local Codex and Claude accounts…';
    groups.push(note);
  }
  for (const provider of state.providers) {
    if (state.modelProvider && provider.id !== state.modelProvider) continue;
    const connected = provider.available && provider.authenticated;
    const providerMatch = providerLabel(provider.id).toLowerCase().includes(query);
    const models = (connected ? provider.models || [] : [])
      .filter((model) => providerMatch || `${model.label || ''} ${model.id}`.toLowerCase().includes(query));
    if (query && !models.length && !providerMatch) continue;
    matches += models.length;
    const group = document.createElement('div');
    group.className = 'provider-group';
    const heading = document.createElement('div');
    heading.className = 'provider-heading';
    const name = document.createElement('span');
    name.textContent = providerLabel(provider.id);
    heading.append(name);
    group.append(heading);
    for (const model of models) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'model-option';
      button.dataset.modelKey = `${provider.id}:${model.id}`;
      const isSelected = state.selection?.provider === provider.id && state.selection?.model === model.id;
      button.classList.toggle('selected', isSelected);
      button.disabled = Boolean(state.running);
      button.setAttribute('aria-pressed', String(isSelected));
      const label = document.createElement('span');
      label.textContent = model.label || model.id;
      button.append(label);
      if (isSelected) {
        const check = document.createElement('span');
        check.className = 'model-check';
        check.textContent = '✓';
        check.setAttribute('aria-hidden', 'true');
        button.append(check);
      }
      button.addEventListener('click', () => {
        const previous = state.preferredModel;
        const choice = { provider: provider.id, model: model.id };
        state.modelRefreshQueued = false;
        applyModelSelection(choice);
        chrome.storage.local.set({ [MODEL_KEY]: choice }).catch(() => {
          if (state.preferredModel === choice) applyModelSelection(previous);
          notify('Your model choice could not be saved.');
        });
        setModelMenu(false);
        $('prompt').focus();
      });
      group.append(button);
    }
    if (provider.error || !connected || !provider.models?.length) {
      const error = document.createElement('p');
      error.className = 'provider-error';
      error.textContent = connected ? provider.error || 'No eligible models on this account.'
        : provider.available ? 'Connect this account to see its models.' : `${providerLabel(provider.id)} is unavailable on this device.`;
      group.append(error);
      if (!connected) {
        const connect = document.createElement('button');
        connect.type = 'button';
        connect.className = 'account-connect';
        connect.textContent = `Connect ${providerLabel(provider.id)}`;
        connect.addEventListener('click', () => {
          setModelMenu(false);
          $('account-title').textContent = `Connect ${providerLabel(provider.id)}`;
          $('account-instructions').replaceChildren(...[...$('welcome-account-steps').children]
            .filter(node => node.tagName !== 'SUMMARY' && !node.hidden && (!node.dataset.provider || node.dataset.provider === provider.id))
            .map(node => node.cloneNode(true)));
          if (!provider.available) $('account-instructions').querySelector('p').textContent = PLATFORM === 'windows' && provider.error
            ? provider.error : `Make sure ${providerLabel(provider.id)} is installed, then copy this command.`;
          $('account-dialog').showModal();
        });
        group.replaceChildren(connect);
      }
    }
    groups.push(group);
  }
  if (query && !groups.length) {
    const empty = document.createElement('p');
    empty.className = 'model-empty';
    empty.textContent = `No models match “${state.modelQuery.trim()}”`;
    groups.push(empty);
  }
  $('model-options').replaceChildren(...groups);
  $('model-results').textContent = query ? `${matches} ${matches === 1 ? 'model' : 'models'}` : '';
  if (focusKey) $('model-options').querySelector(`[data-model-key="${CSS.escape(focusKey)}"]`)?.focus();
}

// Filters appear only when more than one provider is reported.
function renderProviderFilter() {
  const filter = $('provider-filter');
  const ids = state.providers.map((provider) => provider.id);
  if (state.modelProvider && !ids.includes(state.modelProvider)) state.modelProvider = '';
  filter.hidden = ids.length < 2;
  const wanted = ['', ...ids].join('|');
  if (filter.dataset.ids !== wanted) {
    filter.dataset.ids = wanted;
    filter.replaceChildren(...['', ...ids].map((id) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'provider-chip';
      chip.dataset.provider = id;
      chip.textContent = id ? providerLabel(id) : 'All';
      chip.addEventListener('click', () => {
        state.modelProvider = id;
        renderModels();
      });
      return chip;
    }));
  }
  for (const chip of filter.children) chip.setAttribute('aria-pressed', String(chip.dataset.provider === state.modelProvider));
}

function applyModelSelection(preferred) {
  state.preferredModel = preferred;
  if (!state.modelRefreshQueued) state.selection = selectModel(state.providers, preferred);
  else if (!state.running) state.selection = null;
  renderModels();
  updateControls();
}

function acceptProviders(providers) {
  state.discoveryPending = false;
  state.providers = modelProviders(providers);
  if (connectedModel(state.providers, state.preferredModel)) state.modelRefreshQueued = false;
  applyModelSelection(state.preferredModel);
  refreshQueuedModel();
}

function setModelMenu(open, focus = false) {
  const wasOpen = !$('model-menu').hidden;
  $('model-menu').hidden = !open;
  $('model-button').setAttribute('aria-expanded', String(open));
  if (open && !wasOpen) {
    // Each opening starts from the full list.
    state.modelQuery = '';
    state.modelProvider = '';
    $('model-search').value = '';
    renderModels();
  }
  if (open && focus) {
    const options = [...$('model-options').querySelectorAll('.model-option:not(:disabled)')];
    (options.find((item) => item.classList.contains('selected')) || options[0] || $('model-search')).focus();
  }
}

function dismissModelMenu() {
  setModelMenu(false);
  $('model-button').focus();
}

function setPage(page) {
  const revision = ++state.pageRevision;
  const render = (pdf) => {
    if (revision !== state.pageRevision) return;
    if (state.newTabChatId !== null && page?.tabId !== state.newTabChatId) {
      state.newTabChatId = null;
      delete document.documentElement.dataset.newTabChat;
    }
    state.pageKnown = true;
    state.page = pdf ? { tabId: page.tabId, title: 'Current PDF', pdf: true }
      : page?.url && /^https?:\/\//i.test(page.url) ? page : null;
    if (!state.page) {
      state.includeContext = false;
      setControl(false);
    } else if (state.control && (pdf || page.tabId !== state.controlTabId)) {
      setControl(false);
      notify('Browser control turned off because the active tab changed.');
    }
    let label = pdf ? 'Current PDF' : 'No shareable page';
    if (state.page && !pdf) {
      try { label = page.title || new URL(page.url).hostname; } catch { label = page.title || 'Current page'; }
    }
    $('context-title').textContent = label;
    $('context-toggle').title = pdf ? 'Include the visible part of this PDF with your message'
      : state.page ? `${page.url}\nInclude this page and a screenshot with your message`
      : 'Include the current page and a screenshot with your message';
    updateControls();
  };
  if (Number.isInteger(page?.tabId) && typeof chrome.breezerPrivate?.isCurrentPdf === 'function') {
    chrome.breezerPrivate.isCurrentPdf(page.tabId).then(render, () => render(false));
  } else render(false);
}

// Consent belongs to one tab. It lasts across replies until the user turns it off,
// stops a reply, switches tabs, starts a new conversation, or control fails.
function setControl(on) {
  if (on && research.size) return;
  state.control = on && Boolean(state.page) && !state.page.pdf;
  state.controlTabId = state.control ? state.page.tabId : null;
  if (state.control) state.includeContext = true;
}

function applyProfile() {
  const name = state.profile.name.trim();
  $('greeting-name').textContent = name ? `, ${name}` : '';
  $('profile-initial').textContent = (state.profile.name.trim()[0] || 'Y').toLocaleUpperCase();
}

function appendMessage(message) {
  const repeatedContext = message.role === 'user' && message.contextTitle === lastContextTitle && !Array.isArray(message.sourceMetadata);
  if (message.role === 'user') lastContextTitle = message.contextTitle || '';
  const article = document.createElement('article');
  article.className = `message ${message.role}`;
  article.setAttribute('aria-label', message.role === 'user' ? 'You' : 'Breezer');
  const body = document.createElement('div');
  body.className = 'message-body';
  if (message.role === 'assistant') {
    const heading = document.createElement('div');
    heading.className = 'assistant-heading';
    if ($('messages').querySelector('.message.assistant')) heading.classList.add('sr-only');
    const logo = document.createElement('img');
    logo.src = 'icon128.png';
    logo.alt = '';
    const label = document.createElement('span');
    label.textContent = 'Breezer';
    heading.append(logo, label);
    article.append(heading);
    if (message.text) renderMessage(body, message.text);
    else {
      const thinking = document.createElement('div');
      thinking.className = 'thinking';
      thinking.setAttribute('aria-label', 'Thinking');
      for (let i = 0; i < 3; i++) thinking.append(document.createElement('span'));
      body.append(thinking);
    }
  } else body.textContent = message.text;
  linkResearchCitations(body, message.citations);
  if (message.role === 'user' && message.text) {
    const prompt = document.createElement('div');
    prompt.className = 'sent-prompt';
    prompt.append(body, copyPromptButton(body));
    article.append(prompt);
  } else article.append(body);
  if (message.themeProposal) themeCards.add(renderThemeProposal(article, message.themeProposal));
  if (message.stats) renderStats(body, message.stats);
  if (message.attachments?.length) {
    const files = document.createElement('div');
    files.className = 'message-meta';
    files.textContent = message.attachments.map(file => file.name).join(', ');
    article.append(files);
  }
  if (message.contextTitle) {
    const meta = document.createElement('div');
    meta.className = 'message-meta context-meta';
    if (repeatedContext) { meta.classList.add('sr-only'); article.title = `Included context: ${message.contextTitle}`; }
    meta.textContent = message.contextTitle;
    if (Array.isArray(message.sourceMetadata)) renderSourceMetadata(meta, message.sourceMetadata);
    article.append(meta);
  }
  $('messages').append(article);
  messageNodes.set(message.id, body);
  $('welcome').hidden = true;
  return body;
}

function renderStats(body, { windowTabCount, totalTabCount, browserMemory, systemMemory }) {
  const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  const count = value => value === null ? 'Unavailable' : number.format(value);
  const memory = bytes => {
    if (bytes === null) return 'Unavailable';
    const unit = bytes >= 1024 ** 3 ? 'GiB' : 'MiB';
    return `${number.format(bytes / 1024 ** (unit === 'GiB' ? 3 : 2))} ${unit}`;
  };
  const footprint = browserMemory.footprintBytes;
  const available = systemMemory.availableBytes;
  const total = systemMemory.totalBytes;
  const rows = [
    ['Tabs in this window', count(windowTabCount)],
    ['Tabs in all regular windows', count(totalTabCount)],
    ['Breezer memory', memory(footprint) + (footprint !== null && !browserMemory.sampleComplete ? ' (partial)' : '')],
    ['System RAM available', available !== null && total !== null ? `${memory(available)} of ${memory(total)}` : memory(available)],
  ];
  if (available === null && total !== null) rows.push(['System RAM total', memory(total)]);
  const stats = document.createElement('dl');
  stats.className = 'browser-stats';
  stats.setAttribute('aria-label', 'Measured browser stats');
  for (const [label, value] of rows) {
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value;
    stats.append(term, detail);
  }
  body.before(stats);
}

function selectText(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function copyPromptButton(body) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button copy-prompt';
  button.setAttribute('aria-label', 'Copy prompt');
  button.title = 'Copy prompt';
  const namespace = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(namespace, 'svg');
  const path = document.createElementNS(namespace, 'path');
  const copy = 'M8 6V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-1M5 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z';
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  path.setAttribute('d', copy);
  icon.append(path);
  button.append(icon);
  let reset;
  button.addEventListener('click', async () => {
    clearTimeout(reset);
    try {
      await navigator.clipboard.writeText(body.textContent);
      path.setAttribute('d', 'm5 12 4 4L19 6');
      $('announcer').textContent = 'Prompt copied.';
      reset = setTimeout(() => { path.setAttribute('d', copy); }, 1600);
    } catch {
      selectText(body);
      path.setAttribute('d', copy);
      notify('Prompt selected. Use your keyboard to copy it.');
    }
  });
  return button;
}

function linkResearchCitations(body, sources) {
  // Decorate completed research replies without changing the shared stream parser.
  if (!sources?.length) return;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (!walker.currentNode.parentElement.closest('code, pre, a')) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const parts = []; let start = 0;
    for (const match of node.textContent.matchAll(/\[S(\d+)\]/g)) {
      const source = sources.find(source => source.sourceId === `S${match[1]}`);
      if (!source || !/^https?:\/\//.test(source.url)) continue;
      const between = node.textContent.slice(start, match.index);
      parts.push(document.createTextNode(parts.length && !between.trim() ? ', ' : between));
      const link = document.createElement('a');
      link.textContent = `Source ${match[1]}`; link.href = source.url;
      link.title = source.title || link.textContent;
      link.target = '_blank'; link.rel = 'noopener noreferrer'; link.className = 'citation';
      parts.push(link); start = match.index + match[0].length;
    }
    if (parts.length) node.replaceWith(...parts, document.createTextNode(node.textContent.slice(start)));
  }
}

function renderSourceMetadata(meta, sources) {
  meta.classList.remove('sr-only');
  const unavailable = sources.filter(source => source.status !== 'available').length;
  const details = document.createElement('details');
  details.className = 'source-details';
  details.open = unavailable > 0;
  const summary = document.createElement('summary');
  summary.textContent = `${sources.length} sources${unavailable ? ` · ${unavailable} unavailable` : ''}`;
  details.append(summary);
  const list = document.createElement('ul');
  for (const source of sources) {
    const row = document.createElement('li');
    row.dataset.state = source.status;
    const title = document.createElement('span');
    title.className = 'source-title';
    title.textContent = `${source.sourceId.slice(1)} · ${source.title || 'Source'}`;
    title.title = source.url;
    const status = document.createElement('small');
    status.textContent = source.status === 'available'
      ? `${source.capturedCharacters} characters${source.truncated ? ' · Truncated' : ''}`
      : `Unavailable · ${source.error}`;
    row.append(title, status); list.append(row);
  }
  details.append(list);
  if (unavailable) {
    const review = document.createElement('button');
    review.type = 'button';
    review.className = 'review-sources';
    review.textContent = 'Review source tabs';
    review.addEventListener('click', () => void research.open());
    details.append(review);
  }
  meta.replaceChildren(details);
}

function recentMessages(limit) {
  const messages = [];
  for (let index = state.messages.length - 1; index >= 0 && messages.length < limit; index--) {
    const message = state.messages[index];
    if (message.text) messages.push(message);
  }
  return messages.reverse();
}

function recentRequestMessages() {
  return recentMessages(30).filter(message => !message.superseded && message !== state.retryMessage);
}

// Retried files are included once, with their most recent message.
function requestHistory() {
  const seen = new Set(state.attachments.map(file => JSON.stringify(file)));
  return recentRequestMessages().reverse().map(({ role, text: content, attachments }) => {
    const files = (attachments || []).filter(file => {
      const key = JSON.stringify(file);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { role, content, ...(files.length ? { attachments: files } : {}) };
  }).reverse();
}

function saveConversation(completedId) {
  const messages = recentMessages(60);
  if (messages.length) messages.at(-1).lastActivity = Date.now();
  return chrome.storage.session.set({ [state.sessionKey]: messages }).then(() => {
    if (completedId && state.port) post({ type: 'turn-saved', id: completedId });
  }).catch(() => {});
}

function scrollToBottom() {
  $('conversation').scrollTop = $('conversation').scrollHeight;
}

function renderDelta() {
  if (scheduledRender) return;
  scheduledRender = true;
  requestAnimationFrame(() => {
    scheduledRender = false;
    const message = state.running?.message;
    const body = message && messageNodes.get(message.id);
    if (!body) return;
    const scroller = $('conversation');
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100;
    const run = state.running;
    run.renderer ||= createMessageStream(body);
    run.renderer.append(message.text.slice(run.renderedLength || 0));
    run.renderedLength = message.text.length;
    if (atBottom) scrollToBottom();
  });
}

// A failed or empty reply can be reused, but only by putting it back in the composer.
// Nothing is resent, and browser control stays off until the user turns it on again.
function offerRetry(run, failed = true) {
  const body = run && messageNodes.get(run.assistantId);
  const original = run && state.messages.find((item) => item.id === run.id);
  if (!body || !original || body.parentElement.querySelector('.retry-button')) return;
  const article = body.parentElement;
  article.classList.toggle('failed', failed);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'retry-button';
  button.textContent = 'Edit and resend';
  button.addEventListener('click', () => {
    if (state.running) return;
    const prompt = $('prompt');
    if (prompt.value.trim() && prompt.value.trim() !== original.text) {
      notify('Your draft is still in the message box. Send or clear it first, then choose Edit and resend.');
      prompt.focus();
      return;
    }
    if (state.attachments.length || state.readingFiles) return notify('Send or remove your attached draft files first.');
    state.retryMessage = original;
    if (run.browserTask) research.clear();
    state.browserTask = run.browserTask || '';
    state.attachments = [...(original.attachments || [])];
    renderAttachments();
    prompt.value = original.text;
    resizePrompt();
    prompt.focus();
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
    if (run.control && !state.control) notify('Browser control is off. Turn it on again before sending if Breezer should act in this tab.');
  });
  article.append(button);
  button.scrollIntoView({ block: 'nearest' });
}

function activityLabel(label) {
  const sharing = BROWSER_TASKS[state.running?.browserTask]?.label ?? (state.control ? 'Browser control' : research.size ? 'Source tabs' : state.includeContext ? state.page?.pdf ? 'PDF view' : 'Page + screenshot' : '');
  $('activity-label').textContent = sharing ? `${sharing} · ${label}` : label;
}

function finish(label, keepControl = false, completedId) {
  if (state.running) {
    state.running.renderer?.dispose();
    state.running.renderer = null;
    const message = state.messages.find((item) => item.id === state.running.assistantId);
    if (message && !message.text) {
      message.text = label || 'Response stopped.';
      renderMessage(messageNodes.get(message.id), message.text);
    } else if (message) renderMessage(messageNodes.get(message.id), message.text);
    if (message) linkResearchCitations(messageNodes.get(message.id), message.citations);
    if (message?.themeProposal) {
      const conversation = $('conversation');
      const followsReply = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 100;
      themeCards.add(renderThemeProposal(messageNodes.get(message.id).parentElement, message.themeProposal));
      if (followsReply) scrollToBottom();
    }
    state.running.message = null;
  }
  state.running = null;
  if (!keepControl) setControl(false);
  $('activity').hidden = true;
  updateControls();
  saveConversation(completedId);
  refreshQueuedModel();
  // The stop button turns into a disabled send button; keep keyboard focus in the composer.
  if (document.activeElement === $('send') || document.activeElement === document.body) $('prompt').focus();
}

function stop() {
  if (!state.running) return;
  const run = state.running;
  const replied = Boolean(state.messages.find((item) => item.id === run.assistantId)?.text);
  post({ type: 'cancel', id: run.id });
  finish('Stopped.', false, run.submitted && !run.control ? run.id : undefined);
  if (!replied) offerRetry(run, false);
}

// The reason is shown in the reply itself, so it is only announced, not repeated in the notice bar.
function fail(reason, label, completedId) {
  const run = state.running;
  notify('');
  $('announcer').textContent = label;
  finish(label, false, completedId);
  const body = run && messageNodes.get(run.assistantId);
  if (body && reason && !label.includes(reason)) {
    const details = document.createElement('details');
    details.className = 'error-details';
    const summary = document.createElement('summary');
    summary.textContent = 'Error details';
    const text = document.createElement('p');
    text.textContent = reason;
    details.append(summary, text);
    body.parentElement.append(details);
  }
  offerRetry(run);
}

function providerFailureSummary(reason) {
  if (/rate[ _-]*limit|quota|usage limit|\b429\b/i.test(reason)) return 'Your account has reached a provider limit. Wait for it to reset before retrying.';
  if (/unauthori[sz]ed|authentication|not signed in|sign[ -]in|\b401\b/i.test(reason)) return 'The provider could not verify your account. Check its sign-in, then try again.';
  if (/timed? out|timeout|deadline exceeded/i.test(reason)) return 'The provider took too long to reply. Try again.';
  if (/ECONNREFUSED|ENETUNREACH|network error|connection (?:failed|closed|refused)|fetch failed/i.test(reason)) return 'The connection to your provider failed. Check your connection, then try again.';
  return 'The assistant could not complete this response. You can edit your message and try again.';
}

function revealPanel() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.querySelector('.panel').animate(
    [{ transform: 'translateX(2px)' }, { transform: 'translateX(0)' }],
    { duration: 120, easing: 'ease-out' },
  );
}

async function send() {
  if (state.running) return stop();
  if (state.readingFiles || state.restoringLook) return;
  if (state.browserTask && research.size) {
    notify('Clear source tabs before sending a browser tools request.');
    return;
  }
  const browserTask = draftBrowserTask();
  if (browserTask === 'restore') {
    state.restoringLook = true;
    updateControls();
    try {
      const { restored } = await restorePreviousLook();
      $('prompt').value = '';
      notify(restored ? 'Restored your previous look.' : 'There’s no previous look to restore.');
    } catch (error) { notify(error.message); }
    finally { state.restoringLook = false; resizePrompt(); }
    return;
  }
  const fromNewTab = state.newTabDraft?.prompt === $('prompt').value.trim();
  const includeContext = !fromNewTab && !browserTask && !research.size && state.includeContext;
  const control = !fromNewTab && !browserTask && !research.size && state.control;
  const tabId = state.page?.tabId;
  const text = $('prompt').value.trim() || (state.attachments.length ? 'Review the attached files.' : '');
  const selected = selectedModel();
  if (text && !selected) {
    const connected = state.providers.some((item) => item.available && item.authenticated);
    notify(state.discoveryPending ? 'Still checking your Codex and Claude accounts. Send again in a moment.'
      : connected ? 'Choose a connected model to send this message.' : '');
    if (!state.discoveryPending) setModelMenu(true, true);
    return;
  }
  if (!text) return;
  const settings = selectedSettings(selected);
  setModelMenu(false);
  notify('');
  $('announcer').textContent = '';
  const id = crypto.randomUUID();
  const assistantId = `${id}-reply`;
  if (state.retryMessage) state.retryMessage.superseded = true;
  state.retryMessage = null;
  state.browserTask = null;
  state.newTabDraft = null;
  const history = requestHistory();
  if (browserTask === 'theme') {
    const previous = state.messages.findLast(message => message.themeProposal)?.themeProposal;
    if (previous) history.push({ role: 'assistant', content: `Previous theme proposal (design data):\n${previous.name} ${previous.theme} ${previous.colorMode}\n${previous.image ? 'Uses an attached image as the background.\n' : ''}${previous.html || ''}` });
  }
  const userMessage = { id, role: 'user', text, attachments: state.attachments, contextTitle: BROWSER_TASKS[browserTask]?.label ?? (research.size ? [...research.selected.values()].map((tab, index) => `[S${index + 1}] ${maskSecrets(tab.title)}`).join(' · ') : includeContext ? state.page?.title || 'Current page' : '') };
  const assistantMessage = { id: assistantId, role: 'assistant', text: '' };
  state.messages.push(userMessage, assistantMessage);
  appendMessage(userMessage);
  appendMessage(assistantMessage);
  state.running = {
    id, assistantId, browserTask, control,
    ...(browserTask === 'theme' ? { themeImages: themeReferenceImages(state.attachments, history).map(file => file.image) } : {}),
    // Resolve once while messages only append; retain first-match behavior for duplicate IDs.
    message: state.messages.find((item) => item.id === assistantId),
  };
  state.attachments = [];
  renderAttachments();
  $('prompt').value = '';
  resizePrompt();
  $('activity').hidden = false;
  activityLabel(state.running.control ? 'Getting ready to help' : 'Thinking');
  updateControls();
  scrollToBottom();
  let sources, pdfView;
  if (research.size) {
    // Start before awaiting anything so native sees the user's send gesture.
    post({ type: 'research-begin', id, sources: [...research.selected.values()].map(tab => ({ tabId: tab.tabId, documentId: tab.documentId, expectedUrl: tab.url })) });
    const capture = research.capture();
    try {
      sources = await capture;
      if (state.running?.id !== id) return;
      research.markUnavailable(sources);
      const summary = sources.map(source => `[${source.sourceId}] ${source.title || 'Source'} (${source.url}): ${source.status === 'available' ? `${source.capturedCharacters} characters${source.truncated ? ', truncated' : ''}` : source.error}`).join('\n');
      userMessage.contextTitle = summary;
      userMessage.sourceMetadata = sources.map(({ sourceId, title, url, status, capturedCharacters, truncated, error }) => ({ sourceId, title, url, status, capturedCharacters, truncated, error }));
      assistantMessage.citations = userMessage.sourceMetadata;
      const meta = messageNodes.get(id)?.closest('.message').querySelector('.context-meta');
      if (meta) renderSourceMetadata(meta, userMessage.sourceMetadata);
      if (!sources.some(source => source.status === 'available' && source.text)) throw new Error('No selected source text is available. Select loaded tabs and try again.');
    } catch (error) {
      if (state.running?.id === id) fail(error.message, `Could not read selected sources. ${error.message}`);
      return;
    }
  } else if (includeContext || control) {
    try {
      // Start both eligible capture paths in the original Send gesture. The
      // native PDF path captures only this document's visible surface.
      const expectsPdf = state.page?.pdf;
      const pdf = !control && typeof chrome.breezerPrivate?.captureCurrentPdfContext === 'function'
        ? chrome.breezerPrivate.captureCurrentPdfContext(tabId) : null;
      const allowed = !expectsPdf
        ? chrome.breezerPrivate.authorizeCurrentPage().catch(() => false) : false;
      const captured = await pdf;
      if (state.running?.id !== id) return;
      if (captured?.isPdf) {
        if (!captured.imageDataUrl) throw new Error('Scroll to the PDF content and try again.');
        pdfView = captured.imageDataUrl;
      } else if (!await allowed) {
        throw new Error(expectsPdf ? 'The PDF changed. Open its page and try again.' : 'This tab cannot be shared. Send without page context or attach a file.');
      }
      if (state.running?.id !== id) return;
    } catch (error) {
      if (state.running?.id !== id) return;
      fail(error.message, `Could not access this page. ${error.message}`);
      return;
    }
  }
  const sent = post({
    type: 'chat', id, provider: selected.provider.id, model: selected.model.id,
    ...(settings.reasoning ? { reasoning: settings.reasoning } : {}),
    ...(selected.provider.id === 'codex' ? { speed: settings.speed } : {}),
    message: text, attachments: userMessage.attachments, history, profile: state.profile,
    contextTitle: userMessage.contextTitle, includeContext, control,
    ...(includeContext || control ? { tabId } : {}),
    ...(browserTask ? { browserTask } : {}),
    ...(sources ? { researchSources: sources } : {}),
    ...(pdfView ? { pdfView } : {}),
  });
  if (sent && state.running?.id === id) state.running.submitted = true;
  if (!sent) offerRetry({ id, assistantId, browserTask, control: false });
}

function restoreTurn({ id, user, text, browserTask, terminal, themeImage, stats }) {
  const assistantId = `${id}-reply`;
  if (state.running?.id === id) {
    if (stats) receive({ type: 'browser-stats', id, stats });
    state.running.message.text = text;
    renderDelta();
  } else {
    if (state.running) return;
    if (messageNodes.has(assistantId)) {
      if (terminal) post({ type: 'turn-saved', id });
      return;
    }
    const message = { id: assistantId, role: 'assistant', text: '', citations: user.sourceMetadata, stats };
    if (!messageNodes.has(id)) {
      state.messages.push(user);
      appendMessage(user);
    }
    state.messages.push(message);
    appendMessage(message);
    message.text = text;
    setControl(false);
    state.running = { id, assistantId, browserTask, control: false, submitted: true, message };
    $('activity').hidden = false;
    activityLabel('Thinking');
    updateControls();
    if (text && !terminal) renderDelta();
    scrollToBottom();
  }
  if (terminal) receive({ ...terminal, themeImage });
}

function receive(message) {
  if (message.type === 'turn-state') return restoreTurn(message);
  if (message.type === 'research-invalidated') { research.invalidate(message.tabId, message.reason, !state.running?.submitted); return; }
  if (message.type === 'status') {
    acceptProviders(message.providers);
    sendNewTabDraft();
    return;
  }
  if (message.type === 'context') return setPage(message.context);
  if (message.id && message.id !== state.running?.id) return;
  if (message.type === 'browser-stats' && state.running && !state.running.message.stats) {
    state.running.message.stats = message.stats;
    renderStats(messageNodes.get(state.running.assistantId), message.stats);
    scrollToBottom();
  } else if (message.type === 'error') {
    const discoveryFailed = state.discoveryPending && !message.id;
    state.discoveryPending = false;
    const reason = typeof message.error === 'string' ? message.error : 'The provider ended the reply without a reason.';
    if (discoveryFailed) {
      state.modelRefreshQueued = false;
      applyModelSelection(state.preferredModel);
    }
    if (!state.running) return notify(reason);
    const completedId = state.running.submitted && !state.running.control ? message.id : undefined;
    if (message.source === 'theme') {
      state.running.message.text = '';
      fail(reason, reason, completedId);
    } else {
      fail(reason, message.source === 'browser-control' ? 'Browser control stopped.' : providerFailureSummary(reason), completedId);
    }
  } else if (message.type === 'delta' && state.running) {
    const reply = state.running.message;
    reply.text += message.text || '';
    renderDelta();
  } else if (message.type === 'complete') {
    const run = state.running;
    if (!run) return;
    const completedId = run.submitted && !run.control ? run.id : undefined;
    const empty = run && !run.message.text;
    if (!message.cancelled && run.browserTask === 'theme' && message.themeProposal) {
      try {
        const { name, theme, colorMode, html, imageAttachment } = message.themeProposal;
        const image = message.themeImage ?? run.themeImages?.[imageAttachment - 1];
        if (imageAttachment !== undefined && (!Number.isInteger(imageAttachment) || !image)) {
          throw new Error('This theme referred to an image that wasn’t attached.');
        }
        run.message.themeProposal = normalizeThemeProposal({ name, theme, colorMode, html, image });
      }
      catch (error) { return fail(error.message, 'Breezer could not preview this theme.', completedId); }
    }
    const hasPreview = Boolean(run.message?.themeProposal);
    const hasResult = hasPreview || Boolean(run.message.stats);
    finish(message.cancelled ? 'Stopped.' : hasPreview ? 'Theme ready to preview.' : hasResult ? 'Browser stats measured.' : 'The provider returned no response.', !message.cancelled, completedId);
    if (empty && !message.cancelled && !hasResult) offerRetry(run);
  }
  else if (message.type === 'activity' && state.running) {
    $('activity').hidden = !message.active;
    activityLabel(message.label || 'Working in this tab');
  }
}

function resizePrompt() {
  $('prompt').style.height = 'auto';
  $('prompt').style.height = `${Math.min(160, Math.max(24, $('prompt').scrollHeight))}px`;
  updateControls();
}

function renderAttachments() {
  $('attachment-list').replaceChildren(...state.attachments.map((file, index) => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    const label = document.createElement('span');
    label.textContent = file.name;
    label.title = file.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${file.name}`);
    remove.addEventListener('click', () => {
      state.attachments.splice(index, 1);
      renderAttachments();
      updateControls();
    });
    chip.append(label, remove);
    return chip;
  }));
}

async function attachFiles(files, { pasted = false } = {}) {
  if (state.running || state.readingFiles) return;
  const generation = state.fileGeneration;
  state.readingFiles = true;
  updateControls();
  const errors = [];
  try {
    for (const file of files) {
      if (generation !== state.fileGeneration) break;
      try {
        if (state.attachments.length >= 4) throw new Error('Attach up to four files per message.');
        const attachment = await readAttachment(pasted ? await preparePastedImage(file) : file, { validatedImage: pasted });
        if (generation !== state.fileGeneration) break;
        const prior = requestHistory().flatMap(message => message.attachments || []);
        if ([...prior, ...state.attachments, attachment].reduce((sum, item) => sum + attachmentSize(item), 0) > MAX_ATTACHMENT_TOTAL) throw new Error('This conversation has 2 MB of files. Start a new conversation to attach more.');
        state.attachments.push(attachment);
      } catch (error) { errors.push(`${file.name}: ${error.message}`); }
    }
  } finally {
    state.readingFiles = false;
    renderAttachments();
    updateControls();
    if (generation === state.fileGeneration) notify(errors.join(' '));
  }
}
$('attach-files').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', () => {
  const files = [...$('file-input').files];
  $('file-input').value = '';
  void attachFiles(files);
});
$('composer').addEventListener('dragover', event => {
  if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = state.running ? 'none' : 'copy'; }
});
$('composer').addEventListener('drop', event => {
  event.preventDefault();
  void attachFiles([...event.dataTransfer.files]);
});

$('composer').addEventListener('submit', (event) => { event.preventDefault(); send(); });
$('prompt').addEventListener('input', () => {
  if (!$('prompt').value.trim() && state.browserTask === '') state.browserTask = null;
  resizePrompt();
});
$('prompt').addEventListener('paste', event => {
  const images = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/'));
  if (!images.length) return;
  event.preventDefault();
  void attachFiles(images, { pasted: true });
});
$('prompt').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!state.running) send();
  }
});
$('close-panel').addEventListener('click', async () => {
  if (state.running?.control) stop();
  try { await chrome.sidePanel.close({ windowId: state.windowId }); }
  catch (error) { notify(error.message); }
});
$('dismiss-notice').addEventListener('click', () => notify(''));
$('browser-task-open').addEventListener('click', async () => {
  $('browser-theme-status').hidden = true;
  $('browser-theme-restore').hidden = true;
  $('browser-task-dialog').showModal();
  const theme = await readThemeState().catch(() => null);
  $('browser-theme-restore').hidden = !theme?.canRestore;
});
$('browser-task-close').addEventListener('click', () => $('browser-task-dialog').close());
$('browser-theme-restore').addEventListener('click', async () => {
  const button = $('browser-theme-restore');
  const status = $('browser-theme-status');
  button.disabled = true;
  try {
    const { restored } = await restorePreviousLook();
    button.hidden = true;
    status.textContent = restored ? 'Restored your previous look.' : 'There’s no previous look to restore.';
  } catch (error) {
    status.textContent = `Couldn’t restore the theme. ${error.message}`;
  } finally {
    button.disabled = false;
    status.hidden = false;
  }
});
$('browser-task-clear').addEventListener('click', () => {
  state.browserTask = '';
  updateControls();
  $('prompt').focus();
});
document.querySelectorAll('[data-browser-task]').forEach(button => button.addEventListener('click', () => {
  research.clear();
  setControl(false);
  notify('');
  state.browserTask = button.dataset.browserTask;
  $('browser-task-dialog').close();
  if (!$('prompt').value.trim()) $('prompt').value = BROWSER_TASKS[state.browserTask].prompt;
  resizePrompt();
  $('prompt').focus();
}));
$('context-toggle').addEventListener('click', () => {
  state.includeContext = !state.includeContext;
  if (!state.includeContext) setControl(false);
  if (state.includeContext) post({ type: 'context' });
  updateControls();
});
$('control-toggle').addEventListener('click', () => {
  $('control-toggle').dataset.tipDismissed = 'true';
  setControl(!state.control);
  notify(state.control ? 'Breezer can click, type, scroll, and navigate in this tab until you turn this off. It cannot use other tabs or apps. Press Stop or Escape to take over.' : '');
  updateControls();
});
const resetControlTip = () => {
  if (!$('control-toggle').matches(':hover, :focus-visible')) delete $('control-toggle').dataset.tipDismissed;
};
for (const type of ['pointerleave', 'blur']) $('control-toggle').addEventListener(type, resetControlTip);
$('control-toggle').addEventListener('keydown', event => {
  if (event.key === 'Escape') $('control-toggle').dataset.tipDismissed = 'true';
});
document.querySelectorAll('[data-prompt]').forEach((button) => button.addEventListener('click', () => {
  state.browserTask = null;
  $('prompt').value = button.dataset.prompt;
  if (button.dataset.control && state.page) {
    setControl(true);
    notify('Browser control is on for this tab. Describe the task, then send.');
  }
  resizePrompt();
  $('prompt').focus();
}));
$('new-chat').addEventListener('click', () => {
  stop();
  research.clear();
  state.retryMessage = null;
  state.browserTask = null;
  state.fileGeneration++;
  state.attachments = [];
  renderAttachments();
  state.messages = [];
  lastContextTitle = null;
  messageNodes.clear();
  for (const card of themeCards) card.destroy();
  themeCards.clear();
  $('messages').replaceChildren();
  $('welcome').hidden = false;
  setControl(false);
  notify('');
  updateControls();
  saveConversation();
  post({ type: 'clear-turn' });
  post({ type: 'context' });
  $('prompt').focus();
});
$('model-button').addEventListener('click', (event) => setModelMenu($('model-menu').hidden, event.detail === 0));
$('close-model-menu').addEventListener('click', dismissModelMenu);
// Arrows move between search and the model list; typing on a model searches.
$('model-menu').addEventListener('keydown', (event) => {
  const search = $('model-search');
  if (event.target.closest('#model-options') && event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    search.focus();
    search.value += event.key;
    search.dispatchEvent(new Event('input'));
    return;
  }
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  const options = [search, ...$('model-options').querySelectorAll('.model-option:not(:disabled), .account-connect')].filter(node => node.checkVisibility());
  const index = options.indexOf(document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  options[(index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length].focus();
});
$('model-search').addEventListener('input', () => {
  state.modelQuery = $('model-search').value;
  renderModels();
});
$('model-search').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    $('model-options').querySelector('.model-option:not(:disabled)')?.click();
  } else if (event.key === 'Escape' && $('model-search').value) {
    // The first Escape clears a search; the next closes the picker.
    event.preventDefault();
    event.stopPropagation();
    $('model-search').value = '';
    state.modelQuery = '';
    renderModels();
  }
});
$('model-menu').addEventListener('focusout', (event) => {
  if (event.relatedTarget && !$('model-menu').contains(event.relatedTarget) && event.relatedTarget !== $('model-button')) setModelMenu(false);
});
$('draft-toggle').addEventListener('click', () => {
  const open = document.querySelector('.panel').toggleAttribute('data-drafting');
  $('draft-toggle').textContent = open ? 'Hide draft' : 'Write a draft';
  $('draft-toggle').setAttribute('aria-expanded', String(open));
  if (open) $('prompt').focus();
});
$('welcome-action').addEventListener('click', () => {
  if (state.providers.some((item) => item.available && item.authenticated)) setModelMenu(true, true);
  else if (!$('welcome-account-steps').open) {
    $('welcome-account-steps').open = true;
    $('welcome-account-steps').querySelector('summary').focus();
    renderWelcomeStatus(selectedModel());
  }
  else refreshModels();
});
$('welcome-account-steps').addEventListener('toggle', () => renderWelcomeStatus(selectedModel()));
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-copy-command]');
  if (!button) return;
  const command = button.parentElement.querySelector('code');
  try {
    await navigator.clipboard.writeText(command.textContent);
    button.textContent = 'Copied';
    const feedback = button.parentElement.querySelector('.copy-feedback');
    if (feedback) feedback.remove();
    $('announcer').textContent = 'Sign-in command copied.';
  } catch {
    selectText(command);
    button.textContent = 'Copy';
    let feedback = button.parentElement.querySelector('.copy-feedback');
    if (!feedback) {
      feedback = document.createElement('small');
      feedback.className = 'copy-feedback';
      feedback.setAttribute('role', 'status');
      button.parentElement.append(feedback);
    }
    feedback.textContent = 'Use your keyboard to copy.';
  }
});
$('close-account').addEventListener('click', () => $('account-dialog').close());
$('account-dialog').addEventListener('close', () => $('model-button').focus());
$('refresh-accounts').addEventListener('click', () => { $('account-dialog').close(); refreshModels(); });
$('inference-options').addEventListener('change', saveSettings);
$('refresh-models').addEventListener('click', refreshModels);
document.addEventListener('click', (event) => {
  if (!$('model-menu').contains(event.target) && !$('model-button').contains(event.target)) setModelMenu(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!$('model-menu').hidden) dismissModelMenu();
    else if (state.running) stop();
  }
});
document.addEventListener('visibilitychange', () => {
  if (state.port) post({ type: 'visibility', visible: !document.hidden });
  if (document.hidden) {
    if (state.running?.control) stop();
    setControl(false);
    research.clear(undefined, !state.running?.submitted);
  }
  else if (state.port) { revealPanel(); post({ type: 'context' }); }
});
$('open-profile').addEventListener('click', () => {
  $('profile-name').value = state.profile.name;
  $('profile-context').value = state.profile.context;
  $('profile-dialog').showModal();
});
$('close-profile').addEventListener('click', () => $('profile-dialog').close());
$('profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.profile = { name: $('profile-name').value.trim().slice(0, 80), context: $('profile-context').value.trim().slice(0, 6000) };
  try {
    await chrome.storage.local.set({ breezerProfile: state.profile });
    applyProfile();
    $('profile-dialog').close();
  } catch { notify('Your context could not be saved. Please try again.'); }
});

// Settings and other windows can update the choice while this panel is open.
localStorageChanges(chrome).addListener((changes) => {
  const profile = changes.breezerProfile?.newValue;
  if (profile && typeof profile.name === 'string' && typeof profile.context === 'string') { state.profile = profile; applyProfile(); }
  if (MODEL_KEY in changes) {
    modelChangeObserved = true;
    const value = preferredModel(changes[MODEL_KEY].newValue);
    if (value?.model === state.preferredModel?.model && value?.provider === state.preferredModel?.provider) return;
    state.modelRefreshQueued = Boolean(value && !connectedModel(state.providers, value));
    applyModelSelection(value);
    refreshQueuedModel();
  }
});

function sendNewTabDraft() {
  const draft = state.newTabDraft;
  if (!draft || Date.now() - draft.createdAt > HANDOFF_TTL_MS || !selectedModel()
      || state.running || state.attachments.length || research.size
      || $('prompt').value.trim() !== draft.prompt) return;
  void send();
}

function listenForNewTabAsk() {
  const area = chrome.storage.session;
  if (typeof area?.remove !== 'function' || typeof chrome.tabs?.query !== 'function') return;
  const key = handoffKey(state.windowId);
  const take = async () => {
    if (document.hidden || state.running || $('prompt').value || state.attachments.length || research.size) return;
    const draft = (await area.get(key))[key];
    const age = Date.now() - draft?.createdAt;
    if (draft?.source !== 'newtab' || !Number.isFinite(age) || age < 0 || age > HANDOFF_TTL_MS
        || typeof draft.prompt !== 'string' || !draft.prompt.trim() || draft.prompt.length > 24_000
        || !Number.isInteger(draft.tabId)) return;
    if (!(await readExperiments(chrome)).newTabComposer) return;
    const [tab] = await chrome.tabs.query({ active: true, windowId: state.windowId });
    if (tab?.id !== draft.tabId || tab.incognito || document.hidden || state.running || $('prompt').value) return;
    if ((await area.get(key))[key]?.createdAt !== draft.createdAt) return;
    await area.remove(key);
    state.newTabDraft = draft;
    state.newTabChatId = draft.tabId;
    document.documentElement.dataset.newTabChat = 'true';
    setControl(false);
    $('prompt').value = draft.prompt;
    resizePrompt();
    sendNewTabDraft();
  };
  const refresh = () => {
    const locks = navigator.locks;
    void (locks ? locks.request(key, take) : take()).catch(() => {});
  };
  const onChange = changes => { if (changes[key]?.newValue) refresh(); };
  area.onChanged?.addListener(onChange);
  document.addEventListener('visibilitychange', refresh);
  addEventListener('pagehide', () => {
    area.onChanged?.removeListener(onChange);
    document.removeEventListener('visibilitychange', refresh);
  }, { once: true });
  refresh();
}

async function initialize() {
  try {
    const [saved, currentWindow] = await Promise.all([
      chrome.storage.local.get(['breezerProfile', MODEL_KEY, 'breezerModelPreferences']),
      chrome.windows.getCurrent(),
    ]);
    if (saved.breezerProfile && typeof saved.breezerProfile.name === 'string' && typeof saved.breezerProfile.context === 'string') state.profile = saved.breezerProfile;
    if (!modelChangeObserved) state.preferredModel = preferredModel(saved[MODEL_KEY]);
    if (saved.breezerModelPreferences && typeof saved.breezerModelPreferences === 'object' && !Array.isArray(saved.breezerModelPreferences)) state.preferences = saved.breezerModelPreferences;
    state.windowId = currentWindow.id;
    state.sessionKey = `breezer-conversation-${currentWindow.id}`;
    const session = await chrome.storage.session.get(state.sessionKey);
    if (Array.isArray(session[state.sessionKey])) {
      state.messages = session[state.sessionKey].filter((item) => ['user', 'assistant'].includes(item.role) && typeof item.text === 'string').slice(-60);
      state.messages.forEach(appendMessage);
    }
    applyProfile();
    state.port = chrome.runtime.connect({ name: 'breezer-panel' });
    state.port.onMessage.addListener(receive);
    state.port.onDisconnect.addListener(() => {
      state.port = null;
      notify('The assistant disconnected. Reopen it with ⌘ K to reconnect.');
      finish();
    });
    post({ type: 'init', windowId: state.windowId });
    post({ type: 'visibility', visible: !document.hidden });
    post({ type: 'context' });
    listenForNewTabAsk();
    updateControls();
    scrollToBottom();
    revealPanel();
    $('prompt').focus();
  } catch (error) {
    notify(`Could not open the assistant: ${error.message}`);
  }
}

void startPanelTheme();
const stopPersonalityLook = startPersonalityLook();
addEventListener('pagehide', stopPersonalityLook, { once: true });
initialize();
