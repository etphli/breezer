import assert from 'node:assert/strict';

// Reconstruct the pinned main cascade from the two route sheets. This is a CSS
// extraction oracle only; DOM tests run main's bounded draw fixture separately.
export const zeroWidthMotionGuard = `/* Native auto-hide can keep the document visible in a zero-width viewport. */
@media (max-width: 1px) {
  .sidebar, .tile, .space-dot .dot { transition: none !important; }
  .row.entering, .folder.entering, .leaving { animation: none !important; }
}

`;

// Folder colors postdate the pinned main oracle. Remove exactly their two
// blocks, and only if every rule inside them is a folder-color rule.
const folderColorBlocks = [
  ['\n/* Folder colors.', '.folder-row.contains-active { background: color-mix(in srgb, var(--folder-color)'],
  ['.menu-swatches {', '.menu-well:focus-visible, .menu-hex:focus-visible, .menu-apply:focus-visible'],
];
const folderColorSelector = /^(?::root(?:\[data-scheme="dark"\])?|\[data-color="[a-z]+"\]|:root\[data-scheme="dark"\] \[data-color="custom"\]|\.sidebar[^{]*\.folder\[data-color\][^{]*|\.menu-(?:swatches|chip|custom|well|hex|apply)[^{]*)$/;

export function stripFolderColorStyles(shared) {
  for (const [start, last] of folderColorBlocks) {
    assert.equal(shared.split(start).length - 1, 1, `one folder color block at ${start.trim()}`);
    const from = shared.indexOf(start), lastAt = shared.indexOf(last, from);
    assert.ok(lastAt > from && shared.split(last).length - 1 === 1, `folder color block end for ${start.trim()}`);
    const to = shared.indexOf('\n', lastAt) + 1;
    const block = shared.slice(from, to).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selectors] of block.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      for (const selector of selectors.split(/,(?![^(]*\))/)) assert.match(selector.trim(), folderColorSelector, 'folder color blocks hold only folder color rules');
    }
    shared = shared.slice(0, from) + shared.slice(to);
  }
  return shared;
}

// The two folder-color paint calls in draw, removed exactly once each.
export const folderColorDrawLines = [
  '  if (sidebar.dataset.folderColors !== model.prefs.folderColors) sidebar.dataset.folderColors = model.prefs.folderColors;\n',
  '        if (!folderPreview || folderPreview.id !== node.folder.id) paintFolderColor(folder, node.folder.color);\n',
];
export function stripFolderColorDraw(source) {
  for (const line of folderColorDrawLines) {
    assert.equal(source.split(line).length - 1, 1, `one folder color draw line: ${line.trim()}`);
    source = source.replace(line, '');
  }
  return source;
}

export function restoreMainStyles(shared, settings) {
  shared = stripFolderColorStyles(shared);
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
