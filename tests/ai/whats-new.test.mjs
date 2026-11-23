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
const [html, css, js, archive] = await Promise.all(['whats-new.html', 'whats-new.css', 'whats-new.js', 'efficiency.html'].map((name) => readFile(resolve(root, name), 'utf8')));
const toText = (source) => source.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const text = toText(html);
// Measured results live in one section; everywhere else describes behavior only.
const resultsHtml = archive.match(/<section class="results"[\s\S]*?<\/section>/)?.[0] ?? '';
const resultsText = toText(resultsHtml);

test('loads nothing remote', () => {
  for (const [name, source] of Object.entries({ html, css, js })) {
    assert.doesNotMatch(source, /\b(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i, `${name} references a remote URL`);
    assert.doesNotMatch(source, /@import|@font-face/, `${name} pulls in extra resources`);
  }
  assert.deepEqual([...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]), ['#breeze-ink']);
  for (const [, target] of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    if (target.startsWith('#')) assert.ok(html.includes(`id="${target.slice(1)}"`), target);
    else assert.ok(['efficiency.html', 'icon128.png', 'whats-new.css', 'whats-new.js', 'workspace.html#/settings'].includes(target) ||
      /^whats-new\.css\?v=\d+\.\d+\.\d+$/.test(target), target);
  }
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

test('the new edition shows 1.3 features and their verification limits', () => {
  assert.doesNotMatch(text, /Update 1\.[12]\.\d|New group in the horizontal tab strip|\d+(?:\.\d+)?\s*(?:%|ms|MiB|x faster)|faster than Chrome/);
  assert.match(text, /Slipstream/);
  assert.match(text, /breezer:\/\/settings/i);
  assert.match(text, /folder/i);
  assert.match(text, /tables/i);
  assert.match(text, /memory/i);
  assert.match(text, /Apply theme/i);
  assert.match(text, /Restore previous look/i);
  assert.match(text, /shortcut/i);
  assert.match(text, /Google Docs/i);
  assert.doesNotMatch(text, /Google Docs (?:now works|is fixed|works correctly)|Touch ID (?:now|is now|works|is fixed|support)/i);
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
  assert.match(archive, /The efficiency work in Breezer 1\.2\.0/);
  assert.doesNotMatch(html, /<section class="results"/);
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
  assert.match(resultsHtml, /<a class="button secondary" href="#benchmark-story-title">Read about the efficiency work in 1\.2<\/a>/);
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

test('illustrates each highlight and uses unique heading IDs', () => {
  const features = [...html.matchAll(/<article class="feature[^"]*" aria-labelledby="([^"]+)">([\s\S]*?)<\/article>/g)];
  assert.equal(features.length, 5);
  for (const [, id, body] of features) {
    assert.match(body, /<figure[^>]*aria-hidden="true"/, id);
    assert.match(body, new RegExp(`<h3 id="${id}">[^<]+</h3>`));
  }
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test('stays light and honours reduced motion', () => {
  assert.match(html, /<meta name="color-scheme" content="light">/);
  assert.doesNotMatch(css, /prefers-color-scheme/);
  // Every animation sits behind a no-preference query: the masthead breeze and
  // the 1.3.5 PDF view moving into the composer, each played once.
  const animated = [...css.matchAll(/animation:/g)].length;
  const guarded = [...css.matchAll(/@media \(prefers-reduced-motion: no-preference\) \{[^@]*animation:/g)].length;
  assert.equal(animated, 2);
  assert.equal(guarded, 2);
  assert.match(css, /\.pdf-shot \{ animation: pdf-send [^;]* 1 both; \}/);
});
