import { restoreMainStyles } from './workspace-integration-inverse.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseRoute } from '../../features/ai/extension/workspace-store.js';
import { RELEASE_VERSION } from '../../features/ai/extension/release-info.js';

const read = name => readFileSync(new URL(`../../features/ai/extension/${name}`, import.meta.url), 'utf8');
const source = read('workspace.js');
const mainCSS = readFileSync(new URL('./fixtures/workspace-main-port/main-workspace.css', import.meta.url), 'utf8');
const mainFunctions = JSON.parse(readFileSync(new URL('./fixtures/workspace-main-port/main-functions.json', import.meta.url), 'utf8'));
const assertStyles = (shared, settings) => assert.equal(restoreMainStyles(shared, settings), mainCSS);

test('zero-viewport motion guard stays confined to the unseen sidebar controls', () => {
  const css = read('workspace.css');
  const match = css.match(/@media \(max-width: 1px\) \{([\s\S]*?)\n\}/);
  assert.ok(match, 'zero-width native sidebar needs a viewport guard');
  assert.match(match[1], /\.sidebar, \.tile, \.space-dot \.dot \{ transition: none !important; \}/);
  assert.match(match[1], /\.row\.entering, \.folder\.entering, \.leaving \{ animation: none !important; \}/);
  assert.doesNotMatch(match[1], /(?:^|\n)\s*\*/);
});

test('route split reconstructs the exact current-main stylesheet with only the intended row fade removal', () => {
  const shared = read('workspace.css'), settings = read('settings.css');
  assert.doesNotMatch(shared, /\.settings|\.setting-row|\.context-settings|#custom-theme-color/);
  assert.match(shared, /:root\[data-scheme="dark"\]\[data-tone="custom"\]/);
  assert.match(shared, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(shared, /input::placeholder, textarea::placeholder/);
  assert.match(settings, /\.settings-category-picker/);
  assert.match(settings, /\[data-context-summary\]/);
  assert.match(settings, /#custom-theme-apply\[aria-pressed="true"\]/);
  assert.match(settings, /@keyframes settings-spin/);
  assertStyles(shared, settings);
});

test('CSS negative controls reject palette, motion, settings-order and custom-color regressions', () => {
  const shared = read('workspace.css'), settings = read('settings.css');
  for (const [badShared, badSettings] of [
    [shared.replace('--ink: #17202a', '--ink: #ffffff'), settings],
    [shared.replace('.row.entering, .folder.entering', '.folder.entering'), settings],
    [shared.replace('animation: row-in', 'animation: missing-row-in'), settings],
    [shared, settings.replace('grid-template-columns: clamp(208px, 22vw, 260px)', 'grid-template-columns: 100px')],
    [shared, settings.replace('color: var(--accent);', 'color: red;')],
  ]) {
    assert.ok(badShared !== shared || badSettings !== settings, 'negative control changed actual bytes');
    assert.throws(() => assertStyles(badShared, badSettings));
  }
});

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(route = '#/settings', { importError = false, deferImport = false } = {}) {
  const links = [], imports = [], mounts = [], errors = [], events = new Map(), timers = new Map();
  const nodes = new Map(['settings', 'welcome'].map(id => [id, { hidden: true, remove() { this.removed = true; } }]));
  const makeNode = tag => ({ tag, children: [], handlers: new Map(), setAttribute(key, value) { this[key] = value; },
    append(...children) { this.children.push(...children); }, addEventListener(type, fn) { this.handlers.set(type, fn); },
    remove() { links.splice(links.indexOf(this), 1); } });
  let finishImport;
  const importGate = new Promise(resolve => { finishImport = resolve; });
  const context = vm.createContext({ parseRoute, URL, Error, Promise,
    api: {}, workspace: {}, callBridge() {}, loadAppearance() {}, applyAppearance() {}, BridgeUnavailable: Error, darkQuery: {},
    location: { hash: route, reloads: 0, reload() { this.reloads++; } },
    $: id => nodes.get(id),
    document: { createElement: makeNode, head: { append(link) { links.push(link); } },
      body: { classList: { add() {} }, append(node) { errors.push(node); } } },
    setTimeout(fn, ms) { const key = {}; timers.set(key, { fn, ms }); return key; }, clearTimeout(key) { timers.delete(key); },
    addEventListener(type, fn) { events.set(type, fn); },
    async importModule(path) {
      imports.push(path);
      if (deferImport) await importGate;
      if (importError) throw new Error('module unavailable');
      const mount = async () => {
        const id = path === './settings.js' ? 'settings' : 'welcome';
        if (id === 'welcome') {
          // Execute the unchanged onboarding stylesheet insertion before its mount.
          await vm.runInContext('(async () => { const doc = document;\n' + read('onboarding.js').slice(read('onboarding.js').indexOf('  // The stylesheet only loads'), read('onboarding.js').indexOf('  const local =')) + '\n})()', context);
        }
        nodes.get(id).hidden = false;
        mounts.push(id);
      };
      return { mountSettings: mount, mountWelcome: mount };
    },
    async initSidebar(value) { mounts.push(value.view); },
  });
  // Only replace module syntax. Execute the real loader, router, catch and hash listener.
  const router = source.slice(source.indexOf('// ---------------------------------------------------------------- router')).replaceAll('import(', 'importModule(');
  vm.runInContext(router, context);
  return { context, links, imports, mounts, errors, timers, nodes, finishImport,
    change(hash) { const oldURL = `chrome-extension://test/workspace.html${context.location.hash}`; context.location.hash = hash;
      events.get('hashchange')({ oldURL, newURL: `chrome-extension://test/workspace.html${hash}` }); },
  };
}

test('sidebar boot never requests settings styles and preserves removal and route parsing', async () => {
  for (const route of ['#/sidebar?w=7', '', '#/unknown', '#/settings-evil']) {
    const f = fixture(route); await settle();
    assert.equal(f.links.length, 0); assert.equal(f.errors.length, 0);
    assert.equal(f.nodes.get('settings').removed, true); assert.equal(f.nodes.get('welcome').removed, true);
    assert.deepEqual(f.mounts, [parseRoute(route).view]);
  }
});

for (const route of ['#/settings', '#/settings/appearance', '#/welcome']) {
  test(`${route} waits for stylesheet success before import and unhide`, async () => {
    const f = fixture(route); await settle();
    assert.equal(f.links.length, 1); assert.equal(f.links[0].href, 'settings.css');
    assert.equal(f.links[0].rel, 'stylesheet'); assert.deepEqual(f.mounts, []); assert.deepEqual(f.imports, []);
    assert.equal(f.nodes.get('settings').hidden, true); assert.equal(f.nodes.get('welcome').hidden, true);
    f.links[0].handlers.get('load')(); await settle();
    if (route === '#/welcome') {
      assert.deepEqual(f.links.map(link => link.href), ['settings.css', 'onboarding.css']);
      f.links[1].handlers.get('load')(); await settle();
    }
    assert.deepEqual(f.mounts, [route === '#/welcome' ? 'welcome' : 'settings']);
    assert.equal(f.timers.size, 0); assert.equal(f.errors.length, 0);
  });
}

test('concurrent and completed loader calls reuse a single link', async () => {
  const f = fixture(); await settle();
  const a = vm.runInContext('loadSettingsStyles()', f.context);
  const b = vm.runInContext('loadSettingsStyles()', f.context);
  assert.equal(a, b); assert.equal(f.links.length, 1);
  f.links[0].handlers.get('load')(); await a; await settle();
  await vm.runInContext('loadSettingsStyles()', f.context);
  assert.equal(f.links.length, 1);
});

for (const kind of ['error', 'timeout', 'module']) {
  test(`${kind} failure shows an accessible reload action without mounting unstyled content`, async () => {
    const f = fixture('#/settings', { importError: kind === 'module' }); await settle();
    const link = f.links[0];
    if (kind === 'timeout') {
      assert.equal([...f.timers.values()][0].ms, 10000);
      [...f.timers.values()][0].fn();
    } else link.handlers.get(kind === 'module' ? 'load' : 'error')();
    await settle();
    assert.deepEqual(f.mounts, []); assert.equal(f.nodes.get('settings').hidden, true);
    assert.equal(f.errors.length, 1); assert.equal(f.errors[0].role, 'alert');
    assert.match(f.errors[0].children[0].textContent, /couldn.t load/i);
    const button = f.errors[0].children[1]; assert.equal(button.textContent, 'Reload');
    button.handlers.get('click')(); assert.equal(f.context.location.reloads, 1);
    assert.equal(f.timers.size, 0);
    // Late resource events cannot revive a failed mount or duplicate the error.
    link.handlers.get('load')(); await settle(); assert.deepEqual(f.mounts, []); assert.equal(f.errors.length, 1);
  });
}

test('category hashes stay in place; route departures cancel pending mounts and errors', async () => {
  const f = fixture(); await settle(); f.change('#/settings/privacy');
  assert.equal(f.context.location.reloads, 0);
  f.links[0].handlers.get('load')(); await settle(); assert.deepEqual(f.mounts, ['settings']);
  for (const fail of [false, true]) {
    const pending = fixture(); await settle(); pending.change('#/sidebar?w=9');
    assert.equal(pending.context.location.reloads, 1);
    pending.links[0].handlers.get(fail ? 'error' : 'load')(); await settle();
    assert.deepEqual(pending.mounts, []); assert.equal(pending.errors.length, 0);
  }
  const pending = fixture('#/welcome', { deferImport: true }); await settle();
  pending.links[0].handlers.get('load')(); await settle(); pending.change('#/settings');
  pending.finishImport(); await settle(); assert.deepEqual(pending.mounts, []);
});


test('failed stylesheet can retry without duplicate links', async () => {
  const f = fixture('#/welcome'); await settle();
  f.links[0].handlers.get('error')(); await settle();
  assert.equal(f.links.length, 0); assert.equal(f.errors.length, 1);
  const retry = vm.runInContext('loadSettingsStyles()', f.context);
  assert.equal(f.links.length, 1);
  f.links[0].handlers.get('load')(); await retry;
  assert.equal(f.links.length, 1); assert.deepEqual(f.mounts, []);
});

test('welcome timeout also has visible failure and reload instead of an unhandled rejection', async () => {
  const f = fixture('#/welcome'); await settle();
  [...f.timers.values()][0].fn(); await settle();
  assert.equal(f.nodes.get('welcome').hidden, true);
  assert.equal(f.errors.length, 1); assert.equal(f.errors[0].role, 'alert');
  assert.deepEqual(f.imports, []);
});

test('main draw, compact identities and activation-before-reveal remain the current-main operations', () => {
  const next = { draw: 'syncRovingFocus', compactLabels: 'draw', updateFavicon: null, switchSpace: 'animateSpace' };
  for (const [name, expected] of Object.entries(mainFunctions)) {
    const start = source.indexOf(`function ${name === 'draw' ? 'paintSidebar' : name}(`);
    const end = source.indexOf(next[name] ? `function ${next[name]}(` : 'export const favoriteTitle', start);
    const actual = source.slice(start, end).replace('  pendingRows = null;\n', '')
      .replace('function paintSidebar() {', 'function draw() {')
      .replace('  queryDrawDirty = false;\n', '');
    assert.equal(actual.trim(), expected.trim(), name);
  }
  assert.deepEqual([...source.matchAll(/import\('([^']+)'\)/g)].map(match => match[1]), ['./settings.js', './onboarding.js']);
  assert.match(read('workspace.html'), /<link rel="stylesheet" href="workspace.css">/);
  assert.equal(JSON.parse(read('manifest.json')).version, RELEASE_VERSION);
  assert.match(JSON.parse(read('manifest.json')).content_security_policy.extension_pages, /script-src 'self'/);
});
