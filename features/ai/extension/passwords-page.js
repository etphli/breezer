import { mountPasswords } from './passwords.js';

const dark = matchMedia('(prefers-color-scheme: dark)');
const applyScheme = () => { document.documentElement.dataset.scheme = dark.matches ? 'dark' : 'light'; };
applyScheme();
dark.addEventListener('change', applyScheme);
const passwords = mountPasswords({ container: document.getElementById('passwords') });
if (location.hash === '#import') passwords.showImport();
addEventListener('hashchange', () => {
  if (location.hash === '#import') passwords.showImport();
});
