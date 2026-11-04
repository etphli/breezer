import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { categoryFromHash, groupResults, normalizeText, rankEntries } from '../../features/ai/extension/settings-nav.js';
import { parseRoute } from '../../features/ai/extension/workspace-store.js';

const html = readFileSync(new URL('../../features/ai/extension/workspace.html', import.meta.url), 'utf8');

test('settings routes accept a category and keep the settings view', () => {
  assert.equal(categoryFromHash('#/settings/appearance'), 'appearance');
  assert.equal(categoryFromHash('#/settings'), null);
  assert.equal(categoryFromHash('#/sidebar?w=1'), null);
  assert.equal(categoryFromHash('#/settings/<script>'), null);
  assert.deepEqual(parseRoute('#/settings/languages'), { view: 'settings', windowId: null });
  assert.deepEqual(parseRoute('#/settingsx'), { view: 'sidebar', windowId: null });
});

test('every navigation category has a page, and Other leaves for native settings', () => {
  const links = [...html.matchAll(/class="nav-item" href="#\/settings\/([a-z-]+)" data-category="([a-z-]+)"/g)];
  assert.ok(links.length >= 10);
  for (const [, href, category] of links) {
    assert.equal(href, category);
    assert.match(html, new RegExp(`data-page="${category}"`), category);
  }
  assert.match(html, /id="open-native-settings" class="nav-item" type="button"[^>]*>.*<span>All settings<\/span>/);
  // Peer feature mounts keep their containers and categories.
  for (const [id, page] of [['password-settings', 'passwords'], ['sync-settings', 'sync'], ['translation-settings', 'languages']]) {
    assert.match(html, new RegExp(`data-page="${page}"[^>]*>\\s*<div id="${id}"`), id);
  }
});

test('search ranks titles above keywords and descriptions, and every word must match', () => {
  const entries = [
    { kind: 'setting', category: 'layout', categoryLabel: 'Layout', title: 'Sidebar width', description: 'Space for tab titles.', terms: 'size' },
    { kind: 'setting', category: 'appearance', categoryLabel: 'Appearance', title: 'Appearance', description: 'System follows your Mac.', terms: 'dark mode light mode' },
    { kind: 'native', category: 'browser', categoryLabel: 'Browser settings', title: 'Privacy and security', description: 'Cookies and Safe Browsing.', terms: 'clear browsing data' },
    { kind: 'setting', category: 'appearance', categoryLabel: 'Appearance', title: 'Sidebar font size', description: 'Changes tab titles.', terms: 'text' },
  ];
  assert.deepEqual(rankEntries(entries, 'sidebar').map((entry) => entry.title), ['Sidebar width', 'Sidebar font size']);
  assert.deepEqual(rankEntries(entries, 'Dark  MODE').map((entry) => entry.title), ['Appearance']);
  assert.deepEqual(rankEntries(entries, 'cookies').map((entry) => entry.title), ['Privacy and security']);
  assert.deepEqual(rankEntries(entries, 'sidebar cookies'), []);
  assert.deepEqual(rankEntries(entries, '   '), []);
  assert.equal(normalizeText('Breezer’s Café'), 'breezers cafe');
  const groups = groupResults(rankEntries(entries, 'size'));
  assert.deepEqual(groups.map((group) => group.label), ['Appearance', 'Layout']);
});
