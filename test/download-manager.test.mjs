import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createDownloadManager } from '../lib/downloads.js';

function fixture({ search, start, timeoutMs, isCancelled } = {}) {
    const listeners = [];
    const revoked = [], cancelled = [];
    const downloads = {
        onChanged: { addListener(fn) { listeners.push(fn); } },
        download: start || (async () => 7),
        search: search || (async () => [{ id: 7, state: 'in_progress' }]),
        async cancel(id) { cancelled.push(id); }
    };
    const manager = createDownloadManager({ downloads, timeoutMs, isCancelled,
        revokeBlobUrl: url => revoked.push(url) });
    const emit = delta => listeners.forEach(fn => fn(delta));
    return { ...manager, emit, revoked, cancelled };
}

test('unrelated events and paused downloads cannot acknowledge this export', { timeout: 2000 }, async () => {
    const f = fixture();
    let settled = false;
    const result = f.download('blob:test', 'test.md').then(id => { settled = true; return id; });
    await tick();
    f.emit({ id: 8, state: { current: 'complete' } });
    f.emit({ id: 7, paused: { current: true } });
    await tick();
    assert.equal(settled, false);
    f.emit({ id: 7, state: { current: 'complete' } });
    assert.equal(await result, 7);
    f.emit({ id: 7, state: { current: 'interrupted' } });
    assert.deepEqual(f.revoked, ['blob:test']);
});

test('a missing download cannot be treated as saved', { timeout: 2000 }, async () => {
    const f = fixture({ search: async () => [] });
    await assert.rejects(f.download('blob:test', 'test.md'), /missing/);
    assert.deepEqual(f.cancelled, [7]);
    assert.deepEqual(f.revoked, ['blob:test']);
});

test('search errors fail closed and release the blob', { timeout: 2000 }, async () => {
    const f = fixture({ search: async () => { throw new Error('Query refused'); } });
    await assert.rejects(f.download('blob:test', 'test.md'), /Query refused/);
    assert.deepEqual(f.cancelled, [7]);
    assert.deepEqual(f.revoked, ['blob:test']);
});

test('a completion event wins over a late failed search', { timeout: 2000 }, async () => {
    let rejectSearch;
    const f = fixture({ search: () => new Promise((resolve, reject) => { rejectSearch = reject; }) });
    const result = f.download('blob:test', 'test.md');
    await tick();
    f.emit({ id: 7, state: { current: 'complete' } });
    assert.equal(await result, 7);
    rejectSearch(new Error('Late error'));
    await tick();
    assert.deepEqual(f.revoked, ['blob:test']);
    assert.deepEqual(f.cancelled, []);
});

test('timeout rejects and cancels an owned stalled download', { timeout: 2000 }, async () => {
    const f = fixture({ timeoutMs: 20 });
    await assert.rejects(f.download('blob:test', 'test.md'), /did not finish/);
    assert.deepEqual(f.cancelled, [7]);
    assert.deepEqual(f.revoked, ['blob:test']);
});

test('cancellation during the start request is handled once its ID is known', { timeout: 2000 }, async () => {
    let cancelled = false, returnId;
    const f = fixture({ isCancelled: () => cancelled,
        start: () => new Promise(resolve => { returnId = resolve; }) });
    const result = f.download('blob:test', 'test.md');
    cancelled = true;
    f.cancelPending();
    returnId(7);
    await assert.rejects(result, /USER_CANCELED/);
    assert.deepEqual(f.cancelled, [7]);
    assert.deepEqual(f.revoked, ['blob:test']);
});

test('a cancelled job cannot start another output file', { timeout: 2000 }, async () => {
    let starts = 0;
    const f = fixture({ isCancelled: () => true, start: async () => { starts++; return 7; } });
    await assert.rejects(f.download('blob:test', 'test.md'), /USER_CANCELED/);
    assert.equal(starts, 0);
    assert.deepEqual(f.revoked, ['blob:test']);
});
