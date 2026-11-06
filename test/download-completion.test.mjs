import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { test, afterEach } from 'node:test';
import { setTimeout as delay, setImmediate as tick } from 'node:timers/promises';
import { createExportStore } from '../lib/export-store.js';
import { buildSavedArchive } from '../export/files.js';
import '../lib/jszip.min.js';

function event() {
    const listeners = new Set();
    return {
        addListener: fn => listeners.add(fn),
        removeListener: fn => listeners.delete(fn),
        clear: () => listeners.clear(),
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
    const generated = [], archives = [];
    const store = createExportStore();
    const onChanged = event();
    const onAlarm = event();
    const alarms = new Map(), badges = [], requests = [], notifications = [];
    let responder;
    let downloadStart;
    let handler;
    globalThis.chrome = {
        alarms: { onAlarm, async create(name, info) { alarms.set(name, info); }, async clear(name) { alarms.delete(name); } },
        action: { async setBadgeText({ text }) { badges.push(text); }, async setBadgeBackgroundColor() {} },
        storage: { local: {
            async get(key) { return { [key]: storage[key] }; },
            async set(values) { Object.assign(storage, structuredClone(values)); }
        } },
        runtime: {
            id: 'fixture-extension',
            getURL: path => `chrome-extension://fixture-extension/${path}`,
            onMessage: { addListener(fn) { handler = fn; } },
            async getPlatformInfo() { return {}; },
            async sendMessage(msg) {
                if (msg.type === 'progress') notifications.push({ phase: msg.phase, status: msg.status, listed: msg.listed, fetched: msg.fetched, activity: msg.activity });
                if (msg.action === 'revoke-blob-url') revoked.push(msg.url);
                if (msg.action === 'create-saved-archive') {
                    generated.push(msg);
                    const { blob, ...receipt } = await buildSavedArchive(msg, store, globalThis.JSZip);
                    archives.push(blob);
                    return { success: true, url: `blob:fixture-${generated.length}`, ...receipt };
                }
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
                if (msg.action === 'abortExportRequests') return { success: true };
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
                if (downloadStart) return downloadStart(item);
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
    function send(message, sender = { id: chrome.runtime.id, url: chrome.runtime.getURL('popup/popup.html') }) {
        // Chrome closes the channel if the listener returns without replying.
        const result = new Promise(resolve => {
            if (handler(message, sender, resolve) !== true) resolve(undefined);
        });
        if (message.action.startsWith('export') || ['resumeExport', 'endAndExport'].includes(message.action)) exports.push(result);
        return result;
    }
    const history = () => Object.keys(storage.gpt_exporter_sync_data?.exportedConversations || {});
    const f = { send, downloads, generated, archives, store, revoked, history, finish, conversations, alarms, badges, requests, notifications,
        set responder(fn) { responder = fn; },
        set downloadStart(fn) { downloadStart = fn; },
        advanceTo(time) { virtualTime = time; },
        alarm: () => onAlarm.emit({ name: 'gpt-exporter-resume' }),
        async restart() {
            // Drop listeners with the old worker; the IndexedDB factory survives.
            onAlarm.clear();
            onChanged.clear();
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
    await until(() => f.generated.some(g => g.action === 'create-saved-archive'), 15000);
    await until(() => f.downloads.length === 1);
    assert.equal(f.generated[0].ids.length, 4);
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
    assert.equal((await result).cancelled, true);
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
    await f.send({ action: 'pauseExport' });
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


for (const detached of [false, true]) {
    test(`${detached ? 'detached window' : 'toolbar popup'} can check connection, read saved state and export`, async () => {
        const f = await fixture({ earlyState: 'complete' });
        f.responder = msg => msg.action === 'ping' ? { success: true } : null;
        const url = chrome.runtime.getURL('popup/popup.html');
        const sender = { id: chrome.runtime.id, url, ...(detached ? { tab: { id: 99, url, windowId: 2 } } : {}) };
        assert.equal((await f.send({ action: 'checkConnection' }, sender)).connected, true);
        assert.equal((await f.send({ action: 'getExportState' }, sender)).isRunning, false);
        const result = await f.send({ action: 'exportAll', formats: { markdown: true }, limit: 1 }, sender);
        assert.equal(result.totalExported, 1);
        assert.equal(f.history().length, 1);
    });
}

test('web content and unrelated extension documents cannot control the saved export', async () => {
    const f = await fixture();
    const first = f.send({ action: 'exportAll', formats: { markdown: true }, limit: 1 });
    await until(() => f.downloads.length === 1);
    const before = await f.send({ action: 'getExportState' });
    for (const sender of [
        { id: chrome.runtime.id, url: 'https://chatgpt.com/', tab: { id: 1 } },
        { id: chrome.runtime.id, url: chrome.runtime.getURL('offscreen.html') },
        { id: 'another-extension', url: chrome.runtime.getURL('popup/popup.html') },
        {}
    ]) {
        for (const action of ['discardExport', 'cancelExport', 'clearHistory', 'getStats']) {
            const denied = await f.send({ action }, sender);
            assert.match(denied.error, /extension window/);
        }
    }
    const after = await f.send({ action: 'getExportState' });
    assert.equal(after.fetched, before.fetched);
    assert.equal(after.status, before.status);
    f.finish(1, 'complete');
    assert.equal((await first).totalExported, 1);
});


test('connection checks preserve a content-script failure for the extension window', async () => {
    const f = await fixture();
    f.responder = msg => msg.action === 'ping' ? { error: 'The ChatGPT page needs reloading.' } : null;
    const result = await f.send({ action: 'checkConnection' });
    assert.equal(result.connected, false);
    assert.equal(result.error, 'The ChatGPT page needs reloading.');
});


test('Export All: 2515 conversations traverse pagination, 429 at 217 and worker restarts to completion', { timeout: 30000 }, async () => {
    const f = await fixture({ count: 2515, earlyState: 'complete' });
    let throttle = true;
    f.responder = msg => {
        if (msg.action === 'getConversationsList') return { items: structuredClone(f.conversations.slice(msg.offset, msg.offset + msg.limit)) };
        if (msg.action === 'getConversation' && msg.id === f.conversations[216].id && throttle) {
            throttle = false;
            return { error: '429', status: 429, retryAfter: '120' };
        }
        return null;
    };
    await f.send({ action: 'exportAll', formats: { markdown: true } });
    let rounds = 0;
    for (;;) {
        const state = await f.send({ action: 'getExportState' });
        if (state.status === 'complete') break;
        assert.ok(['waiting', 'cooldown'].includes(state.status), JSON.stringify(state));
        assert.ok(++rounds < 300, 'Export All must make progress rather than endlessly reschedule');
        f.advanceTo(state.resumeAt);
        await f.restart();
        await f.alarm();
    }
    assert.ok(rounds > 50, 'This test must exercise many bounded worker runs');
    assert.equal(f.history().length, 2515);
    assert.equal(f.downloads.length, 1);
    assert.match(f.downloads[0].options.filename, /\.zip$/);
    assert.equal(f.requests.filter(r => r.action === 'getConversation').length, 2516, 'Only the throttled conversation is retried');
    assert.equal(f.requests.filter(r => r.action === 'getConversation' && r.id === f.conversations[0].id).length, 1);
    assert.equal(f.requests.filter(r => r.action === 'getConversation' && r.id === f.conversations[216].id).length, 2);
    assert.equal(f.requests.filter(r => r.action === 'getConversationsList').length, 91, 'Successful list pages must be reused after restarts');
    const listing = f.notifications.filter(n => n.phase === 'fetching_list').map(n => n.listed || 0);
    assert.ok(listing.some(n => n > 0), 'Listing progress must be visible before conversation contents are fetched');
    assert.ok(listing.every((n, i) => !i || n >= listing[i - 1]), 'Resuming discovery must not reset its visible progress');
    assert.equal(f.alarms.size, 0);
});

for (const blockedAction of ['getAccountContext', 'getConversationsList', 'getConversation']) {
test(`Cancel Export All interrupts ${blockedAction}, clears scheduling and allows a fresh export`, { timeout: 5000 }, async () => {
    const f = await fixture({ earlyState: 'complete' });
    let resolveLate;
    f.responder = msg => msg.action === blockedAction
        ? new Promise(resolve => { resolveLate = resolve; }) : null;
    const first = f.send({ action: 'exportAll', formats: { markdown: true }, limit: 1 });
    await until(() => !!resolveLate);
    assert.equal((await f.send({ action: 'cancelExport' })).success, true);
    assert.equal((await first).cancelled, true);
    const cancelled = await f.send({ action: 'getExportState' });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.canCancel, false);
    assert.equal(cancelled.canResume, false);
    assert.equal(f.alarms.size, 0);
    f.responder = null;
    const next = await f.send({ action: 'exportAll', formats: { markdown: true }, limit: 1 });
    assert.equal(next.totalExported, 1);
    resolveLate(structuredClone(f.conversations[0]));
    await tick();
    assert.equal((await f.send({ action: 'getExportState' })).status, 'complete', 'A late response cannot resurrect the cancelled job');
});

}

test('Cancel works during cooldown and paused jobs without bypassing the server deadline', async () => {
    const f = await fixture();
    f.responder = msg => msg.action === 'getConversation' ? { error: '429', status: 429, retryAfter: '120' } : null;
    await f.send({ action: 'exportAll', formats: { markdown: true }, limit: 1 });
    const cooldown = await f.send({ action: 'getExportState' });
    assert.equal(cooldown.status, 'cooldown');
    await f.send({ action: 'pauseExport' });
    assert.equal((await f.send({ action: 'getExportState' })).canCancel, true);
    await f.send({ action: 'cancelExport' });
    assert.equal((await f.send({ action: 'getExportState' })).status, 'cancelled');
    const count = f.requests.length;
    await f.send({ action: 'exportAll', formats: { markdown: true }, limit: 1 });
    assert.equal(f.requests.length, count);
    assert.equal((await f.send({ action: 'getExportState' })).resumeAt, cooldown.resumeAt);
});


test('cancel during a pending download start cannot affect a later export or acknowledge old output', async () => {
    const f = await fixture();
    let releaseOld;
    f.downloadStart = item => new Promise(resolve => { releaseOld = () => resolve(item.id); });
    const first = f.send({ action: 'exportAll', formats: { markdown: true }, limit: 1 });
    await until(() => !!releaseOld);
    await f.send({ action: 'cancelExport' });
    assert.equal((await first).cancelled, true);
    f.downloadStart = null;
    const fresh = f.send({ action: 'exportAll', formats: { markdown: true }, limit: 1 });
    await until(() => f.downloads.length === 2);
    await tick();
    releaseOld();
    await until(() => f.downloads[0].state === 'interrupted');
    assert.equal(f.downloads[1].state, 'in_progress', 'An old job must never cancel the new job’s download');
    assert.deepEqual(f.history(), []);
    f.finish(2, 'complete');
    assert.equal((await fresh).totalExported, 1);
    assert.equal((await f.send({ action: 'getExportState' })).status, 'complete');
});

test('Export All remains available when the Current Chat button has no focused conversation', async () => {
    const f = await fixture({ earlyState: 'complete' });
    const query = chrome.tabs.query;
    chrome.tabs.query = async options => options.active ? [] : query(options);
    const availability = await f.send({ action: 'getCurrentConversationTarget' });
    assert.equal(availability.available, false);
    assert.equal(availability.error, undefined, 'Current Chat availability must not appear as an Export All error');
    assert.match(availability.reason, /No active ChatGPT conversation/);
    assert.equal((await f.send({ action: 'exportAll', formats: { markdown: true }, limit: 1 })).totalExported, 1);
});

test('Export All downloads an exceptions report and never acknowledges omitted conversations in history', async () => {
    const f = await fixture({ count: 4, earlyState: 'complete' });
    f.responder = message => message.action === 'getConversation' && message.id === f.conversations[1].id
        ? { error: 'API Error: 403', status: 403, detail: '{"detail":"Permission denied"}' } : null;
    const result = await f.send({ action: 'exportAll', formats: { markdown: true }, limit: 0 });
    assert.equal(result.totalExported, 3);
    assert.equal(result.exceptions, 1);
    assert.equal(f.history().length, 3);
    assert.ok(!f.history().includes(f.conversations[1].id));
    const reportFile = f.generated[0].report;
    assert.equal(f.downloads.length, 1);
    assert.ok(reportFile);
    const report = JSON.parse(reportFile.content);
    assert.equal(report.requested, 4);
    assert.equal(report.exported, 3);
    assert.equal(report.notExported, 1);
    assert.equal(report.exceptions[0].id, f.conversations[1].id);
    assert.equal(report.exceptions[0].title, f.conversations[1].title);
    assert.equal(report.exceptions[0].status, 403);
    assert.match(report.exceptions[0].detail, /Permission denied/);
    const state = await f.send({ action: 'getExportState' });
    assert.equal(state.pending, 0);
    assert.equal(state.excluded, 1);
    assert.match(state.exceptionsReport, /^000_EXCEPTIONS\.json inside .*\.zip$/);
});

test('End and Export during cooldown saves fetched conversations then Export Remaining skips them after restart', async () => {
    const f = await fixture({ count: 6, earlyState: 'complete' });
    let limited = true;
    f.responder = msg => msg.action === 'getConversation' && msg.id === f.conversations[2].id && limited
        ? { error: '429', status: 429, retryAfter: '120' } : null;
    await f.send({ action: 'exportAll', formats: { markdown: true }, limit: 0 });
    const cooldown = await f.send({ action: 'getExportState' });
    assert.equal(cooldown.fetched, 2);
    assert.equal(cooldown.canEnd, true);
    const requests = f.requests.length;
    const partial = await f.send({ action: 'endAndExport' });
    assert.equal(partial.partial, true);
    assert.equal(partial.totalExported, 2);
    assert.equal(partial.remaining, 4);
    assert.equal(f.requests.length, requests, 'Saving during cooldown must work without session or conversation requests');
    assert.deepEqual(f.history().sort(), f.conversations.slice(0, 2).map(c => c.id).sort());
    const saved = await f.send({ action: 'getExportState' });
    assert.equal(saved.status, 'partial');
    assert.equal(saved.canResume, true);
    assert.equal(saved.canEnd, false);
    assert.equal(f.alarms.size, 0);
    await f.restart(); limited = false;
    await f.send({ action: 'resumeExport' });
    const waiting = await f.send({ action: 'getExportState' });
    assert.equal(waiting.total, 4);
    assert.equal(waiting.resumeAt, cooldown.resumeAt);
    assert.equal(f.requests.length, requests);
    f.advanceTo(waiting.resumeAt);
    await f.alarm();
    assert.equal((await f.send({ action: 'getExportState' })).status, 'complete');
    assert.equal(f.history().length, 6);
    for (const conv of f.conversations.slice(0, 2)) {
        assert.equal(f.requests.filter(m => m.action === 'getConversation' && m.id === conv.id).length, 1);
    }
});

test('End and Export interrupts a hung fetch without committing its late result', { timeout: 5000 }, async () => {
    const f = await fixture({ count: 5, earlyState: 'complete' });
    let release;
    f.responder = msg => msg.action === 'getConversation' && msg.id === f.conversations[2].id
        ? new Promise(resolve => { release = resolve; }) : null;
    const active = f.send({ action: 'exportAll', formats: { markdown: true }, limit: 0 });
    await until(() => !!release);
    const partial = await f.send({ action: 'endAndExport' });
    assert.equal(partial.totalExported, 2);
    assert.equal((await active).ending, true);
    assert.equal(f.history().length, 2);
    release(structuredClone(f.conversations[2]));
    await tick();
    const state = await f.send({ action: 'getExportState' });
    assert.equal(state.status, 'partial');
    assert.equal(state.saved, 2);
    assert.equal(state.remaining, 3);
    assert.equal(f.requests.filter(m => m.action === 'getConversation' && m.id === f.conversations[3].id).length, 0);
});

test('failed partial download does not enter history and Retry Saving needs no ChatGPT connection', async () => {
    const f = await fixture({ count: 4 });
    f.responder = msg => msg.action === 'getConversation' && msg.id === f.conversations[2].id
        ? { error: '429', status: 429 } : null;
    await f.send({ action: 'exportAll', formats: { markdown: true }, limit: 0 });
    const partial = f.send({ action: 'endAndExport' });
    await until(() => f.downloads.length === 1);
    assert.deepEqual(f.history(), []);
    f.finish(1, 'interrupted', 'FILE_FAILED');
    assert.match((await partial).error, /FILE_FAILED/);
    const state = await f.send({ action: 'getExportState' });
    assert.equal(state.status, 'paused');
    assert.equal(state.finishingEarly, true);
    assert.equal(state.saved, 0);
    assert.deepEqual(f.history(), []);
    await f.restart();
    f.responder = () => { throw new Error('No ChatGPT connection'); };
    const requests = f.requests.length;
    const retry = f.send({ action: 'resumeExport' });
    await until(() => f.downloads.length === 2);
    f.finish(2, 'complete');
    assert.equal((await retry).partial, true);
    assert.equal(f.downloads.length, 2, 'Each attempt prompts for a single ZIP');
    assert.equal(f.requests.length, requests);
    assert.equal(f.history().length, 2);
});

test('End and Export from manual pause retains exceptions and Export Remaining retries every unsaved ID', async () => {
    const f = await fixture({ count: 5, earlyState: 'complete' });
    f.responder = msg => msg.action === 'getConversation' && msg.id === f.conversations[1].id
        ? { error: '404', status: 404 }
        : msg.action === 'getConversation' && msg.id === f.conversations[3].id ? { error: '429', status: 429 } : null;
    await f.send({ action: 'exportAll', formats: { markdown: true }, limit: 0 });
    await f.send({ action: 'pauseExport' });
    const before = await f.send({ action: 'getExportState' });
    assert.equal(before.canEnd, true);
    const partial = await f.send({ action: 'endAndExport' });
    assert.equal(partial.totalExported, 2);
    assert.equal(partial.exceptions, 1);
    assert.equal(partial.remaining, 3);
    const requests = f.requests.length;
    f.responder = null;
    await f.send({ action: 'resumeExport' });
    let state = await f.send({ action: 'getExportState' });
    assert.equal(state.total, 3);
    for (let round = 0; round < 10 && state.status !== 'complete'; round++) {
        f.advanceTo(state.resumeAt); await f.alarm();
        state = await f.send({ action: 'getExportState' });
    }
    assert.equal(state.status, 'complete');
    const newlyFetched = f.requests.slice(requests).filter(m => m.action === 'getConversation').map(m => m.id);
    assert.deepEqual(newlyFetched, [f.conversations[1].id, f.conversations[3].id, f.conversations[4].id]);
    assert.equal(f.history().length, 5);
});

test('New and Updated skips conversations saved by End and Export', async () => {
    const f = await fixture({ count: 5, earlyState: 'complete' });
    f.responder = msg => msg.action === 'getConversation' && msg.id === f.conversations[2].id
        ? { error: '429', status: 429 } : null;
    await f.send({ action: 'exportAll', formats: { markdown: true }, limit: 0 });
    await f.send({ action: 'endAndExport' });
    const requests = f.requests.length;
    const state = await f.send({ action: 'getExportState' });
    f.advanceTo(state.cooldownUntil);
    f.responder = null;
    await f.send({ action: 'exportNewUpdated', formats: { markdown: true }, limit: 0 });
    let next = await f.send({ action: 'getExportState' });
    for (let round = 0; round < 20 && next.status !== 'complete'; round++) {
        f.advanceTo(next.resumeAt); await f.alarm();
        next = await f.send({ action: 'getExportState' });
    }
    assert.equal(next.status, 'complete');
    assert.deepEqual(f.requests.slice(requests).filter(m => m.action === 'getConversation').map(m => m.id),
        f.conversations.slice(2).map(c => c.id));
});

test('three conversations still save as separate Markdown files', async () => {
    const f = await fixture({ count: 3, earlyState: 'complete' });
    const result = await f.send({ action: 'exportAll', formats: { markdown: true } });
    assert.equal(result.totalExported, 3);
    assert.equal(f.downloads.length, 3);
    assert.ok(f.downloads.every(item => item.options.filename.endsWith('.md')));
});

test('End and Export saves 18 batches, both formats and the report in one valid ZIP', { timeout: 30000 }, async () => {
    const f = await fixture({ count: 1776, earlyState: 'complete' });
    const meta = f.conversations.map(({ id, title }) => ({ id, title }));
    const job = {
        id: crypto.randomUUID(), status: 'paused', phase: 'paused', kind: 'all', meta,
        total: meta.length, fetched: 1770, cursor: 1775, saved: 0, results: [],
        formats: { markdown: true, json: true }, folder: 'test-exports',
        exceptions: meta.slice(0, 5).map(({ id, title }) => ({ id, title, status: 404 })),
        rate: { spacingMs: 6100, cooldownUntil: Date.now() + 120_000, nextRequestAt: 0 }
    };
    await f.store.save(job);
    for (const conversation of f.conversations.slice(5, job.cursor)) {
        await f.store.put(job, `conversation:${conversation.id}`, conversation);
    }

    const result = await f.send({ action: 'endAndExport' });
    assert.equal(result.totalExported, 1770);
    assert.equal(result.remaining, 6);
    assert.equal(f.requests.length, 0);
    assert.equal(f.downloads.length, 1);
    assert.match(f.downloads[0].options.filename, /^test-exports\/.*\.zip$/);
    assert.equal(f.history().length, 1770);

    const zip = await globalThis.JSZip.loadAsync(await f.archives[0].arrayBuffer(), { checkCRC32: true });
    const markdown = zip.file(/\.md$/);
    const backups = zip.file(/chatgpt_backup_.*\.json$/);
    assert.equal(markdown.length, 1770);
    assert.equal(backups.length, 18);
    const backedUpIds = [];
    for (const file of backups) {
        const backup = JSON.parse(await file.async('string'));
        backedUpIds.push(...backup.conversations.map(c => c.id));
    }
    assert.deepEqual(backedUpIds, f.conversations.slice(5, job.cursor).map(c => c.id));
    assert.equal(Object.keys(zip.files)[0], '000_EXCEPTIONS.json');
    const report = zip.file('000_EXCEPTIONS.json');
    const reportData = JSON.parse(await report.async('string'));
    assert.equal(reportData.exported, 1770);
    assert.deepEqual(reportData.exceptions, job.exceptions);
});
