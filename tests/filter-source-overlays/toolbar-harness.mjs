import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { root } from './fixtures/main-port-20261115/fixture.mjs';

const methods = ['setIcon', 'setBadgeText', 'setBadgeBackgroundColor', 'setTitle'];
export const full = { parts: 7, state: 1, badge: '12', color: '#666' };

function section(source, start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    assert.ok(a >= 0 && b > a, `missing source boundary ${start}`);
    return source.slice(a, b);
}

export function harness(variant, { manual = false, supported = true, inspect = false } = {}) {
    const source = fs.readFileSync(join(root(variant === 'candidate' ? 'source' : 'baseline'), 'vapi-background.js'), 'utf8');
    const adapter = fs.readFileSync(join(root(variant === 'candidate' ? 'source' : 'baseline'), 'webext.js'), 'utf8');
    const calls = [], writes = [], pending = [], errors = [], contextUpdates = [], tabReads = [];
    const states = new Map(), tabs = new Map([[1, { id: 1, status: 'complete' }], [2, { id: 2, status: 'complete' }]]);
    const failures = new Map(), unprocessed = new Set(), images = [], tabPending = [];
    let deferTabs = false;
    const event = () => {
        const listeners = [];
        return { addListener(fn) { listeners.push(fn); }, emit(...args) { for (const fn of listeners) fn(...args); } };
    };
    const browser = {
        runtime: { getManifest: () => ({ browser_action: { default_title: 'uBlock Origin' } }) },
        tabs: { onCreated: event(), onRemoved: event(), onReplaced: event(), onUpdated: event(), onActivated: event() },
        webNavigation: { onCommitted: event(), onErrorOccurred: event(), onCreatedNavigationTarget: event() },
        browserAction: { onClicked: event() },
    };
    const chrome = { runtime: {}, browserAction: {} };
    const visible = () => structuredClone([...states].sort(([a], [b]) => String(a).localeCompare(String(b))));
    for (const method of methods) {
        if (!supported && method === 'setIcon') continue;
        chrome.browserAction[method] = (details, callback) => {
            const call = { method, details: structuredClone(details) };
            calls.push(call);
            const failure = failures.get(method);
            failures.delete(method);
            if (failure === 'throw') throw Error(`throw ${method}`);
            const item = {
                call, applied: false, acknowledged: false,
                apply() {
                    assert.equal(this.applied, false);
                    this.applied = true;
                    if (failure) return;
                    const target = call.details.tabId ?? 'global';
                    const state = states.get(target) ?? {};
                    const value = method === 'setIcon' ? call.details.path ?? call.details.imageData
                        : call.details[{ setBadgeText: 'text', setBadgeBackgroundColor: 'color', setTitle: 'title' }[method]];
                    state[method] = value;
                    states.set(target, state);
                    writes.push({ call, visible: visible() });
                },
                ack() {
                    assert.equal(this.acknowledged, false);
                    this.acknowledged = true;
                    chrome.runtime.lastError = failure ? { message: `failed ${method}` } : undefined;
                    callback();
                    chrome.runtime.lastError = undefined;
                },
                finish() { this.apply(); this.ack(); },
            };
            if (manual && details.tabId !== undefined) pending.push(item);
            else queueMicrotask(() => item.finish());
        };
    }
    const vAPI = {
        webextFlavor: { soup: new Set(['chromium']) },
        tabs: {
            async get(id) {
                tabReads.push(id);
                if (deferTabs) return new Promise(resolve => tabPending.push({ id, resolve }));
                return tabs.get(id) ?? null;
            },
        },
        net: { hasUnprocessedRequest: id => unprocessed.has(id) },
        contextMenu: { onMustUpdate: id => contextUpdates.push(id) },
    };
    class Image {
        constructor() { this.complete = false; images.push(this); }
        addEventListener(_, fn) { this.loaded = fn; }
        set src(value) { this.naturalWidth = this.naturalHeight = value.includes('_32') ? 32 : 16; }
    }
    const context = vm.createContext({ vAPI, browser, chrome, Object, Image, Uint8ClampedArray,
        console: { error: error => errors.push(error.message) },
        document: { createElement: () => ({ getContext: () => ({ clearRect() {}, drawImage() {},
            getImageData: (_, __, width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
        }) }) },
    });
    const helpers = section(adapter, 'const promisifyNoFail =', 'const promisify =');
    const action = section(adapter, '    browserAction: {', '    // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/menus');
    const tabClass = section(source, 'const toTabId = function(', '\n/******************************************************************************/\n/******************************************************************************/\n\nif ( webext.windows');
    const wrapper = section(source, 'if ( webext.browserAction instanceof Object ) {', '\n/******************************************************************************/');
    let icon = section(source, '{\n    const browserAction = vAPI.browserAction;', '\nbrowser.browserAction.onClicked');
    if (inspect) icon = icon.replace('const tabActions = new Map();', 'const tabActions = globalThis.actionCache = new Map();');
    context.webext = new Function('chrome', 'console',
        `${helpers}\nconst webext = { ${action} }; return webext;`
    )(chrome, { error: error => errors.push(error.message) });
    if (!supported) context.webext.browserAction.setIcon = undefined;
    vm.runInContext(`${tabClass}\n${wrapper}\n${icon}`, context);
    // Run the actual existing tab lifecycle dispatch after adapter listeners register.
    vm.runInContext('globalThis.tabEvents = new vAPI.Tabs();', context);
    return {
        vAPI, browser, calls, writes, pending, errors, states, tabs, tabReads, contextUpdates, unprocessed,
        cache: context.actionCache, tabEvents: context.tabEvents, tabPending,
        fail(method, mode = 'error') { failures.set(method, mode); },
        deferTabs(value = true) { deferTabs = value; },
        async drain() { for (let i = 0; i < 16; i++) await Promise.resolve(); },
        async send(id = 1, details = full) { await vAPI.setIcon(id, details); await this.drain(); },
        tabCalls() { return structuredClone(calls.filter(c => c.details.tabId !== undefined)); },
        snapshot: visible,
        clear(id) { states.delete(id); },
        commit(id = 1, extra = {}) {
            const details = { tabId: id, frameId: 0, url: 'https://example.test/', transitionType: 'link', ...extra };
            if (details.frameId === 0) states.delete(id);
            browser.webNavigation.onCommitted.emit(details);
        },
        close(id = 1) { tabs.delete(id); states.delete(id); browser.tabs.onRemoved.emit(id, {}); },
        create(id = 1) { tabs.set(id, { id, status: 'complete' }); browser.tabs.onCreated.emit({ id }); },
        replace(added = 2, removed = 1) {
            states.delete(added); states.delete(removed); tabs.delete(removed); tabs.set(added, { id: added, status: 'complete' });
            browser.tabs.onReplaced.emit(added, removed);
        },
        loadImages() { for (const img of images) img.complete = true; images.at(-1)?.loaded(); },
        installToolbarCaller() {
            const tabSource = fs.readFileSync(join(root('source'), 'tab.js'), 'utf8');
            assert.equal(createHash('sha256').update(tabSource).digest('hex'),
                'bf366709e8e9eba12e9028efb30593c9300db83665d5d579b0b9a154044234a8');
            const store = { enabled: true, counts: { blocked: { any: 12 } }, tabHostname: 'example.test',
                getNetFilteringSwitch() { return this.enabled; } };
            const idle = [];
            const ub = {
                readyToFilter: true, userSettings: { showIconBadge: true }, bits: 0,
                blockingProfileColorCache: new Map(), liveBlockingProfiles: [{ bits: 2, color: '#f00' }, { bits: 0, color: '#666' }],
                blockingModeFromHostname() { return this.bits; }, pageStoreFromTabId: () => store,
                formatCount: n => String(n),
            };
            context['µb'] = ub;
            context.self = { requestIdleCallback: (fn, options) => { assert.equal(options.timeout, 701); idle.push(fn); } };
            vAPI.isBehindTheSceneTabId = id => id < 0;
            vm.runInContext(section(tabSource, '{\n    const tabIdToDetails = new Map();', '\n/******************************************************************************/'), context);
            return { ub, store, idle, flush: async () => { for (const fn of idle.splice(0)) fn(); await this.drain(); } };
        },
    };
}

export function changedWrites(h) {
    let prior;
    return h.writes.filter(({ visible }) => {
        const next = JSON.stringify(visible);
        if (next === prior) return false;
        prior = next;
        return true;
    }).map(({ visible }) => visible);
}
