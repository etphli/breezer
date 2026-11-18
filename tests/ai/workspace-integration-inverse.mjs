import assert from 'node:assert/strict';

// Reconstruct the pinned main cascade from the two route sheets. This is a CSS
// extraction oracle only; DOM tests run main's bounded draw fixture separately.
export const zeroWidthMotionGuard = `/* Native auto-hide can keep the document visible in a zero-width viewport. */
@media (max-width: 1px) {
  .sidebar, .tile, .space-dot .dot { transition: none !important; }
  .row.entering, .folder.entering, .leaving { animation: none !important; }
}

`;

export function restoreMainStyles(shared, settings) {
  assert.equal(shared.split(zeroWidthMotionGuard).length - 1, 1, 'one zero-width guard');
  shared = shared.replace(zeroWidthMotionGuard, '');
  const placeholder = 'input::placeholder, textarea::placeholder { color: var(--muted); opacity: 1; }\n';
  assert.equal(shared.split(placeholder).length - 1, 1, 'shared input placeholders');
  shared = shared.replace(placeholder, '');
  settings = settings.replace('\n\n[data-password-import-guide]', '\n' + placeholder + '\n[data-password-import-guide]');
  const row = shared.indexOf('\n.row {\n'), rowEnd = shared.indexOf('\n}', row);
  assert.ok(row >= 0 && rowEnd > row, 'main row rule');
  assert.doesNotMatch(shared.slice(row, rowEnd), /\btransition(?:-property)?\s*:/);
  shared = shared.slice(0, rowEnd) + '\n  transition: background-color 90ms ease;' + shared.slice(rowEnd);
  const reduced = shared.indexOf('@media (prefers-reduced-motion: reduce)');
  const custom = shared.indexOf(':root[data-tone="custom"]', reduced);
  const context = settings.indexOf('/* Inherits Breezer');
  const color = settings.indexOf('#custom-theme-color', context);
  assert.ok(reduced > 0 && custom > reduced && context > 0 && color > context, 'main cascade boundaries');
  return shared.slice(0, reduced) + settings.slice(0, context)
    + shared.slice(reduced, custom) + settings.slice(context, color)
    + shared.slice(custom) + settings.slice(color);
}
