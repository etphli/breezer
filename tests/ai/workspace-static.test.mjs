import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TONES } from '../../features/ai/extension/workspace-store.js';

const dir = new URL('../../features/ai/extension/', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'utf8');
const files = ['workspace.html', 'workspace.css', 'workspace.js', 'workspace-store.js', 'settings.js'];

test('workspace files never parse HTML from strings or load remote resources', () => {
  for (const name of files) {
    const original = read(name);
    // Navigation to the integration's settings is not a loaded remote resource.
    const source = name === 'workspace.html' ? original.replace('<a href="https://organato.vercel.app" target="_blank" rel="noreferrer">Organato Settings</a>', '') : original;
    assert.doesNotMatch(source, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/, name);
    const remote = [...source.matchAll(/https?:\/\/[^\s'"`)]+/g)].map((match) => match[0]).filter((url) => url !== 'http://www.w3.org/2000/svg');
    assert.deepEqual(remote, [], `${name} references remote URLs`);
  }
  const html = read('workspace.html');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, 'no inline scripts');
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline event handlers');
  assert.doesNotMatch(html, /\sstyle=/i, 'no inline styles');
  assert.match(html, /<script type="module" src="workspace\.js"><\/script>/);
});

function luminance(hex) {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

function expand(hex) {
  const value = hex.toLowerCase().replace('#', '');
  return `#${value.length === 3 ? [...value].map((c) => c + c).join('') : value}`;
}

test('every tone keeps text readable on sidebar surfaces in light and dark', () => {
  const css = read('workspace.css');
  for (const scheme of ['light', 'dark']) {
    for (const tone of TONES) {
      const selector = scheme === 'dark' ? `\\[data-scheme="dark"\\]\\[data-tone="${tone}"\\]` : `^\\[data-tone="${tone}"\\]`;
      const block = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 'm'));
      assert.ok(block, `${scheme} ${tone} block`);
      const vars = Object.fromEntries([...block[1].matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{3,6})/g)].map(([, key, value]) => [key, expand(value)]));
      for (const surface of ['air', 'air-deep', 'card']) {
        assert.ok(contrast(vars.ink, vars[surface]) >= 7, `${scheme} ${tone} ink on ${surface}: ${contrast(vars.ink, vars[surface]).toFixed(2)}`);
        assert.ok(contrast(vars.muted, vars[surface]) >= 4.5, `${scheme} ${tone} muted on ${surface}: ${contrast(vars.muted, vars[surface]).toFixed(2)}`);
      }
      assert.ok(contrast(vars.accent, vars.air) >= 3, `${scheme} ${tone} accent on air: ${contrast(vars.accent, vars.air).toFixed(2)}`);
    }
  }
});
