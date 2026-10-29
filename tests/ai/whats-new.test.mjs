import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { continueBrowsing, releaseName } from '../../features/ai/extension/whats-new.js';

// Static contract for the What's new page: local-only, no HTML injection, no
// tracking, honest copy, and the exact hooks Main integrates with.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../features/ai/extension');
const [html, css, js] = await Promise.all(['whats-new.html', 'whats-new.css', 'whats-new.js'].map((name) => readFile(resolve(root, name), 'utf8')));
const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('loads nothing remote', () => {
  for (const [name, source] of Object.entries({ html, css, js })) {
    assert.doesNotMatch(source, /\b(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i, `${name} references a remote URL`);
    assert.doesNotMatch(source, /@import|@font-face/, `${name} pulls in extra resources`);
  }
  assert.deepEqual([...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]), ['#breeze-ink']);
  assert.deepEqual([...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]).sort(),
    ['icon128.png', 'whats-new.css', 'whats-new.js', 'workspace.html#/settings', 'workspace.html#/settings']);
});

test('is CSP-safe and never injects HTML', () => {
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, 'inline script');
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'inline event handler');
  assert.doesNotMatch(html, /\sstyle=/, 'inline style');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
});

test('stores and sends nothing', () => {
  assert.doesNotMatch(js, /\bstorage\b|localStorage|sessionStorage|indexedDB|document\.cookie|fetch\(|XMLHttpRequest|sendBeacon|WebSocket|runtime\.(?:send|connect)/);
  // The only chrome APIs are closing this tab.
  assert.deepEqual([...new Set(js.match(/tabs\??\.\w+/g))].sort(), ['tabs.remove', 'tabs?.getCurrent']);
});

test('reads only RELEASE_VERSION from release-info.js', () => {
  assert.match(js, /\{ RELEASE_VERSION: version \} = await import\('\.\/release-info\.js'\)/);
  assert.doesNotMatch(js, /\bRELEASE\b(?!_VERSION)/);
});

test('names the release only from a plain semantic version', () => {
  assert.equal(releaseName('1.1.0'), 'Breezer 1.1.0');
  for (const bad of [undefined, null, '', 'v1.1.0', '1.1', '1.1.0-beta', '<b>1.1.0</b>', 110]) assert.equal(releaseName(bad), 'Breezer');
});

test('Continue browsing closes this tab, else the window', async () => {
  const removed = [];
  let closed = 0;
  const close = () => { closed += 1; };
  const tabs = { getCurrent: async () => ({ id: 42 }), remove: async (id) => { removed.push(id); } };
  assert.equal(await continueBrowsing({ tabs, close }), 'tab');
  assert.deepEqual([removed, closed], [[42], 0]);

  // Not in a tab (e.g. a popup), a failing API, or no API at all.
  assert.equal(await continueBrowsing({ tabs: { getCurrent: async () => undefined, remove: async () => assert.fail() }, close }), 'window');
  assert.equal(await continueBrowsing({ tabs: { getCurrent: async () => ({ id: 7 }), remove: async () => { throw new Error('No tab'); } }, close }), 'window');
  assert.equal(await continueBrowsing({ tabs: { getCurrent: async () => { throw new Error('denied'); } }, close }), 'window');
  assert.equal(await continueBrowsing({ tabs: undefined, close }), 'window');
  assert.equal(closed, 4);
});

test('describes the 1.1.1 fixes and UX changes honestly', () => {
  assert.match(text, /Bookmarks appear on new and blank tabs by default/);
  assert.match(text, /Choose New tabs only, Always or Hidden in Settings/);
  assert.match(text, /importing Chrome bookmarks and history/);
  assert.match(text, /does not sync Chrome changes or import passkeys/);
  assert.match(text, /Nothing is sent automatically/);
  // Touch ID is listed as not done, never as fixed or available.
  assert.match(text, /Not yet: Touch ID passkeys/);
  assert.match(text, /Website passkey sign-in with Touch ID still needs Apple-approved signing entitlements/);
  assert.doesNotMatch(text, /Touch ID (?:now|is now|works|is fixed|support)/i);
  assert.equal([...html.matchAll(/data-action="continue"/g)].length, 2);
  assert.equal([...html.matchAll(/>Open Settings</g)].length, 2);
});

test('stays light and honours reduced motion', () => {
  assert.match(html, /<meta name="color-scheme" content="light">/);
  assert.doesNotMatch(css, /prefers-color-scheme/);
  // Every animation sits behind a no-preference query.
  const animated = [...css.matchAll(/animation:/g)].length;
  const guarded = [...css.matchAll(/@media \(prefers-reduced-motion: no-preference\) \{[^@]*animation:/g)].length;
  assert.equal(animated, 1);
  assert.equal(guarded, 1);
});
