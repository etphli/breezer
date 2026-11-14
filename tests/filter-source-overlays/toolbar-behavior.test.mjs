import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, full, changedWrites } from './toolbar-harness.mjs';

const all = ['setIcon', 'setBadgeText', 'setBadgeBackgroundColor', 'setTitle'];
const pair = options => [harness('baseline', options), harness('candidate', options)];
const equal = (a, b) => {
    assert.deepEqual(b.snapshot(), a.snapshot());
    assert.deepEqual(b.contextUpdates, a.contextUpdates);
    assert.deepEqual(b.tabReads, a.tabReads);
};

test('A B A B: exact initial output and final values, context callbacks retained', async () => {
    const [a, b] = pair();
    for (const h of [a, b]) for (const id of [1, 2, 1, 2]) await h.send(id);
    assert.deepEqual(b.tabCalls(), a.tabCalls().slice(0, 8));
    assert.deepEqual(b.tabCalls().map(c => c.method), [...all, ...all]);
    assert.equal(a.tabCalls().length, 16);
    assert.equal(b.tabCalls().length, 8);
    equal(a, b);
    assert.deepEqual(changedWrites(b), changedWrites(a));
});

test('badge, title, color and icon transitions suppress only equal properties', async () => {
    const [a, b] = pair();
    const scenarios = [full, { ...full, badge: '13' }, { ...full, badge: '13', color: '#abc' },
        { ...full, state: 0, badge: '' }, { ...full, badge: '' }, { ...full, parts: 15 },
        full, { ...full, parts: 0, badge: 'title-only' }, { ...full, parts: undefined },
        { ...full, parts: 2, badge: 'text-only' }, { ...full, parts: 4, color: '#FC0' }];
    for (const details of scenarios) {
        await a.send(1, details); await b.send(1, details); equal(a, b);
    }
    assert.deepEqual(changedWrites(b), changedWrites(a));
    assert.deepEqual(b.tabCalls().map(c => c.method), [
        ...all, 'setBadgeText', 'setTitle', 'setBadgeBackgroundColor',
        ...all, 'setIcon', 'setTitle', 'setTitle',
        'setBadgeText', 'setTitle', 'setTitle', 'setBadgeText', 'setTitle',
        'setBadgeBackgroundColor', 'setTitle',
    ]);
});

test('all parts masks, filtering switches and formatted badges keep exact changed-state sequence', async () => {
    const [a, b] = pair();
    for (const h of [a, b]) {
        for (const state of [0, 1]) for (const badge of ['', '1', '1k', '!', '100k']) {
            for (const parts of [undefined, ...Array.from({ length: 16 }, (_, n) => n)]) {
                await h.send(1, { parts, state, badge, color: state ? '#123456' : '#666' });
            }
        }
    }
    equal(a, b); assert.deepEqual(changedWrites(b), changedWrites(a));
});

test('warning state and hidden badge preference still update tooltip and color', async () => {
    const [a, b] = pair();
    for (const h of [a, b]) {
        await h.send(); h.unprocessed.add(1); await h.send(); await h.send();
        await h.send(1, { ...full, parts: 15 }); h.unprocessed.delete(1);
        await h.send(1, { ...full, parts: 15 }); await h.send();
    }
    equal(a, b); assert.deepEqual(changedWrites(b), changedWrites(a));
    assert.equal(b.states.get(1).setTitle, 'uBlock Origin (12)');
    assert.ok(b.tabCalls().some(c => c.details.title === 'uBlock Origin (!)'));
});

test('image load switches from paths to ImageData once; mutable color arrays bypass cache', async () => {
    const [a, b] = pair();
    for (const h of [a, b]) {
        await h.send(); h.loadImages(); await h.send(); await h.send();
        const color = [1, 2, 3, 255]; await h.send(1, { ...full, color });
        color[0] = 4; await h.send(1, { ...full, color }); await h.send(1, { ...full, color });
    }
    equal(a, b); assert.deepEqual(changedWrites(b), changedWrites(a));
    assert.equal(b.tabCalls().filter(c => c.method === 'setIcon').length, 2);
    assert.equal(b.tabCalls().filter(c => c.method === 'setBadgeBackgroundColor').length, 4);
});

for (const transitionType of ['link', 'reload', 'auto_subframe', 'typed']) {
    test(`main-frame ${transitionType} commit clears cache before existing navigation handler`, async () => {
        const [a, b] = pair();
        for (const h of [a, b]) {
            await h.send();
            let repaint;
            h.tabEvents.onNavigation = details => { repaint = h.vAPI.setIcon(details.tabId, full); };
            h.commit(1, { transitionType, transitionQualifiers: ['forward_back'] });
            await repaint; await h.drain();
        }
        equal(a, b); assert.deepEqual(b.tabCalls(), a.tabCalls());
        assert.equal(b.tabCalls().length, 8);
    });
}

test('subframes retain overrides; same-document URL changes conservatively invalidate', async () => {
    const [a, b] = pair();
    for (const h of [a, b]) {
        await h.send(); h.commit(1, { frameId: 3 }); await h.send();
        h.browser.tabs.onUpdated.emit(1, { url: 'https://example.test/#hash' }, { url: 'https://example.test/#hash' });
        await h.send();
    }
    equal(a, b); assert.equal(b.tabCalls().length, 8);
});

test('close/reuse and replacement invalidate both affected ids and free settled records', async () => {
    const b = harness('candidate', { inspect: true });
    await b.send(1); await b.send(2); assert.equal(b.cache.size, 2);
    b.close(1); assert.equal(b.cache.size, 1);
    b.create(1); await b.send(1); assert.equal(b.tabCalls().length, 12);
    b.replace(); assert.equal(b.cache.size, 0);
    await b.send(2); assert.equal(b.tabCalls().length, 16);
    b.close(2); assert.equal(b.cache.size, 0);
});

for (const method of all) for (const failure of ['error', 'throw']) {
    test(`${method} ${failure} is never acknowledged as cached and retries alone`, async () => {
        const [a, b] = pair();
        for (const h of [a, b]) {
            h.fail(method, failure); await h.send(); await h.send(); await h.send();
        }
        equal(a, b); assert.deepEqual(changedWrites(b), changedWrites(a));
        assert.deepEqual(b.tabCalls().map(c => c.method), [...all, method]);
        assert.equal(b.errors.length, failure === 'throw' ? 1 : 0);
    });
}

test('no-icon platform keeps title-only fallback and retries', async () => {
    const [a, b] = pair({ supported: false });
    for (const h of [a, b]) { await h.send(); await h.send(); h.commit(); await h.send(); }
    equal(a, b); assert.deepEqual(b.tabCalls().map(c => c.method), ['setTitle', 'setTitle']);
});

test('global default calls remain unchanged and cannot overwrite explicit cached tab values', async () => {
    const [a, b] = pair();
    for (const h of [a, b]) {
        await h.send();
        for (const args of [['-loading', ''], ['-loading', '!'], ['', '']]) h.vAPI.setDefaultIcon(...args);
        await h.drain(); await h.send();
    }
    equal(a, b);
    assert.deepEqual(b.calls.filter(c => c.details.tabId === undefined), a.calls.filter(c => c.details.tabId === undefined));
    assert.equal(b.tabCalls().length, 4);
});

test('invalid and nonexistent tabs never acquire cached state or context callbacks', async () => {
    const [a, b] = pair({ inspect: true });
    for (const h of [a, b]) for (const id of [0, NaN, '1', -1, 999]) await h.send(id);
    equal(a, b); assert.equal(b.cache.size, 0); assert.equal(b.tabCalls().length, 0);
});

test('tabs.get completion reordering preserves actual baseline action sequence', async () => {
    const [a, b] = pair();
    for (const h of [a, b]) {
        h.deferTabs();
        const older = h.vAPI.setIcon(1, { ...full, badge: 'old' });
        const newer = h.vAPI.setIcon(1, { ...full, badge: 'new' });
        h.tabPending[1].resolve({ id: 1, status: 'complete' }); await newer; await h.drain();
        h.tabPending[0].resolve({ id: 1, status: 'complete' }); await older; await h.drain();
    }
    equal(a, b); assert.deepEqual(changedWrites(b), changedWrites(a));
    assert.equal(b.states.get(1).setBadgeText, 'old');
    assert.deepEqual(b.tabCalls().slice(4).map(c => c.method), ['setBadgeText', 'setTitle']);
});

test('tab closes while get is pending: null response preserves no-output behavior', async () => {
    const [a, b] = pair();
    for (const h of [a, b]) {
        h.deferTabs(); const promise = h.vAPI.setIcon(1, full);
        h.close(); h.tabPending[0].resolve(null); await promise; await h.drain();
    }
    equal(a, b); assert.equal(b.tabCalls().length, 0);
});

for (const reverseApply of [false, true]) for (const reverseAck of [false, true]) {
    test(`overlap: reverse apply ${reverseApply}, reverse callbacks ${reverseAck}, no stale cache`, async () => {
        const [a, b] = pair({ manual: true });
        for (const h of [a, b]) {
            await h.send(1, { ...full, badge: 'old' });
            await h.send(1, { ...full, badge: 'new', state: 0, color: '#fff' });
            assert.equal(h.pending.length, 8);
            const apply = reverseApply ? [...h.pending].reverse() : h.pending;
            const ack = reverseAck ? [...h.pending].reverse() : h.pending;
            for (const p of apply) p.apply();
            for (const p of ack) p.ack();
            await h.drain();
            const start = h.pending.length;
            await h.send(1, { ...full, badge: 'new', state: 0, color: '#fff' });
            assert.equal(h.pending.length - start, 4);
            for (const p of h.pending.slice(start)) p.finish();
            await h.drain();
        }
        equal(a, b); assert.deepEqual(b.tabCalls(), a.tabCalls());
        assert.deepEqual(changedWrites(b), changedWrites(a));
        await b.send(1, { ...full, badge: 'new', state: 0, color: '#fff' });
        assert.equal(b.pending.length, 12);
    });
}

for (const lifecycle of ['commit', 'close-reuse', 'replace']) {
    test(`late native writes across ${lifecycle} cannot seed or overwrite a trusted cache`, async () => {
        const [a, b] = pair({ manual: true, inspect: true });
        for (const h of [a, b]) {
            await h.send();
            if (lifecycle === 'commit') h.commit();
            else if (lifecycle === 'close-reuse') { h.close(); h.create(); }
            else { h.replace(1, 2); }
            await h.send(1, { ...full, badge: 'new', state: 0, color: '#fff' });
            for (const p of h.pending.slice(4)) p.finish();
            await h.drain();
            for (const p of h.pending.slice(0, 4)) p.finish();
            await h.drain();
            await h.send(1, { ...full, badge: 'new', state: 0, color: '#fff' });
            assert.equal(h.pending.length, 12);
            for (const p of h.pending.slice(8)) p.finish();
            await h.drain();
        }
        equal(a, b); assert.deepEqual(b.tabCalls(), a.tabCalls());
        assert.deepEqual(changedWrites(b), changedWrites(a));
    });
}

test('commit after native apply but before acknowledgement forces resend; no old epoch promotion', async () => {
    const b = harness('candidate', { manual: true, inspect: true });
    await b.send(); for (const p of b.pending) p.apply();
    b.commit(); for (const p of b.pending) p.ack(); await b.drain();
    await b.send(); assert.equal(b.pending.length, 8);
    for (const p of b.pending.slice(4)) p.finish(); await b.drain();
    await b.send(); assert.equal(b.pending.length, 8);
    b.close(); assert.equal(b.cache.size, 0);
});

test('closed records retain only outstanding work, then disappear even on failure', async () => {
    const b = harness('candidate', { manual: true, inspect: true });
    b.fail('setTitle'); await b.send(); b.close();
    assert.equal(b.cache.size, 1);
    for (const p of b.pending) p.finish(); await b.drain();
    assert.equal(b.cache.size, 0);
});

test('committed error pages invalidate without onCommitted; subframe failures do not', async () => {
    const [a, b] = pair();
    for (const h of [a, b]) {
        await h.send();
        h.browser.webNavigation.onErrorOccurred.emit({ tabId: 1, frameId: 2 });
        await h.send();
        h.clear(1);
        h.browser.webNavigation.onErrorOccurred.emit({ tabId: 1, frameId: 0 });
        await h.send();
    }
    equal(a, b); assert.equal(b.tabCalls().length, 8);
});

test('status events cover internal-page navigation without webNavigation events', async () => {
    const [a, b] = pair();
    for (const h of [a, b]) {
        await h.send();
        h.browser.tabs.onUpdated.emit(1, { title: 'page title' }, {});
        await h.send();
        h.browser.tabs.onUpdated.emit(1, { status: 'loading' }, {});
        h.clear(1);
        h.browser.tabs.onUpdated.emit(1, { status: 'complete' }, {});
        await h.send();
    }
    equal(a, b); assert.equal(b.tabCalls().length, 8);
});

test('loading or unknown status never deduplicates; completion resumes stable caching', async () => {
    const [a, b] = pair();
    for (const h of [a, b]) {
        await h.send();
        for (const status of ['loading', undefined]) {
            h.tabs.set(1, { id: 1, status });
            await h.send(); h.clear(1); await h.send();
        }
        h.tabs.set(1, { id: 1, status: 'complete' });
        h.browser.tabs.onUpdated.emit(1, { status: 'complete' }, {});
        await h.send(); await h.send();
    }
    equal(a, b); assert.equal(b.tabCalls().length, 24);
});

test('identical overlapping calls remain unsuppressed, then one solo acknowledgement restores caching', async () => {
    const b = harness('candidate', { manual: true });
    await b.send(); await b.send();
    assert.equal(b.pending.length, 8);
    for (const p of b.pending) p.finish(); await b.drain();
    await b.send(); assert.equal(b.pending.length, 12);
    for (const p of b.pending.slice(8)) p.finish(); await b.drain();
    await b.send(); assert.equal(b.pending.length, 12);
});

test('retained records are bounded by live tabs plus tabs with outstanding native writes', async () => {
    const b = harness('candidate', { inspect: true });
    for (let id = 1; id <= 64; id++) {
        b.create(id); await b.send(id);
        assert.equal(b.cache.size, id);
    }
    for (const entry of b.cache.values()) {
        assert.equal(entry.actions.size, 4);
        assert.equal(entry.pending, 0);
        for (const action of entry.actions.values()) assert.equal(action.pending, 0);
    }
    for (let id = 1; id <= 64; id++) b.close(id);
    assert.equal(b.cache.size, 0);
});

test('actual bound toolbar caller preserves settings, partial masks and idle merging', async () => {
    const [a, b] = pair();
    for (const h of [a, b]) {
        const { ub, store, idle, flush } = h.installToolbarCaller();
        ub.updateToolbarIcon(1); await flush();
        ub.updateToolbarIcon(1); await flush();
        ub.userSettings.showIconBadge = false;
        ub.updateToolbarIcon(1); await flush();
        store.counts.blocked.any = 13;
        ub.updateToolbarIcon(1, 2); await flush();
        ub.bits = 2;
        ub.updateToolbarIcon(1, 4); await flush();
        ub.userSettings.showIconBadge = true;
        ub.updateToolbarIcon(1, 2); ub.updateToolbarIcon(1, 4);
        assert.equal(idle.length, 1); await flush();
        store.enabled = false;
        ub.updateToolbarIcon(1); await flush();
    }
    equal(a, b); assert.deepEqual(changedWrites(b), changedWrites(a));
    assert.equal(b.states.get(1).setTitle, 'uBlock Origin (off)');
    assert.equal(b.states.get(1).setBadgeText, '');
    assert.deepEqual(b.tabCalls().map(c => c.method), [
        ...all, 'setBadgeText', 'setTitle', 'setBadgeBackgroundColor', 'setTitle',
        'setBadgeText', 'setTitle', 'setIcon', 'setBadgeText', 'setBadgeBackgroundColor', 'setTitle',
    ]);
});
