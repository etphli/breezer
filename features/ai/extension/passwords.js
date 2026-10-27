// Passwords stay in the native manager. This component only opens browser pages.
export const PASSWORD_ROUTES = Object.freeze({
  manager: 'chrome://password-manager/passwords',
  settings: 'chrome://password-manager/settings',
  import: 'chrome://password-manager/settings?import=true',
  browserImport: 'chrome://settings/importData',
});

export const CHROME_EXPORT_HELP = 'https://support.google.com/chrome/answer/13068232?hl=en';

export function createPasswordActions({ api = globalThis.chrome } = {}) {
  return Object.freeze({
    async open(destination) {
      if (!Object.hasOwn(PASSWORD_ROUTES, destination)) throw new Error('Unknown password page.');
      if (!api?.tabs?.create) throw new Error('Open this page in Breezer to continue.');
      // Never interpret opening a tab as proof that import completed.
      await api.tabs.create({ url: PASSWORD_ROUTES[destination], active: true });
    },
  });
}

// Mount into an empty settings section. Existing settings classes supply styles.
// onOpened receives only a destination key, never credentials or an import result.
export function mountPasswords({ container, api = globalThis.chrome, onOpened = () => {} }) {
  const doc = container.ownerDocument;
  const actions = createPasswordActions({ api });
  const events = new AbortController();
  let disposed = false;
  let pending = false;
  const node = (tag, text, className) => {
    const element = doc.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  };

  const section = node('section', '', 'settings-section');
  section.dataset.passwords = '';
  section.setAttribute('aria-label', 'Passwords');
  section.append(
    node('h2', 'Passwords'),
    node('p', 'Save and autofill passwords in this Breezer profile. Imported passwords are stored locally using the browser\'s encrypted password store.', 'section-note'),
    node('p', 'Chrome and Breezer use separate profiles. Import copies passwords once; it does not sync later changes.', 'section-note'),
  );

  const status = node('p', '', 'section-note');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const error = node('p', '', 'field-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const controls = [];
  function button(label, destination) {
    const control = node('button', label, 'text-button');
    control.type = 'button';
    control.dataset.passwordAction = destination;
    controls.push(control);
    control.addEventListener('click', async () => {
      if (pending || disposed) return;
      pending = true;
      for (const item of controls) item.disabled = true;
      error.hidden = true;
      status.textContent = '';
      try {
        await actions.open(destination);
      } catch {
        if (!disposed) {
          error.textContent = 'Could not open the native password page. Try again, or enter the address below in Breezer.';
          error.append(node('br'), node('code', PASSWORD_ROUTES[destination]));
          error.hidden = false;
        }
        return;
      } finally {
        pending = false;
        if (!disposed) for (const item of controls) item.disabled = false;
      }
      if (disposed) return;
      status.textContent = destination === 'import'
        ? 'Import opened in a new tab. Follow its prompts and check the import result there.'
        : 'Password manager opened in a new tab.';
      onOpened(destination);
    }, { signal: events.signal });
    return control;
  }

  section.append(button('Open password manager', 'manager'));
  section.append(node('p', 'View, edit, or delete saved passwords in the native manager. Breezer uses your Mac\'s authentication when the manager requires it. Set password saving, automatic sign-in, and authentication before filling in its Settings.', 'section-note'));
  section.append(button('Password settings', 'settings'));

  const guide = node('details');
  guide.dataset.passwordImportGuide = '';
  guide.append(node('summary', 'Import passwords from Chrome'));
  guide.append(node('p', 'This build cannot import passwords directly from Chrome\'s Keychain. Use Chrome\'s CSV export and Breezer\'s native importer.'));
  const steps = node('ol');
  for (const step of [
    'In Chrome, open the menu, then Passwords and autofill, Google Password Manager, and Settings.',
    'Under Export passwords, choose Download file. Complete Chrome\'s authentication prompt if shown.',
    'Return to Breezer and choose Import Chrome CSV below. Select the exported .csv file in the native file picker.',
    'Review any conflicts or errors in the native importer. Check the imported entries in Breezer\'s password manager.',
    'After a successful import, delete the exported CSV, including any copy in the Trash. The CSV contains readable passwords.',
  ]) steps.append(node('li', step));
  guide.append(steps);
  const help = node('a', 'Chrome export instructions');
  help.href = CHROME_EXPORT_HELP;
  help.target = '_blank';
  help.rel = 'noopener noreferrer';
  guide.append(help, node('p', 'Keep the CSV private. Do not send it to Breezer AI, attach it to feedback, or keep it in a shared folder.'));
  guide.append(button('Import Chrome CSV', 'import'));
  section.append(guide, status, error);

  if (!api?.tabs?.create) {
    for (const item of controls) item.disabled = true;
    error.textContent = 'Open this page in Breezer to use its native password manager.';
    error.hidden = false;
  }
  container.replaceChildren(section);
  return Object.freeze({
    showImport() {
      guide.open = true;
      guide.querySelector('summary').focus();
    },
    dispose() {
      disposed = true;
      events.abort();
      section.remove();
    },
  });
}
