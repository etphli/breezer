// Passwords stay in the native manager. This component only opens browser pages.
export const PASSWORD_ROUTES = Object.freeze({
  manager: 'chrome://password-manager/passwords',
  settings: 'chrome://password-manager/settings',
  import: 'chrome://password-manager/settings?import=true',
  browserImport: 'chrome://settings/importData',
  passkeys: 'chrome://settings/passkeys',
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
    node('p', 'Save, autofill, and manage passwords in Breezer. Passwords are encrypted and stored on this Mac.', 'section-note'),
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
        : destination === 'passkeys'
          ? 'Local passkey management opened in a new tab. Check availability there.'
          : 'Password manager opened in a new tab.';
      onOpened(destination);
    }, { signal: events.signal });
    return control;
  }

  section.append(button('Open password manager', 'manager'));
  section.append(node('p', 'View, edit, or delete saved passwords. Your Mac may ask you to authenticate before showing them.', 'section-note'));
  section.append(button('Password settings', 'settings'));

  section.append(
    node('h3', 'Passkeys'),
    node('p', 'Create a passkey on a website, then choose it in the browser sign-in dialog or an eligible username field. Available choices depend on the website and authenticator.', 'section-note'),
    button('Manage local passkeys', 'passkeys'),
    node('p', 'This native page lists passkeys saved by Breezer’s Mac profile authenticator. You can edit their usernames or delete them there. It does not list passkeys held by Apple Passwords, a phone, or a security key; manage those with their provider.', 'section-note'),
    node('p', 'Touch ID and Apple Passwords require signing entitlements that this build does not have. Local Mac passkeys are not available in this build. A compatible security key or another device may be offered by the native sign-in dialog. Phone sign-in needs Bluetooth and device approval.', 'section-note'),
    node('p', 'Passkeys are not included in CSV import or Breezer sync. Local Mac passkeys stay tied to the Mac and Breezer profile; they are not iCloud backups. Breezer AI cannot read or enter passkeys.', 'section-note'),
  );

  const guide = node('details');
  guide.dataset.passwordImportGuide = '';
  guide.append(node('summary', 'Import passwords from Chrome'));
  guide.append(node('p', 'Export your passwords from Chrome, then import the CSV into Breezer.'));
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
