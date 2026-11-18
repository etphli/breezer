import assert from 'node:assert/strict';
import test from 'node:test';
import { harness } from './toolbar-harness.mjs';

test('unchanged acknowledged activation sends no extra native action setters', async () => {
    const h = harness(process.env.TOOLBAR_VARIANT ?? 'candidate');
    for (const id of [1, 2, 1, 2]) await h.send(id);
    assert.equal(h.tabCalls().length, 8);
    assert.equal(h.contextUpdates.length, 4);
    assert.equal(h.tabReads.length, 4);
});
