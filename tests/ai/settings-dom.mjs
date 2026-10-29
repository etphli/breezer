// Minimal DOM for driving settings.js under Node. It parses the shipped
// workspace.html and models only what the settings page touches, plus the
// browser behaviors that matter for it: disabled controls ignore input and
// lose focus (HTML focus fixup), and native range keys fire input + change.

const VOID = new Set(['meta', 'link', 'img', 'input', 'br', 'hr']);
const camelToData = (key) => `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
const dataToCamel = (name) => name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());

class FakeEvent {
  constructor(type, init = {}) {
    Object.assign(this, { bubbles: true, ...init, type });
    this.defaultPrevented = false;
    this.stopped = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
}

class Listeners {
  constructor() { this.map = new Map(); }
  addEventListener(type, fn) { if (!this.map.has(type)) this.map.set(type, []); this.map.get(type).push(fn); }
  removeEventListener(type, fn) { this.map.set(type, (this.map.get(type) || []).filter((item) => item !== fn)); }
  fire(event) { for (const fn of [...(this.map.get(event.type) || [])]) fn.call(this, event); }
}

class Element extends Listeners {
  constructor(doc, tag) {
    super();
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.attrs = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this._value = null;
    this.selected = false;
    this.style = { setProperty: (name, value) => { this.style[name] = value; } };
    this.dataset = new Proxy({}, {
      get: (_, key) => (typeof key === 'string' ? this.getAttribute(camelToData(key)) ?? undefined : undefined),
      set: (_, key, value) => { this.setAttribute(camelToData(key), String(value)); return true; },
      has: (_, key) => this.hasAttribute(camelToData(key)),
      ownKeys: () => [...this.attrs.keys()].filter((name) => name.startsWith('data-')).map(dataToCamel),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    });
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (...names) => { for (const name of names) if (!this.classList.contains(name)) this.className = `${this.className} ${name}`.trim(); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter((item) => item && !names.includes(item)).join(' '); },
      toggle: (name, force = !this.classList.contains(name)) => { if (force) this.classList.add(name); else this.classList.remove(name); return force; },
    };
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    const id = this.id ? `#${this.id}` : '';
    const value = this.dataset?.value ? `[data-value="${this.dataset.value}"]` : '';
    return `<${this.tagName.toLowerCase()}${id}${value}>`;
  }

  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
    if (name === 'disabled') this.ownerDocument.fixupFocus(this);
  }
  removeAttribute(name) { this.attrs.delete(name); }
  hasAttribute(name) { return this.attrs.has(name); }
  toggleAttribute(name, force) { if (force) this.setAttribute(name, ''); else this.removeAttribute(name); }

  get id() { return this.getAttribute('id') || ''; }
  set id(value) { this.setAttribute('id', value); }
  get className() { return this.getAttribute('class') || ''; }
  set className(value) { this.setAttribute('class', value); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value) { this.toggleAttribute('hidden', Boolean(value)); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(value) { this.toggleAttribute('disabled', Boolean(value)); }
  get title() { return this.getAttribute('title') || ''; }
  set title(value) { this.setAttribute('title', value); }
  get type() { return this.getAttribute('type') || (this.tagName === 'BUTTON' ? 'submit' : 'text'); }
  set type(value) { this.setAttribute('type', value); }
  get tabIndex() {
    const raw = this.getAttribute('tabindex');
    if (raw !== null) return Number(raw);
    return ['BUTTON', 'INPUT', 'SELECT'].includes(this.tagName) ? 0 : -1;
  }
  set tabIndex(value) { this.setAttribute('tabindex', String(value)); }

  get value() {
    if (this.tagName === 'SELECT') return (this.options.find((option) => option.selected) || this.options[0])?.value ?? '';
    if (this._value !== null) return this._value;
    return this.getAttribute('value') ?? (this.tagName === 'OPTION' ? this.textContent : '');
  }
  set value(next) {
    if (this.tagName === 'SELECT') { for (const option of this.options) option.selected = option.value === next; return; }
    let value = String(next);
    if (this.type === 'range') {
      const min = Number(this.getAttribute('min')); const max = Number(this.getAttribute('max'));
      value = String(Math.min(max, Math.max(min, Number(value))));
    }
    if (this.tagName === 'OPTION') this.setAttribute('value', value);
    else this._value = value;
  }
  get options() { return this.querySelectorAll('option'); }
  select() {}

  get children() { return this.childNodes.filter((node) => node instanceof Element); }
  get textContent() { return this.childNodes.map((node) => (node instanceof Element ? node.textContent : node)).join(''); }
  set textContent(value) { this.replaceChildren(String(value)); }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return node === this.ownerDocument.root; }

  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof Element) { node.remove(); node.parentNode = this; }
      this.childNodes.push(node instanceof Element ? node : String(node));
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) {
      if (child.contains(this.ownerDocument.activeElement)) this.ownerDocument.setFocus(null);
      child.parentNode = null;
    }
    this.childNodes = [];
    this.append(...nodes);
  }
  remove() {
    if (!this.parentNode) return;
    if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.setFocus(null);
    this.parentNode.childNodes = this.parentNode.childNodes.filter((node) => node !== this);
    this.parentNode = null;
  }
  contains(node) { for (let at = node; at; at = at.parentNode) if (at === this) return true; return false; }
  closest(selector) { for (let at = this; at instanceof Element; at = at.parentNode) if (at.matches(selector)) return at; return null; }
  matches(selector) { return selector.split(',').some((part) => matchChain(this, parseSelector(part.trim()))); }
  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => { for (const child of node.children) { if (child.matches(selector)) found.push(child); walk(child); } };
    walk(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  focus() {
    if (this.disabled || !this.isConnected) return;
    this.ownerDocument.setFocus(this);
  }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.setFocus(null); }

  dispatchEvent(event) {
    event.target ??= this;
    for (let at = this; at; at = at.parentNode) {
      event.currentTarget = at;
      at.fire(event);
      if (!event.bubbles || event.stopped) break;
    }
    if (event.bubbles && !event.stopped) this.ownerDocument.window.fire(event);
    return !event.defaultPrevented;
  }
}

function parseSelector(text) {
  return text.split(/\s+/).filter(Boolean).map((compound) => {
    const parts = { tag: null, ids: [], classes: [], attrs: [] };
    const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
    let match;
    while ((match = re.exec(compound))) {
      if (match[1]) parts.tag = match[1].toUpperCase();
      else if (match[2]) parts.ids.push(match[2]);
      else if (match[3]) parts.classes.push(match[3]);
      else parts.attrs.push([match[4], match[5]]);
    }
    return parts;
  });
}

function matchCompound(node, parts) {
  if (!(node instanceof Element)) return false;
  if (parts.tag && node.tagName !== parts.tag) return false;
  if (parts.ids.some((id) => node.id !== id)) return false;
  if (parts.classes.some((name) => !node.classList.contains(name))) return false;
  return parts.attrs.every(([name, value]) => (value === undefined ? node.hasAttribute(name) : node.getAttribute(name) === value));
}

function matchChain(node, chain) {
  if (!matchCompound(node, chain.at(-1))) return false;
  let at = node.parentNode;
  for (let index = chain.length - 2; index >= 0; index -= 1) {
    while (at && !matchCompound(at, chain[index])) at = at.parentNode;
    if (!at) return false;
    at = at.parentNode;
  }
  return true;
}

class Document extends Element {
  constructor(window) {
    super(null, '#document');
    this.ownerDocument = this;
    this.window = window;
    this.root = this;
    this.activeElement = null;
    this.title = '';
  }
  get documentElement() { return this.children[0]; }
  get body() { return this.querySelector('body'); }
  createElement(tag) { return new Element(this, tag); }
  getElementById(id) { return this.querySelector(`#${id}`); }

  setFocus(next) {
    const previous = this.activeElement && this.activeElement !== this.body ? this.activeElement : null;
    if (previous === next) return;
    this.activeElement = next || this.body;
    if (previous) {
      previous.dispatchEvent(new FakeEvent('blur', { bubbles: false, relatedTarget: next }));
      previous.dispatchEvent(new FakeEvent('focusout', { relatedTarget: next }));
    }
    if (next) next.dispatchEvent(new FakeEvent('focus', { bubbles: false }));
  }
  // HTML focus fixup: a focused control that becomes disabled loses focus.
  fixupFocus(node) { if (this.activeElement === node) this.setFocus(null); }
}

function parseHtml(doc, html) {
  const stack = [doc];
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/gi;
  let match;
  while ((match = re.exec(html))) {
    const [, close, open, attrText, selfClose, text] = match;
    const top = stack.at(-1);
    if (close) {
      while (stack.length > 1 && stack.pop().tagName !== close.toUpperCase());
    } else if (open) {
      const node = doc.createElement(open);
      for (const [, name, value] of attrText.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) node.attrs.set(name, value ?? '');
      top.append(node);
      if (!selfClose && !VOID.has(open.toLowerCase())) stack.push(node);
    } else if (text && top !== doc) {
      top.append(text.replace(/&amp;/g, '&'));
    }
  }
}

export function createDom(html) {
  const window = new Listeners();
  const document = new Document(window);
  parseHtml(document, html);
  for (const option of document.querySelectorAll('option')) option.selected = option.hasAttribute('selected');
  return {
    window,
    document,
    globals: {
      document,
      CSS: { escape: (value) => String(value).replace(/["\\]/g, '\\$&') },
      addEventListener: window.addEventListener.bind(window),
    },
  };
}

export const event = (type, init) => new FakeEvent(type, init);

// User-level actions with browser semantics for the controls settings.js uses.
export function userClick(node) {
  if (node.disabled) return;
  node.focus();
  node.dispatchEvent(new FakeEvent('click'));
}

export function userKey(document, key) {
  const target = document.activeElement;
  if (!target || target === document.body) return false;
  const proceed = target.dispatchEvent(new FakeEvent('keydown', { key }));
  if (proceed && target.tagName === 'INPUT' && target.type === 'range' && !target.disabled) {
    const step = Number(target.getAttribute('step') || 1) * ({ ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[key] || 0);
    if (!step) return true;
    const before = target.value;
    target.value = Number(target.value) + step;
    if (target.value !== before) {
      target.dispatchEvent(new FakeEvent('input'));
      target.dispatchEvent(new FakeEvent('change'));
    }
  }
  return true;
}

export function userType(node, text) {
  node.focus();
  node.value = text;
  node.dispatchEvent(new FakeEvent('input'));
}

export function userTab(document, next) {
  document.activeElement?.dispatchEvent(new FakeEvent('change'));
  next.focus();
}
