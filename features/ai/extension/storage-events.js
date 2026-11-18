// Storage-less views keep their existing optional behavior. Older storage APIs
// fail explicitly rather than restoring general events and session fan-out.
export function localStorageChanges(api) {
  if (!api?.storage) return null;
  const event = api.storage.local?.onChanged;
  if (typeof event?.addListener !== 'function') {
    throw new Error('Breezer requires storage.local.onChanged. Update the browser or storage test fixture.');
  }
  return event;
}
