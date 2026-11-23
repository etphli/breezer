// Set by the source overlay when it prepares the Windows component.
export const PLATFORM = 'mac';
export const HAS_NATIVE_HELPER = PLATFORM === 'mac' || PLATFORM === 'windows';
export const HAS_APP_UPDATER = PLATFORM === 'mac';
export const NATIVE_HOST = 'io.github.etphli.breezer.ai';
