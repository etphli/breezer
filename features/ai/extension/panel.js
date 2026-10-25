import { renderMessage } from './render-message.js';

const $ = (id) => document.getElementById(id);
const state = {
  profile: { name: 'Ethan', context: '' },
  providers: [],
  discoveryPending: true,
  selection: null,
  preferences: {},
  messages: [],
  includeContext: true,
  control: false,
  running: null,
  page: null,
  port: null,
  sessionKey: 'breezer-conversation',
  windowId: null,
};
const messageNodes = new Map();
let scheduledRender = false;

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
    finish();
    return false;
  }
}

function selectedModel() {
  const provider = state.providers.find((item) => item.id === state.selection?.provider);
  const model = provider?.models?.find((item) => item.id === state.selection?.model);
  return provider?.available && provider?.authenticated && model ? { provider, model } : null;
}

function selectedSettings(selected = selectedModel()) {
  if (!selected) return { reasoning: '', speed: 'standard' };
  const { provider, model } = selected;
  const saved = state.preferences[`${provider.id}:${model.id}`];
  const levels = model.reasoningEfforts || [];
  const fallback = levels.includes('high') ? 'high' : levels.includes(model.defaultReasoningEffort) ? model.defaultReasoningEffort : '';
  return {
    reasoning: saved?.reasoning === '' || levels.includes(saved?.reasoning) ? saved.reasoning : fallback,
    speed: model.speeds?.includes('fast') && saved?.speed === 'fast' ? 'fast' : 'standard',
  };
}

function renderSettings(selected, running) {
  const settings = selectedSettings(selected);
  const levels = selected?.model.reasoningEfforts || [];
  const reasoning = $('reasoning-select');
  reasoning.replaceChildren(new Option('Default', ''));
  for (const level of levels) {
    const label = ({ xhigh: 'Extra high' })[level] || level.charAt(0).toUpperCase() + level.slice(1);
    reasoning.add(new Option(label, level));
  }
  reasoning.value = settings.reasoning;
  reasoning.disabled = running || !levels.length;
  reasoning.parentElement.title = levels.length ? 'Reasoning effort' : 'This model does not report adjustable reasoning effort';
  const codex = selected?.provider.id === 'codex';
  $('speed-setting').hidden = !codex;
  const speed = $('speed-select');
  speed.replaceChildren(new Option('Standard', 'standard'));
  const fast = new Option('Fast', 'fast');
  fast.title = 'Higher usage; account eligibility is checked when you send';
  fast.disabled = !selected?.model.speeds?.includes('fast');
  speed.add(fast);
  speed.value = settings.speed;
  speed.disabled = running || !codex;
  $('speed-setting').title = fast.disabled ? 'Fast is not available for this model and CLI' : 'Fast uses more of your Codex allowance. Account eligibility is checked when you send.';
}

function saveSettings() {
  const selected = selectedModel();
  if (!selected || state.running) return;
  state.preferences[`${selected.provider.id}:${selected.model.id}`] = {
    reasoning: $('reasoning-select').value,
    ...(selected.provider.id === 'codex' ? { speed: $('speed-select').value } : {}),
  };
  chrome.storage.local.set({ breezerModelPreferences: state.preferences }).catch(() => notify('Your model preferences could not be saved.'));
  updateControls();
}

function updateControls() {
  const running = Boolean(state.running);
  $('send').disabled = !running && (!selectedModel() || !$('prompt').value.trim());
  $('send').dataset.running = String(running);
  $('send').setAttribute('aria-label', running ? 'Stop response' : 'Send message');
  $('send').title = running ? 'Stop response' : 'Send message';
  $('send-arrow').toggleAttribute('hidden', running);
  $('send-stop').hidden = !running;
  $('control-toggle').disabled = running || !state.page;
  $('context-toggle').disabled = running || !state.page;
  $('control-toggle').setAttribute('aria-pressed', String(state.control));
  $('context-toggle').setAttribute('aria-pressed', String(state.includeContext));
  $('context-check').hidden = !state.includeContext;
  $('context-hint').textContent = state.includeContext ? 'Page + screenshot' : 'Page not shared';
  $('prompt').placeholder = state.includeContext ? 'Ask about this page…' : 'Ask anything…';
  const selected = selectedModel();
  $('model-label').textContent = selected ? selected.model.label || selected.model.id : state.discoveryPending ? 'Connecting your accounts' : 'Choose a connected model';
  $('provider-dot').classList.toggle('connected', Boolean(selected));
  $('model-button').title = selected ? `${providerLabel(selected.provider.id)} · ${selected.model.label || selected.model.id}` : 'Choose a model';
  $('model-button').disabled = running;
  renderSettings(selected, running);
}

function providerLabel(id) {
  return id === 'codex' ? 'Codex' : id === 'claude' ? 'Claude' : id;
}

function renderModels() {
  $('model-options').replaceChildren();
  if (!state.providers.length) {
    const note = document.createElement('p');
    note.className = 'provider-error';
    note.textContent = 'Checking your local Codex and Claude accounts…';
    $('model-options').append(note);
  }
  for (const provider of state.providers) {
    const group = document.createElement('div');
    group.className = 'provider-group';
    const heading = document.createElement('div');
    heading.className = 'provider-heading';
    const name = document.createElement('span');
    name.textContent = providerLabel(provider.id);
    const status = document.createElement('span');
    status.className = 'provider-state';
    status.textContent = !provider.available ? 'Unavailable' : !provider.authenticated ? 'Sign in required' : 'Connected';
    heading.append(name, status);
    group.append(heading);
    for (const model of provider.models || []) {
      const button = document.createElement('button');
      button.className = 'model-option';
      const isSelected = state.selection?.provider === provider.id && state.selection?.model === model.id;
      button.classList.toggle('selected', isSelected);
      button.disabled = Boolean(state.running) || !provider.available || !provider.authenticated;
      button.setAttribute('aria-pressed', String(isSelected));
      const label = document.createElement('span');
      label.textContent = model.label || model.id;
      button.append(label);
      if (isSelected) {
        const check = document.createElement('span');
        check.textContent = '✓';
        check.setAttribute('aria-hidden', 'true');
        button.append(check);
      }
      button.addEventListener('click', () => {
        state.selection = { provider: provider.id, model: model.id };
        chrome.storage.local.set({ breezerModel: state.selection }).catch(() => {});
        renderModels();
        updateControls();
        setModelMenu(false);
        $('prompt').focus();
      });
      group.append(button);
    }
    if (provider.error || !provider.authenticated) {
      const error = document.createElement('p');
      error.className = 'provider-error';
      error.textContent = provider.error || `Sign in with ${provider.id === 'codex' ? 'codex login' : 'claude auth login'} in Terminal, then refresh.`;
      group.append(error);
    }
    $('model-options').append(group);
  }
}

function acceptProviders(providers) {
  state.discoveryPending = false;
  state.providers = Array.isArray(providers) ? providers : [];
  if (!selectedModel()) {
    const codex = state.providers.find((item) => item.id === 'codex' && item.available && item.authenticated);
    const provider = codex || state.providers.find((item) => item.available && item.authenticated && item.models?.length);
    const preferred = provider?.id === 'codex' && provider.models?.find((item) => item.id === 'gpt-6.1-sol');
    const fallback = provider?.models?.find((item) => item.id === provider.defaultModel) || provider?.models?.[0];
    state.selection = provider && (preferred || fallback) ? { provider: provider.id, model: (preferred || fallback).id } : null;
  }
  renderModels();
  updateControls();
}

function setModelMenu(open) {
  $('model-menu').hidden = !open;
  $('model-button').setAttribute('aria-expanded', String(open));
  if (open) renderModels();
}

function setPage(page) {
  state.page = page?.url && /^https?:\/\//i.test(page.url) ? page : null;
  if (!state.page) {
    state.includeContext = false;
    state.control = false;
  }
  let label = 'No page attached';
  if (state.page) {
    try { label = page.title || new URL(page.url).hostname; } catch { label = page.title || 'Current page'; }
  }
  $('context-title').textContent = label;
  $('context-toggle').title = state.page ? `${page.url}\nInclude this page and a screenshot with your message` : 'Include the current page and a screenshot with your message';
  updateControls();
}

function applyProfile() {
  $('greeting-name').textContent = state.profile.name.trim() || 'there';
  $('open-profile').textContent = (state.profile.name.trim()[0] || 'Y').toLocaleUpperCase();
}

function appendMessage(message) {
  const article = document.createElement('article');
  article.className = `message ${message.role}`;
  article.setAttribute('aria-label', message.role === 'user' ? 'You' : 'Breezer');
  const body = document.createElement('div');
  body.className = 'message-body';
  if (message.role === 'assistant') {
    const heading = document.createElement('div');
    heading.className = 'assistant-heading';
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
  article.append(body);
  if (message.contextTitle) {
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.textContent = message.contextTitle;
    article.append(meta);
  }
  $('messages').append(article);
  messageNodes.set(message.id, body);
  $('welcome').hidden = true;
  return body;
}

function saveConversation() {
  const messages = state.messages.filter((item) => item.text).slice(-60);
  return chrome.storage.session.set({ [state.sessionKey]: messages }).catch(() => {});
}

function scrollToBottom() {
  $('conversation').scrollTop = $('conversation').scrollHeight;
}

function renderDelta() {
  if (scheduledRender) return;
  scheduledRender = true;
  requestAnimationFrame(() => {
    scheduledRender = false;
    const message = state.messages.find((item) => item.id === state.running?.assistantId);
    const body = message && messageNodes.get(message.id);
    if (!body) return;
    const scroller = $('conversation');
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100;
    renderMessage(body, message.text);
    if (atBottom) scrollToBottom();
  });
}

function finish(label) {
  if (state.running) {
    const message = state.messages.find((item) => item.id === state.running.assistantId);
    if (message && !message.text) {
      message.text = label || 'Response stopped.';
      renderMessage(messageNodes.get(message.id), message.text);
    } else if (message) renderMessage(messageNodes.get(message.id), message.text);
  }
  state.running = null;
  state.control = false;
  $('activity').hidden = true;
  updateControls();
  saveConversation();
}

function stop() {
  if (!state.running) return;
  post({ type: 'cancel', id: state.running.id });
  finish('Stopped.');
}

async function send() {
  if (state.running) return stop();
  const text = $('prompt').value.trim();
  const selected = selectedModel();
  if (!text || !selected) return;
  const settings = selectedSettings(selected);
  setModelMenu(false);
  notify('');
  const id = crypto.randomUUID();
  const assistantId = `${id}-reply`;
  const history = state.messages.filter((item) => item.text).slice(-30).map(({ role, text: content }) => ({ role, content }));
  const userMessage = { id, role: 'user', text, contextTitle: state.includeContext ? state.page?.title || 'Current page' : '' };
  const assistantMessage = { id: assistantId, role: 'assistant', text: '' };
  state.messages.push(userMessage, assistantMessage);
  appendMessage(userMessage);
  appendMessage(assistantMessage);
  state.running = { id, assistantId };
  $('prompt').value = '';
  resizePrompt();
  $('activity').hidden = false;
  $('activity-label').textContent = state.control ? 'Getting ready to help' : 'Thinking';
  updateControls();
  scrollToBottom();
  const sent = post({
    type: 'chat', id, provider: selected.provider.id, model: selected.model.id,
    ...(settings.reasoning ? { reasoning: settings.reasoning } : {}),
    ...(selected.provider.id === 'codex' ? { speed: settings.speed } : {}),
    message: text, history, profile: state.profile,
    includeContext: state.includeContext, control: state.control,
  });
  if (!sent) finish('Could not connect.');
}

function receive(message) {
  if (message.type === 'status') return acceptProviders(message.providers);
  if (message.type === 'context') return setPage(message.context);
  if (message.id && message.id !== state.running?.id) return;
  if (message.type === 'error') {
    state.discoveryPending = false;
    notify(typeof message.error === 'string' ? message.error : 'Something went wrong. Try again.');
    finish('Could not finish this response.');
  } else if (message.type === 'delta' && state.running) {
    const reply = state.messages.find((item) => item.id === state.running.assistantId);
    reply.text += message.text || '';
    renderDelta();
  } else if (message.type === 'complete') finish();
  else if (message.type === 'activity' && state.running) {
    $('activity').hidden = !message.active;
    $('activity-label').textContent = message.label || 'Working in this tab';
  }
}

function resizePrompt() {
  $('prompt').style.height = 'auto';
  $('prompt').style.height = `${Math.min(160, Math.max(53, $('prompt').scrollHeight))}px`;
  updateControls();
}

$('composer').addEventListener('submit', (event) => { event.preventDefault(); send(); });
$('prompt').addEventListener('input', resizePrompt);
$('prompt').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!state.running) send();
  }
});
$('activity-stop').addEventListener('click', stop);
$('dismiss-notice').addEventListener('click', () => notify(''));
$('context-toggle').addEventListener('click', () => {
  state.includeContext = !state.includeContext;
  if (!state.includeContext) state.control = false;
  if (state.includeContext) post({ type: 'context' });
  updateControls();
});
$('control-toggle').addEventListener('click', () => {
  state.control = !state.control;
  if (state.control) {
    state.includeContext = true;
    notify('Breezer can click, type, and scroll in this tab during your next request. Press Stop or Escape to take over.');
  } else notify('');
  updateControls();
});
document.querySelectorAll('[data-prompt]').forEach((button) => button.addEventListener('click', () => {
  $('prompt').value = button.dataset.prompt;
  if (button.dataset.control) {
    state.control = true;
    state.includeContext = true;
    notify('Browser control is on for your next request. Describe the task, then send.');
  }
  resizePrompt();
  $('prompt').focus();
}));
$('new-chat').addEventListener('click', () => {
  stop();
  state.messages = [];
  messageNodes.clear();
  $('messages').replaceChildren();
  $('welcome').hidden = false;
  state.control = false;
  notify('');
  updateControls();
  saveConversation();
  post({ type: 'context' });
  $('prompt').focus();
});
$('model-button').addEventListener('click', () => setModelMenu($('model-menu').hidden));
$('reasoning-select').addEventListener('change', saveSettings);
$('speed-select').addEventListener('change', () => {
  saveSettings();
  notify($('speed-select').value === 'fast' ? 'Fast uses more of your Codex allowance. Availability depends on your account.' : '');
});
$('refresh-models').addEventListener('click', () => {
  state.discoveryPending = true;
  updateControls();
  post({ type: 'init', windowId: state.windowId });
});
document.addEventListener('click', (event) => {
  if (!$('model-menu').contains(event.target) && !$('model-button').contains(event.target)) setModelMenu(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!$('model-menu').hidden) { setModelMenu(false); $('model-button').focus(); }
    else if (state.running) stop();
  }
});
document.addEventListener('visibilitychange', () => {
  if (state.port) post({ type: 'visibility', visible: !document.hidden });
  if (document.hidden) stop();
  else if (state.port) post({ type: 'context' });
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

async function initialize() {
  try {
    const [saved, currentWindow] = await Promise.all([
      chrome.storage.local.get(['breezerProfile', 'breezerModel', 'breezerModelPreferences']),
      chrome.windows.getCurrent(),
    ]);
    if (saved.breezerProfile && typeof saved.breezerProfile.name === 'string' && typeof saved.breezerProfile.context === 'string') state.profile = saved.breezerProfile;
    state.selection = saved.breezerModel || null;
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
    updateControls();
    scrollToBottom();
    $('prompt').focus();
  } catch (error) {
    notify(`Could not open the assistant: ${error.message}`);
  }
}

initialize();
