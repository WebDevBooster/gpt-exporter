import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { test, afterEach } from 'node:test';
import { setTimeout as delay, setImmediate as tick } from 'node:timers/promises';

function event() {
    const listeners = new Set();
    return {
        addListener: fn => listeners.add(fn),
        removeListener: fn => listeners.delete(fn),
        emit: value => Promise.all([...listeners].map(fn => fn(value)))
    };
}

async function until(predicate, timeoutMs = 2000) {
    for (let i = 0; i < timeoutMs / 10; i++) {
        if (predicate()) return;
        await delay(10);
    }
    assert.fail('Fixture did not reach the expected state');
}

let serial = 0;
const fixtures = new Set();
afterEach(async () => {
    for (const f of fixtures) await f.cleanup();
    fixtures.clear();
});
async function fixture({ count = 1, startError, earlyState } = {}) {
    globalThis.indexedDB = new IDBFactory();
    const originalTimeout = globalThis.setTimeout;
    const originalNow = Date.now;
    let virtualTime = originalNow();
    Date.now = () => virtualTime;
    globalThis.setTimeout = (callback, ms, ...args) => ms <= 20000
        ? originalTimeout(() => { virtualTime += ms; callback(...args); }, 0)
        : originalTimeout(callback, ms, ...args);
    const conversations = Array.from({ length: count }, (_, i) => ({
        id: `1234567${i}-1234-5678-9abc-def012345678`,
        conversation_id: `1234567${i}-1234-5678-9abc-def012345678`,
        title: `Download fixture ${i}`, create_time: 1700000000, update_time: 1700000100,
        mapping: {}
    }));
    const storage = {};
    const downloads = [];
    const revoked = [];
    const generated = [];
    const onChanged = event();
    const onAlarm = event();
    const alarms = new Map(), badges = [], requests = [];
    let responder;
    let handler;
    globalThis.chrome = {
        alarms: { onAlarm, async create(name, info) { alarms.set(name, info); }, async clear(name) { alarms.delete(name); } },
        action: { async setBadgeText({ text }) { badges.push(text); }, async setBadgeBackgroundColor() {} },
        storage: { local: {
            async get(key) { return { [key]: storage[key] }; },
            async set(values) { Object.assign(storage, structuredClone(values)); }
        } },
        runtime: {
            onMessage: { addListener(fn) { handler = fn; } },
            async getPlatformInfo() { return {}; },
            async sendMessage(msg) {
                if (msg.action === 'revoke-blob-url') revoked.push(msg.url);
                if (msg.action === 'create-blob-url' || msg.action === 'create-zip-blob-url') {
                    generated.push(msg);
                    return { success: true, url: `blob:fixture-${generated.length}` };
                }
                return { success: true };
            }
        },
        offscreen: { async hasDocument() { return true; } },
        tabs: {
            async query() { return [{ id: 1, active: true, url: `https://chatgpt.com/c/${conversations[0].id}` }]; },
            async get() { return { id: 1, url: `https://chatgpt.com/c/${conversations[0].id}` }; },
            async sendMessage(id, msg) {
                requests.push(msg);
                const intercepted = responder?.(msg);
                if (intercepted) return intercepted;
                if (msg.action === 'getAccountContext') return { accountKey: 'fixture:personal' };
                if (msg.action === 'getProjectsList') return { items: [] };
                if (msg.action === 'getConversationsList') return { items: msg.offset === 0 ? conversations : [] };
                if (msg.action === 'getConversation') return structuredClone(conversations.find(c => c.id === msg.id));
                throw new Error(`Unexpected content request ${msg.action}`);
            }
        },
        downloads: {
            onChanged,
            async download(options) {
                if (startError) throw new Error(startError);
                const item = { id: downloads.length + 1, state: 'in_progress', options };
                downloads.push(item);
                if (earlyState) {
                    item.state = earlyState;
                    item.error = earlyState === 'interrupted' ? 'FILE_FAILED' : undefined;
                    onChanged.emit({ id: item.id, state: { current: item.state }, error: { current: item.error } });
                }
                return item.id;
            },
            async search({ id }) { return downloads.filter(d => d.id === id); },
            async cancel(id) { finish(id, 'interrupted', 'USER_CANCELED'); }
        }
    };
    function finish(id, state, error) {
        const item = downloads.find(d => d.id === id);
        Object.assign(item, { state, error });
        onChanged.emit({ id, state: { current: state }, error: { current: error } });
    }
    await import(`../background.js?download-fixture=${++serial}`);
    const exports = [];
    function send(message) {
        const result = new Promise(resolve => handler(message, {}, resolve));
        if (message.action.startsWith('export') || message.action === 'resumeExport') exports.push(result);
        return result;
    }
    const history = () => Object.keys(storage.gpt_exporter_sync_data?.exportedConversations || {});
    const f = { send, downloads, generated, revoked, history, finish, conversations, alarms, badges, requests,
        set responder(fn) { responder = fn; },
        advanceTo(time) { virtualTime = time; },
        alarm: () => onAlarm.emit({ name: 'gpt-exporter-resume' }),
        async restart() {
            // Drop listeners with the old worker; the IndexedDB factory survives.
            await import(`../background.js?download-fixture=${++serial}`);
            await send({ action: 'getExportState' });
        },
        async cleanup() {
            await send({ action: 'cancelExport' });
            for (const item of downloads.filter(item => item.state === 'in_progress')) {
                finish(item.id, 'interrupted', 'USER_CANCELED');
            }
            await Promise.all(exports);
            globalThis.setTimeout = originalTimeout;
            Date.now = originalNow;
        }
    };
    fixtures.add(f);
    return f;
}

for (const action of ['exportCurrentConversation', 'exportAll', 'exportNewUpdated']) {
    test(`${action}: pending or interrupted download cannot advance history`, { timeout: 5000 }, async () => {
        const f = await fixture();
        let replied = false;
        const result = f.send({ action, formats: { markdown: true }, limit: 1 }).then(r => { replied = true; return r; });
        try {
            await until(() => f.downloads.length === 1);
            await tick();
            assert.deepEqual(f.history(), [], 'History must stay unchanged while the file is still downloading');
            assert.equal(replied, false, 'Export must not reply with success before download completion');
            assert.equal((await f.send({ action: 'getExportState' })).phase, 'saving');
            f.finish(1, 'interrupted', 'FILE_FAILED');
            assert.match((await result).error, /FILE_FAILED/);
            assert.deepEqual(f.history(), [], 'Failed output must remain eligible for New/Updated');
            assert.deepEqual(f.revoked, ['blob:fixture-1']);
        } finally {
            if (!replied) f.finish(1, 'interrupted', 'USER_CANCELED');
            await result;
        }
    });
}

for (const action of ['exportCurrentConversation', 'exportAll', 'exportNewUpdated']) {
    test(`${action}: completed output advances history and the next incremental export skips it`, { timeout: 5000 }, async () => {
        const f = await fixture();
        const result = f.send({ action, formats: { markdown: true }, limit: 1 });
        await until(() => f.downloads.length === 1);
        f.finish(1, 'complete');
        assert.equal((await result).totalExported, 1);
        assert.deepEqual(f.history(), [f.conversations[0].id]);
        assert.deepEqual(f.revoked, ['blob:fixture-1']);
        assert.equal((await f.send({ action: 'exportNewUpdated', formats: { markdown: true }, limit: 1 })).totalExported, 0);
        assert.equal(f.downloads.length, 1);
    });
}

test('an interrupted export stays eligible for a successful incremental retry', { timeout: 5000 }, async () => {
    const f = await fixture();
    const first = f.send({ action: 'exportCurrentConversation', formats: { markdown: true } });
    await until(() => f.downloads.length === 1);
    f.finish(1, 'interrupted', 'USER_CANCELED');
    assert.match((await first).error, /USER_CANCELED/);
    await f.send({ action: 'discardExport' });
    const retry = f.send({ action: 'exportNewUpdated', formats: { markdown: true }, limit: 1 });
    await until(() => f.downloads.length === 2);
    assert.deepEqual(f.history(), []);
    f.finish(2, 'complete');
    assert.equal((await retry).totalExported, 1);
    assert.deepEqual(f.history(), [f.conversations[0].id]);
});

test('all requested formats must complete before a conversation enters history', { timeout: 5000 }, async () => {
    const f = await fixture();
    const result = f.send({ action: 'exportCurrentConversation', formats: { markdown: true, json: true } });
    await until(() => f.downloads.length === 1);
    f.finish(1, 'complete');
    await until(() => f.downloads.length === 2);
    assert.deepEqual(f.history(), [], 'Markdown alone cannot acknowledge a requested JSON backup');
    f.finish(2, 'interrupted', 'FILE_NO_SPACE');
    assert.match((await result).error, /FILE_NO_SPACE/);
    assert.deepEqual(f.history(), []);
    assert.equal(f.revoked.length, 2);
});

test('ZIP interruption and successful retry have the same history boundary', { timeout: 30000 }, async () => {
    const f = await fixture({ count: 4 });
    const run = () => f.send({ action: 'exportAll', formats: { markdown: true }, limit: 4 });
    const failed = run();
    await until(() => f.generated.some(g => g.action === 'create-zip-blob-url'), 15000);
    await until(() => f.downloads.length === 1);
    assert.equal(f.generated[0].files.length, 4);
    assert.match(f.downloads[0].options.filename, /\.zip$/);
    assert.deepEqual(f.history(), []);
    f.finish(1, 'interrupted', 'FILE_FAILED');
    assert.match((await failed).error, /FILE_FAILED/);
    assert.deepEqual(f.history(), []);
    const retry = f.send({ action: 'resumeExport' });
    await until(() => f.downloads.length === 2, 15000);
    f.finish(2, 'complete');
    assert.equal((await retry).totalExported, 4);
    assert.equal(f.history().length, 4);
});

test('already-finished downloads are reconciled even if their event preceded the returned ID', { timeout: 5000 }, async () => {
    const f = await fixture({ earlyState: 'complete' });
    const response = await f.send({ action: 'exportCurrentConversation', formats: { markdown: true } });
    assert.equal(response.totalExported, 1);
    assert.equal(f.history().length, 1);
    assert.deepEqual(f.revoked, ['blob:fixture-1']);
});

test('already-interrupted downloads are reconciled without advancing history', { timeout: 5000 }, async () => {
    const f = await fixture({ earlyState: 'interrupted' });
    const response = await f.send({ action: 'exportCurrentConversation', formats: { markdown: true } });
    assert.match(response.error, /FILE_FAILED/);
    assert.deepEqual(f.history(), []);
    assert.deepEqual(f.revoked, ['blob:fixture-1']);
});

test('download start failures release the generated blob without advancing history', { timeout: 5000 }, async () => {
    const f = await fixture({ startError: 'Download refused' });
    const response = await f.send({ action: 'exportCurrentConversation', formats: { markdown: true } });
    assert.match(response.error, /Download refused/);
    assert.deepEqual(f.history(), []);
    assert.deepEqual(f.revoked, ['blob:fixture-1']);
});

test('Cancel Export cancels the owned download and leaves history unchanged', { timeout: 5000 }, async () => {
    const f = await fixture();
    const result = f.send({ action: 'exportCurrentConversation', formats: { markdown: true } });
    await until(() => f.downloads.length === 1);
    assert.equal((await f.send({ action: 'cancelExport' })).success, true);
    assert.match((await result).error, /USER_CANCELED/);
    assert.equal(f.downloads[0].state, 'interrupted');
    assert.deepEqual(f.history(), []);
    assert.deepEqual(f.revoked, ['blob:fixture-1']);
});


test('real background wiring restores a cooldown, recreates alarms and finishes from the saved job', async () => {
    const f = await fixture({ earlyState: 'complete' });
    f.responder = msg => msg.action === 'getConversation' ? { error: '429', status: 429, retryAfter: '120' } : null;
    const result = await f.send({ action: 'exportAll', formats: { markdown: true }, limit: 1 });
    assert.ok(result.deferred);
    const state = await f.send({ action: 'getExportState' });
    assert.equal(state.status, 'cooldown');
    assert.equal(state.pending, 1);
    assert.equal(f.badges.at(-1), '429');
    const requests = f.requests.length;
    await f.restart();
    assert.equal(f.alarms.has('gpt-exporter-resume'), true);
    await f.alarm();
    assert.equal(f.requests.length, requests, 'An early alarm must not bypass the saved cooldown');
    f.responder = null;
    f.advanceTo(state.resumeAt);
    await f.alarm();
    assert.equal((await f.send({ action: 'getExportState' })).status, 'complete');
    assert.equal(f.history().length, 1);
    assert.equal(f.alarms.size, 0);
    assert.equal(f.badges.at(-1), '');
});

test('overlapping exports are blocked and user pause keeps fetched payloads for resume', async () => {
    const f = await fixture();
    const first = f.send({ action: 'exportAll', formats: { markdown: true }, limit: 1 });
    await until(() => f.downloads.length === 1);
    assert.match((await f.send({ action: 'exportAll', formats: { markdown: true } })).error, /already running/);
    assert.match((await f.send({ action: 'discardExport' })).error, /Pause/);
    await f.send({ action: 'cancelExport' });
    await first;
    const state = await f.send({ action: 'getExportState' });
    assert.equal(state.status, 'paused');
    assert.equal(state.fetched, 1);
    const fetchedCalls = f.requests.filter(r => r.action === 'getConversation').length;
    const retry = f.send({ action: 'resumeExport' });
    await until(() => f.downloads.length === 2);
    f.finish(2, 'complete');
    assert.equal((await retry).totalExported, 1);
    assert.equal(f.requests.filter(r => r.action === 'getConversation').length, fetchedCalls);
});

test('resuming a partly saved batch reuses its completed file receipt instead of downloading it twice', async () => {
    const f = await fixture();
    const first = f.send({ action: 'exportCurrentConversation', formats: { markdown: true, json: true } });
    await until(() => f.downloads.length === 1);
    f.finish(1, 'complete');
    await until(() => f.downloads.length === 2);
    f.finish(2, 'interrupted', 'FILE_FAILED');
    assert.match((await first).error, /FILE_FAILED/);
    assert.deepEqual(f.history(), []);
    await f.restart();
    const retry = f.send({ action: 'resumeExport' });
    await until(() => f.downloads.length === 3);
    assert.match(f.downloads[2].options.filename, /\.json$/);
    f.finish(3, 'complete');
    assert.equal((await retry).totalExported, 1);
    assert.equal(f.downloads.length, 3, 'The completed Markdown file must not be downloaded twice');
    assert.equal(f.history().length, 1);
});
