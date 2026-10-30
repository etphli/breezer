// First-run setup progress, shared by the background page and workspace.html#/welcome.
// It records only which step was reached and whether setup finished; the choices
// themselves live in their usual places (native appearance, breezerProfile, Keychain).
export const SETUP_KEY = 'breezer.setup.v1';
export const SETUP_PATH = 'workspace.html#/welcome';
export const STEPS = Object.freeze(['welcome', 'you', 'layout', 'theme', 'import', 'organato', 'tour', 'done']);

export function normalizeSetup(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    step: STEPS.includes(value.step) ? value.step : 'welcome',
    completed: value.completed === true,
    skipped: value.completed === true && value.skipped === true,
  };
}
