import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Minimal DOM for the actual render functions. No browser, provider or network.
class Node {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this.textContent = '';
    this.className = '';
    this.classList = {
      add: name => { this.className = `${this.className} ${name}`.trim(); },
      contains: name => this.className.split(/\s+/).includes(name),
    };
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
}

export function newtabRenderer() {
  const nodes = new Map();
  const node = key => {
    if (!nodes.has(key)) nodes.set(key, new Node());
    return nodes.get(key);
  };
  const lists = ['upcoming', 'todos'].map(list => node(`[data-list="${list}"]`));
  const counts = ['upcoming', 'todos'].map(list => node(`[data-count="${list}"]`));
  node('organato-lists').querySelector = node;
  const root = {
    documentElement: { dataset: {} },
    createElement: tag => new Node(tag),
    getElementById: node,
    querySelector: node,
    querySelectorAll: selector => selector === '[data-list]' ? lists : counts,
  };
  const source = readFileSync(new URL('../../../../features/ai/extension/newtab.js', import.meta.url), 'utf8');
  const render = runInNewContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '')
    + '\n({ normalizeView, renderSites, renderOrganato });', { document: { ...root, getElementById: () => null }, URL, Intl, Date });
  return { root, node, ...render };
}
