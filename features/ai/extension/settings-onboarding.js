import { localStorageChanges } from './storage-events.js';
import { PLATFORM } from './platform.js';
// First-run card opens fixed native routes without reading import files or results.
import { createPasswordActions } from './passwords.js';

export const ONBOARDING_KEY = 'settings.onboarding.v1';

// passwords is the handle returned by mountPasswords, used to reveal its CSV guide.
export function mountOnboarding({ container, api = globalThis.chrome, passwords = null }) {
  const doc = container.ownerDocument;
  const actions = createPasswordActions({ api });
  const storage = api?.storage?.local;
  const events = new AbortController();
  let disposed = false;
  let pending = false;
  const node = (tag, text, className) => {
    const element = doc.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  };

  const section = node('section', '', 'onboarding');
  section.dataset.onboarding = '';
  section.setAttribute('aria-labelledby', 'onboarding-heading');
  section.hidden = true;

  const head = node('div', '', 'onboarding-head');
  const heading = node('h2', 'Import from another browser');
  heading.id = 'onboarding-heading';
  const hide = node('button', 'Hide', 'button subtle');
  hide.type = 'button';
  hide.dataset.onboardingAction = 'dismiss';
  hide.setAttribute('aria-label', 'Hide getting started');
  head.append(heading, hide);

  const details = node('details', '', 'setting-details onboarding-details');
  details.append(node('summary', 'Import details'), node('p', 'Importing makes a one-time copy of the data you choose.'));

  const paths = node('div', '', 'onboarding-paths');
  const status = node('p', '', 'status-line');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const error = node('p', '', 'field-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const controls = [];

  function path(title, body, control) {
    const item = node('div', '', 'onboarding-path');
    item.append(control);
    details.append(node('h3', title), node('p', body));
    paths.append(item);
  }

  const browserImport = node('button', 'Import browser data', 'button');
  browserImport.type = 'button';
  browserImport.dataset.onboardingAction = 'browserImport';
  controls.push(browserImport);
  browserImport.addEventListener('click', async () => {
    if (pending || disposed) return;
    pending = true;
    for (const item of controls) item.disabled = true;
    error.hidden = true;
    status.textContent = '';
    try {
      await actions.open('browserImport');
    } catch {
      if (!disposed) {
        error.textContent = 'Could not open the import dialog. Try again, or enter this address in Breezer: ';
        error.append(node('code', 'chrome://settings/importData'));
        error.hidden = false;
      }
      return;
    } finally {
      pending = false;
      if (!disposed) for (const item of controls) item.disabled = false;
    }
    // Opening the dialog is not an import. The user checks the result there.
    if (!disposed) status.textContent = 'Import dialog opened in a new tab. Choose what to copy and check the result there.';
  }, { signal: events.signal });
  path('Bookmarks and history',
    'Choose a listed browser or import an exported bookmarks HTML file.',
    browserImport);

  const passwordSteps = node('button', 'Show password steps', 'button');
  passwordSteps.type = 'button';
  passwordSteps.dataset.onboardingAction = 'passwords';
  controls.push(passwordSteps);
  passwordSteps.addEventListener('click', () => {
    if (disposed) return;
    status.textContent = '';
    passwords?.showImport();
    doc.querySelector('[data-password-import-guide]')?.scrollIntoView?.({ block: 'start' });
  }, { signal: events.signal });
  if (!passwords) passwordSteps.hidden = true;
  path('Passwords',
    'Use the password steps to import a CSV export from Chrome, Edge or another password manager. Passkeys are not included.',
    passwordSteps);
  if (PLATFORM === 'windows') {
    details.append(node('p', 'To import directly from Firefox, choose it in the browser data dialog and check Saved passwords if the option appears.'));
  }

  const footnote = node('p', 'Imports remain in Passwords and Browser tools.', 'field-note');
  details.append(footnote);
  section.append(head, paths, status, error, details);

  if (!api?.tabs?.create) {
    browserImport.disabled = true;
    error.textContent = 'Open this page in Breezer to use its import dialog.';
    error.hidden = false;
  }

  hide.addEventListener('click', async () => {
    if (disposed) return;
    // Read before disabling: a disabled button loses focus.
    const hadFocus = section.contains(doc.activeElement);
    hide.disabled = true;
    try {
      await storage.set({ [ONBOARDING_KEY]: { dismissed: true } });
    } catch {
      if (!disposed) {
        hide.disabled = false;
        error.textContent = 'Couldn’t save that choice. Choose Hide to try again.';
        error.hidden = false;
      }
      return;
    }
    if (disposed) return;
    section.hidden = true;
    if (hadFocus || doc.activeElement === doc.body) doc.getElementById('settings-title')?.focus();
  }, { signal: events.signal });

  // Another settings tab may hide the card too.
  const onChanged = (changes) => {
    if (!disposed && changes[ONBOARDING_KEY]?.newValue?.dismissed === true) section.hidden = true;
  };
  const storageChanges = localStorageChanges(api);
  storageChanges?.addListener(onChanged);

  container.replaceChildren(section);
  // Stay hidden until the saved choice is known so a dismissed card never flashes.
  Promise.resolve()
    .then(() => storage.get(ONBOARDING_KEY))
    .then((saved) => saved?.[ONBOARDING_KEY]?.dismissed === true, () => false)
    .then((dismissed) => { if (!disposed) section.hidden = dismissed; });

  return Object.freeze({
    dispose() {
      disposed = true;
      events.abort();
      storageChanges?.removeListener(onChanged);
      section.remove();
    },
  });
}
