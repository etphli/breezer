import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { continueBrowsing, releaseName } from '../../features/ai/extension/whats-new.js';

// Static contract for the What's new page: local-only, no HTML injection, no
// tracking, honest copy, and the exact hooks Main integrates with.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../features/ai/extension');
const [html, css, js] = await Promise.all(['whats-new.html', 'whats-new.css', 'whats-new.js'].map((name) => readFile(resolve(root, name), 'utf8')));
const toText = (source) => source.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const text = toText(html);
// Measured results live in one section; everywhere else describes behavior only.
const resultsHtml = html.match(/<section class="results"[\s\S]*?<\/section>/)?.[0] ?? '';
const resultsText = toText(resultsHtml);
const featureText = toText(html.replace(resultsHtml, ''));

test('loads nothing remote', () => {
  for (const [name, source] of Object.entries({ html, css, js })) {
    assert.doesNotMatch(source, /\b(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i, `${name} references a remote URL`);
    assert.doesNotMatch(source, /@import|@font-face/, `${name} pulls in extra resources`);
  }
  assert.deepEqual([...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]), ['#breeze-ink']);
  assert.deepEqual([...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]).sort(),
    ['#features-title', '#results-table', '#results-title', '#verification-title', 'efficiency.html', 'icon128.png', 'whats-new.css', 'whats-new.js', 'workspace.html#/settings', 'workspace.html#/settings', 'workspace.html#/welcome']);
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

test('describes the 1.2 edition honestly, without carrying 1.1 patches', () => {
  // A new minor edition replaces the previous one's features and patches.
  assert.doesNotMatch(text, /Update 1\.1\.\d|Organato on your new tab|Your own theme color/);
  assert.equal([...html.matchAll(/class="patch-notes"/g)].length, 1);
  assert.match(text, /Update 1\.2\.1/);
  assert.match(text, /Whole-browser RAM and CPU savings have not yet been measured/);
  assert.match(text, /New profiles open this guide/);
  assert.match(text, /Skip any step, or reopen the guide in Settings/);
  assert.match(html, /<a class="button secondary" href="workspace\.html#\/welcome">Open the setup guide<\/a>/);
  assert.match(text, /enter an address or select an open tab/);
  assert.match(text, /stay in this profile on your Mac/);
  assert.match(text, /Assignments link to their own Organato page/);
  assert.match(text, /ignores lists older than what it already shows/);
  assert.match(text, /start when needed and close when idle/);
  assert.match(text, /interrupted changes are never resent automatically/);
  assert.match(text, /checksum, identity, signature and rollback checks are unchanged/);
  assert.match(text, /Custom filters, list updates and your blocking settings work as before/);
  assert.match(text, /A copy a running Breezer still holds is never touched/);
  // Outside the measured-results section, performance is described as
  // behavior, never as numbers or comparisons.
  assert.doesNotMatch(featureText, /\d+(?:\.\d+)?\s*(?:%|ms|MB|MiB|GB|x faster|times)|faster than|Chrome uses|less (?:RAM|memory)/i);
  // Password suggestions: the Microsoft step is stated as unconfirmed, never fixed.
  assert.match(text, /hasn't yet been confirmed to fix pressing Enter on Microsoft's password step/);
  assert.doesNotMatch(text, /Microsoft (?:sign-in|password step) (?:is |now )?(?:fixed|works)/i);
  // Touch ID is listed as not done, never as fixed or available.
  assert.match(text, /Known limitations/);
  assert.match(text, /Touch ID passkeys are unavailable/);
  assert.match(text, /Website passkey sign-in with Touch ID still needs Apple-approved signing entitlements/);
  assert.match(text, /The Passwords page explains storage and opens the local page to check passkey availability/);
  assert.match(text, /Website passkeys still need Apple-approved signing entitlements/);
  assert.match(text, /Choose source tabs in the assistant to compare and summarize up to six pages, with source references and clear text-only sharing/);
  assert.match(text, /Research sources never enable browser control/);
  assert.match(text, /Review the selected pages before sharing their text/);
  assert.match(text, /Right-click a page and choose Translate page/);
  assert.match(text, /Use a running LibreTranslate server on your Mac, or your own LibreTranslate\.com key/);
  assert.match(text, /Breezer does not bundle translation models or use your AI account/);
  assert.match(text, /Search also includes Chromium\x27s settings/);
  assert.match(text, /Press \/ to start/);
  assert.match(text, /All settings opens the full browser settings/);
  assert.match(text, /Matching saved tabs and preparing the sidebar no longer repeatedly scan the whole saved workspace/);
  assert.match(text, /Keyboard focus stays on the existing row/);
  assert.match(text, /Organato requests from Settings and new tabs share a helper/);
  assert.match(text, /closing one page does not cancel another page's work/);
  assert.match(text, /If a prepared list has changed or cannot be used, Breezer processes it normally instead/);
  assert.match(text, /Source labels, URLs, captured lengths, truncation and individual page errors stay visible/);
  assert.match(text, /Back and Forward move between categories/);
  assert.match(text, /Command-number opens one saved favorite or pin, including asleep pages/);
  assert.match(text, /and reuses it on repeat/);
  assert.match(text, /Top tabs, private windows and Command\+9 keep their usual behavior/);
  assert.match(text, /choose Don't use Organato to keep it off/);
  assert.match(text, /Turn Organato off for a new tab with only the date and shortcuts/);
  assert.match(text, /Those tabs stop starting its helper and requesting its data/);
  assert.doesNotMatch(text, /Touch ID (?:now|is now|works|is fixed|support)/i);
  assert.doesNotMatch(text, /notarized (?:by Apple )?(?:now|and)|no (?:more|longer) (?:Gatekeeper|macOS) (?:warnings|prompts)/i);
  assert.match(text, /Added a bounded Google Docs editor input path; real-document verification pending/);
  assert.match(text, /saved changes still need checks in the compiled browser with both AI providers/);
  assert.doesNotMatch(text, /Google Docs (?:now works|is fixed|works correctly)|AI browser control can focus Google Docs/i);
  assert.equal([...html.matchAll(/class="pending"/g)].length, 4);
  assert.match(text, /Encrypted sync/);
  assert.match(text, /Encrypted two-profile and password-sync checks remain pending/);
  assert.equal([...html.matchAll(/data-action="continue"/g)].length, 2);
  assert.equal([...html.matchAll(/>Open Settings</g)].length, 2);
});

// Medians from build/benchmark-1.2.0-three-way-v8-run-20261101/presentation-data.json
// (candidate, previous Breezer, Chrome; null = unavailable) and saved-record
// medians from build/benchmark-1.2.0-components-20261101/results.json.
const measured = [
  ['Initialized-profile usable startup', 'ms', [742.1, 730.4, 734.9]],
  ['Reused-profile usable startup', 'ms', [861.3, 846.6, 1070.2]],
  ['Blank-tab readiness', 'ms', [68.8, 65.0, 66.2]],
  ['Product new-tab readiness', 'ms', [98.8, 99.2, 198.7]],
  ['Local-page navigation readiness', 'ms', [48.9, 33.9, 33.1]],
  ['Local-page loadEventEnd', 'ms', [11.2, 11.5, 6.6]],
  ['First local navigation after tab exercises', 'ms', [262.2, 717.4, 52.4]],
  ['One-tab process-tree RSS', 'MiB', [1417.6, 1245.5, 1418.3]],
  ['Ten-tab process-tree RSS', 'MiB', [2756.1, 2560.8, 2515.1]],
  ['One-tab macOS physical footprint', 'MiB', [454.8, 461.3, null]],
  ['Ten-tab macOS physical footprint', 'MiB', [959.5, 956.2, null]],
];
const shown = (value, unit) => `${value.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${unit}`;

test('leads with selected measured wins, each naming its comparator and workload', () => {
  // Feature changes lead; the complete measurements precede the patch notes.
  assert.ok(html.indexOf('</header>') < html.indexOf('<section class="results"'));
  assert.ok(html.indexOf('<section class="features"') < html.indexOf('<section class="results"'));
  assert.ok(html.indexOf('<section class="results"') < html.indexOf('<section class="patch-notes"'));
  const highlights = resultsHtml.slice(0, resultsHtml.indexOf('<details class="full-results">'));
  const hero = toText(highlights);
  const headings = [...highlights.matchAll(/<h[34][^>]*>([^<]+)<\/h[34]>/g)].map((m) => m[1].replace(/ /g, ' '));
  assert.deepEqual(headings, [
    'Measured against Chrome and the previous Breezer',
    'New in this build',
    'First local page after tab exercises',
    'Restoring saved-tab records',
    'Still ahead of Chrome, as before',
    'New tab: 50.3% less time than Chrome',
    'Relaunch: 19.5% less time than Chrome',
  ]);
  const more = highlights.slice(highlights.indexOf('<details class="results-more">'));
  assert.match(more, /^<details class="results-more">\s*<summary>More browser measurements<\/summary>/);
  assert.doesNotMatch(more, /<details[^>]*\sopen/);
  assert.ok(highlights.indexOf('Restoring saved-tab records') < highlights.indexOf('<details class="results-more">'));
  assert.ok(more.includes('Still ahead of Chrome, as before'));
  // Leads over Chrome are attributed to the earlier Breezer, not to 1.2.
  assert.match(hero, /previous Breezer measured 99\.2\s?ms, so this lead isn’t new in 1\.2/);
  assert.match(hero, /previous Breezer measured 846\.6\s?ms, so this lead isn’t new either/);
  // The first-load win keeps its workload and Chrome's lower time in view.
  assert.match(hero, /The first of those loads took 262\.2\s?ms instead of 717\.4\s?ms \(medians of 6 launches\)/);
  assert.match(hero, /Chrome took 52\.4\s?ms on the same workload, so it is still quicker here/);
  // Component evidence stays a code test, never live tabs or browser speed.
  assert.match(hero, /separate synthetic test of the sidebar’s workspace code/);
  assert.match(hero, /0\.187\s?ms instead of 3\.299\s?ms/);
  assert.match(hero, /not 1,000 open tabs or overall browser speed/);
  assert.match(hero, /selected results for specific workloads, not overall browser speed/);
  // Bars are proportional to the median on a zero-based scale.
  const widths = [...resultsHtml.matchAll(/<rect width="([\d.]+)%"/g)].map((m) => Number(m[1]));
  assert.deepEqual(widths, [36.55, 100, 7.31, 1.53, 100, 5.66, 100, 49.73, 49.9, 100, 80.48, 79.1, 100]);
  // Losing metrics are not in the hero, and the full results are named up front.
  assert.doesNotMatch(hero, /RSS|footprint|2,756|48\.9|blank tab/i);
  assert.match(hero, /See the full results , including slower and unavailable measurements/);
  assert.match(resultsHtml, /<a class="button secondary" href="efficiency\.html">Read about the efficiency work in 1\.2<\/a>/);
});

test('keeps every measurement, range and limit in the full results', () => {
  const full = resultsHtml.slice(resultsHtml.indexOf('<details class="full-results">'));
  assert.match(full, /^<details class="full-results">\s*<summary>Full results: all 11 measurements, including slower and unavailable ones<\/summary>/);
  assert.doesNotMatch(full, /<details[^>]*\sopen/);
  assert.match(full, /<div class="table-scroll" role="region" aria-labelledby="results-table" tabindex="0">/);
  const table = full.match(/<table class="results-table">[\s\S]*?<\/table>/)[0];
  assert.match(table, /<thead><tr><th scope="col">Measurement<\/th><th scope="col">Breezer 1\.2\.0 candidate<\/th><th scope="col">Previous Breezer<\/th><th scope="col">Chrome 156<\/th><th scope="col">Result<\/th><\/tr><\/thead>/);
  const rows = [...table.matchAll(/<tr><th scope="row">([^<]+)<span class="measure-note">[^<]+<\/span><\/th>(.*?)<\/tr>/g)];
  assert.deepEqual(rows.map((m) => m[1]), measured.map(([label]) => label));
  for (const [i, [label, unit, values]] of measured.entries()) {
    const cells = [...rows[i][2].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
    assert.equal(cells.length, 4, label);
    values.forEach((value, j) => {
      if (value == null) assert.equal(cells[j], 'Unavailable', label);
      else assert.ok(cells[j].startsWith(shown(value, unit)) && /<span class="range">/.test(cells[j]), `${label}: ${cells[j]}`);
    });
  }
  // Regressions and parity are stated, not softened.
  const fullText = toText(full);
  for (const verdict of ['47.8% higher than Chrome; 44.3% higher than previous Breezer', '9.6% higher than Chrome; 7.6% higher than previous Breezer',
    'Same as Chrome; 13.8% higher than previous Breezer', '4–6% higher than both', '63.5% lower than previous Breezer; still about 5 times Chrome’s']) assert.ok(fullText.includes(verdict), verdict);
  assert.equal([...table.matchAll(/class="unavailable">Unavailable</g)].length, 2);
  // Separate component table, then limits.
  assert.match(fullText, /Saved-tab records code test/);
  assert.match(full, /<tr><th scope="row">1,000<\/th><td[^>]*>189\.96<\/td><td[^>]*>2\.90<\/td><td[^>]*>3\.299<\/td><td[^>]*>0\.187<\/td><\/tr>/);
  for (const limit of [/One Apple M1 Mac with 8 GB of memory, macOS 26\.7, on AC power/, /36 timed launches after 18 untimed setup launches/,
    /aren’t cold starts after a reboot/, /not real websites over the internet/, /can count shared memory more than once/,
    /Chrome’s physical footprint is unavailable: 11 of its 60 samples failed/, /in all 36 sampling windows/, /no CPU, energy or battery-life claims/,
    /not statistically significant differences/, /snapshot fa19c37\); its internal version still reads 0\.20\.1\.1/, /release identity and full feature checks are still pending/]) assert.match(fullText, limit);
});

// The raw benchmark output is local (build/ is ignored); when present, the
// page's medians must still round from it.
const presentationPath = resolve(root, '../../../build/benchmark-1.2.0-three-way-v8-run-20261101/presentation-data.json');
test('matches the local benchmark report when it is available', { skip: !existsSync(presentationPath) && 'benchmark report not present' }, async () => {
  const { metrics } = JSON.parse(await readFile(presentationPath, 'utf8'));
  assert.deepEqual(metrics.map((m) => [m.label, m.unit, ['breezer', 'baselineBreezer', 'chrome'].map((id) => (m.values[id].median == null ? null : Math.round(m.values[id].median * 10) / 10))]), measured);
});

test('makes no claim the measurements do not support', () => {
  assert.doesNotMatch(resultsText, /battery life (?:is|improves|lasts)|uses less (?:RAM|memory|CPU|energy)|\d+(?:\.\d+)?x\b|\d+ times faster|statistically significant (?!differences)|faster everywhere|all-around|published 1\.2|1\.2\.0 is out/i);
  assert.doesNotMatch(resultsText, /new in 1\.2[^.]*(?:new tab|relaunch)|1\.2 (?:makes|made) new tabs/i);
});

test('illustrates primary features and keeps technical notes compact', () => {
  const features = [...html.matchAll(/<article class="feature[^"]*" aria-labelledby="([^"]+)">([\s\S]*?)<\/article>/g)];
  assert.deepEqual(features.map((m) => m[1]), ['f-setup', 'f-shortcuts', 'f-tasks', 'f-sidebar', 'f-helpers', 'f-storage', 'f-passkeys', 'f-research', 'f-translation', 'f-settings']);
  for (const [, id, body] of features) {
    if (['f-sidebar', 'f-helpers', 'f-storage'].includes(id)) {
      assert.doesNotMatch(body, /<figure/, id);
      assert.match(body, /<details class="feature-details">/, id);
    } else {
      assert.match(body, /<figure class="plate plate-art" aria-hidden="true">\s*<svg class="art" viewBox="[\d ]+" focusable="false">/, id);
    }
    assert.match(body, new RegExp(`<h3 id="${id}">[^<]+</h3>`));
  }
  // Heading IDs are unique across the page.
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  // Pure vector art: no images, references or embedded links inside it.
  assert.doesNotMatch(html, /<(?:image|use|foreignObject)\b|xlink:|xmlns=/);
});

test('setup artwork shows the guide\'s steps in order', () => {
  const plate = html.match(/<article class="feature feature-lead"[\s\S]*?<\/figure>/)[0];
  const steps = [...plate.matchAll(/<text(?: class="(?:label|quiet)")? x="40" y="[\d.]+">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(steps, ['Start', 'Name', 'Tabs', 'Color', 'Import', 'Organato', 'Tour', 'Done']);
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
