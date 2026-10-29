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

test('keeps minor-release features and appends honest patch improvements', () => {
  assert.match(text, /add an Organato API key in Settings/);
  assert.match(text, /Choose any color in Settings, under Theme/);
  assert.match(text, /Update 1.1.1/);
  assert.match(text, /Bookmarks appear on new and blank tabs by default/);
  assert.match(text, /Organato exams and assignments share one Upcoming list/);
  assert.match(text, /Remove a frequently visited shortcut with its Remove button or right-click menu/);
  assert.match(text, /Links open immediately/);
  assert.match(text, /Update 1.1.2/);
  assert.match(text, /Previews from favourites/);
  assert.match(text, /icons stay evenly spaced/);
  assert.match(text, /without sending automatically/);
  assert.match(text, /Update 1.1.3/);
  assert.match(text, /a link to a different page on the same site now opens in Peek/);
  assert.match(text, /windows that start blank/);
  assert.match(text, /Reduce Motion on in macOS, Peek appears at once/);
  assert.match(text, /shows the site's first letter/);
  assert.match(text, /info button beside Settings/);
  assert.match(text, /appear in its first refresh/);
  assert.match(text, /Update 1.1.4/);
  assert.match(text, /starts its worker with Breezer's installed runtime/);
  assert.match(text, /only after the worker confirms it has started/);
  assert.match(text, /checksum, the app's identity and signature/);
  assert.match(text, /previous app is kept during replacement so a failed update can roll back/);
  // Touch ID is listed as not done, never as fixed or available.
  assert.match(text, /Not yet: Touch ID passkeys/);
  assert.match(text, /Website passkey sign-in with Touch ID still needs Apple-approved signing entitlements/);
  assert.doesNotMatch(text, /Touch ID (?:now|is now|works|is fixed|support)/i);
  // Limits stay stated, never promised away.
  assert.match(text, /Form submissions, app routes that change within the same page/);
  assert.match(text, /signed-in Google Docs and Canvas haven't been tested yet/);
  assert.match(text, /signed locally, not notarized by Apple, so macOS may still ask/);
  assert.match(text, /one-time manual install of 1.1.4 may be needed/);
  assert.doesNotMatch(text, /notarized (?:by Apple )?(?:now|and)|no (?:more|longer) (?:Gatekeeper|macOS) (?:warnings|prompts)/i);
  assert.equal([...html.matchAll(/class="patch-limit"/g)].length, 2);
  assert.equal([...html.matchAll(/data-action="continue"/g)].length, 2);
  assert.equal([...html.matchAll(/>Open Settings</g)].length, 2);
});

test('illustrates each patch group with decorative inline SVG only', () => {
  const groups = [...html.matchAll(/<div class="patch-(?:lead|group)">([\s\S]*?)<\/ul>/g)].map((m) => m[1]);
  assert.equal(groups.length, 14);
  for (const group of groups) {
    assert.match(group, /<figure class="plate patch-plate" aria-hidden="true">\s*<svg class="art" viewBox="[\d ]+" focusable="false">/);
    assert.match(group, /<h3>[^<]+<\/h3>/);
  }
  // Every patch note is still present as a list item, twenty in all.
  assert.equal(groups.flatMap(group => group.match(/<li>/g)).length, 20);
  // Pure vector art: no images, references or embedded links inside it.
  assert.doesNotMatch(html, /<(?:image|use|foreignObject)\b|xlink:|xmlns=/);
});

test('Organato artwork shows one Upcoming list beside To-dos', () => {
  const plate = html.match(/<figure class="plate plate-organato"[\s\S]*?<\/figure>/)[0];
  assert.deepEqual([...plate.matchAll(/class="mini-label">([^<]+)</g)].map((m) => m[1]), ['Upcoming', 'To-dos']);
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
