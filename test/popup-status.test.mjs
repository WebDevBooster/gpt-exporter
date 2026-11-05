import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../popup/popup.js', import.meta.url), 'utf8');

function element() {
    const classes = new Set(['hidden']);
    return { textContent: '', value: '', checked: false, disabled: false, dataset: {}, style: {}, children: [],
        classList: {
            add(...names) { names.forEach(n => classes.add(n)); },
            remove(...names) { names.forEach(n => classes.delete(n)); },
            contains: name => classes.has(name),
            toggle(name, enabled) { if (enabled ?? !classes.has(name)) classes.add(name); else classes.delete(name); }
        },
        appendChild(child) { this.children.push(child); }, addEventListener() {},
        querySelector() { return this; }
    };
}
function fixture(state, connection = { connected: true }, availability = { available: true, conversationId: 'chat' }) {
    const elements = new Map();
    const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
    const intervals = [], listeners = [];
    let initialize;
    const response = message => ({
        checkConnection: connection, getCurrentConversationTarget: availability,
        getStats: { totalExported: 0 }, getExportState: state
    })[message.action];
    const context = vm.createContext({
        console: { log() {}, error() {} }, Date,
        document: {
            getElementById: get, createElement: element,
            addEventListener(name, callback) { if (name === 'DOMContentLoaded') initialize = callback; }
        },
        window: { innerWidth: 380 },
        setInterval: fn => intervals.push(fn), setTimeout() {}, confirm: () => true, alert() {},
        chrome: {
            storage: { local: { async get() { return {}; }, async set() {} } },
            runtime: {
                onMessage: { addListener: fn => listeners.push(fn) },
                sendMessage(message, callback) {
                    const result = response(message);
                    if (callback) { queueMicrotask(() => callback(result)); return; }
                    return Promise.resolve(result);
                }
            }
        }
    });
    vm.runInContext(source, context);
    return { get, initialize: () => initialize(), intervals,
        update(next) { listeners[0]({ type: 'progress', ...next }); }
    };
}
const base = { isRunning: true, status: 'cooldown', phase: 'cooldown', fetched: 216, pending: 2299, total: 2515,
    saved: 0, failed: 0, error: 'ChatGPT rate limit. Progress is saved.', resumeAt: Date.now() + 120_000,
    retryLevel: 2, canResume: false, canDiscard: true, canCancel: true };

test('reopening the normal popup restores a visible throttle warning, counts and retry time', async () => {
    const f = fixture(base);
    await f.initialize();
    assert.equal(f.get('jobStatus').classList.contains('hidden'), false);
    assert.equal(f.get('jobStatus').dataset.status, 'cooldown');
    assert.match(f.get('jobStatusTitle').textContent, /rate limit/);
    assert.match(f.get('jobCounts').textContent, /216 fetched.*2299 pending.*0 saved/);
    assert.match(f.get('jobRetryTime').textContent, /Resuming in \d+ seconds/);
    assert.equal(f.get('btnExportAll').disabled, true);
    assert.ok(f.get('logOutput').children.some(entry => /rate limit/.test(entry.textContent)));
});

test('an exhausted retry becomes a persistent visible error with Resume and Cancel', async () => {
    const paused = { ...base, isRunning: false, status: 'paused', phase: 'paused', failed: 1,
        error: 'Rate limit persists. Progress is saved. Resume later.', canResume: true };
    const f = fixture(paused);
    await f.initialize();
    assert.equal(f.get('jobStatus').dataset.status, 'paused');
    assert.equal(f.get('jobMessage').textContent, paused.error);
    assert.equal(f.get('btnResume').classList.contains('hidden'), false);
    assert.equal(f.get('btnCancelProcess').classList.contains('hidden'), false);
    assert.equal(f.get('btnExportAll').disabled, true);
    assert.ok(f.get('logOutput').children.some(entry => entry.className === 'log-entry error' && /Resume later/.test(entry.textContent)));
});

test('live worker messages surface errors without DevTools and ordinary polling does not flood logs', async () => {
    const f = fixture({ ...base, status: 'running', phase: 'fetching_conversations', error: null });
    await f.initialize();
    f.update(base);
    const count = f.get('logOutput').children.length;
    f.update(base); f.update(base);
    assert.equal(f.get('logOutput').children.length, count);
    assert.equal(f.get('jobStatus').dataset.status, 'cooldown');
    f.update({ ...base, status: 'paused', phase: 'paused', isRunning: false, error: 'Disk full', canResume: true });
    assert.equal(f.get('jobMessage').textContent, 'Disk full');
});


test('reopening after recovery shows saved warnings with their original event times', async () => {
    const f = fixture({ ...base, isRunning: false, status: 'complete', phase: 'complete', error: null,
        fetched: 2515, pending: 0, saved: 2515,
        events: [{ id: 'warning-1', type: 'warning', at: Date.now() - 3600_000, message: 'Earlier ChatGPT rate limit. Backoff stage 2.' }] });
    await f.initialize();
    assert.ok(f.get('logOutput').children.some(e => /Earlier ChatGPT rate limit/.test(e.textContent)));
    const count = f.get('logOutput').children.length;
    f.intervals[0]();
    assert.equal(f.get('logOutput').children.length, count, 'Repainting completion must not flood the log');
});


test('a failed worker connection is never labelled as a ChatGPT logout', async () => {
    const detail = 'No response from background script';
    const f = fixture({ isRunning: false, phase: null }, { error: detail });
    await f.initialize();
    assert.equal(f.get('connectionStatus').textContent, 'Connection unavailable');
    assert.equal(f.get('connectionStatus').title, detail);
    assert.ok(f.get('logOutput').children.some(e => e.className === 'log-entry error' && e.textContent.includes(detail)));
    assert.ok(f.get('logOutput').children.every(e => !/please log in/i.test(e.textContent)));
    assert.equal(f.get('btnExportAll').disabled, true);
});

test('an absent ChatGPT tab displays its actual connection error', async () => {
    const detail = 'No ChatGPT tab found. Please open chatgpt.com first.';
    const f = fixture({ isRunning: false, phase: null }, { error: detail });
    await f.initialize();
    assert.equal(f.get('connectionStatus').textContent, 'Connection unavailable');
    assert.equal(f.get('connectionStatus').title, detail);
});


test('Cancel remains available for paused Export All while Pause is a separate control', async () => {
    const f = fixture({ ...base, isRunning: false, status: 'paused', phase: 'paused', canResume: true });
    await f.initialize();
    assert.equal(f.get('btnCancelProcess').classList.contains('hidden'), false);
    assert.equal(f.get('btnCancelProcess').disabled, false);
    assert.equal(f.get('btnPauseProcess').classList.contains('hidden'), true);
    f.update({ ...base, status: 'running', phase: 'fetching_list', listed: 112, activity: 'Listing conversations from item 113' });
    assert.equal(f.get('btnPauseProcess').classList.contains('hidden'), false);
    assert.match(f.get('jobCounts').textContent, /112 listed/);
    assert.equal(f.get('jobMessage').textContent, 'ChatGPT rate limit. Progress is saved.');
    f.update({ ...base, status: 'cancelled', phase: 'cancelled', isRunning: false, error: null, canCancel: false, canResume: false });
    assert.equal(f.get('btnExportAll').disabled, false);
    assert.equal(f.get('btnResume').classList.contains('hidden'), true);
});


test('missing Current Chat availability cannot add a false error to the Export All log', async () => {
    const f = fixture({ isRunning: false, phase: null }, { connected: true },
        { available: false, reason: 'No active ChatGPT conversation found.' });
    await f.initialize();
    assert.equal(f.get('btnExportCurrent').disabled, true);
    assert.equal(f.get('btnExportAll').disabled, false);
    assert.ok(f.get('logOutput').children.every(e => e.className !== 'log-entry error'));
});

test('listing progress stays visible through scheduled pauses, cooldown and resume', async () => {
    const listing = { ...base, status: 'running', phase: 'fetching_list', listed: 112,
        current: 112, fetched: 0, total: 0, error: null, listingComplete: false };
    const f = fixture(listing);
    await f.initialize();
    const width = f.get('progressFill').style.width;
    for (const phase of ['waiting', 'cooldown', 'paused']) {
        f.update({ ...listing, phase, status: phase, current: 0 });
        assert.equal(f.get('progressSection').classList.contains('hidden'), false, `The bar must remain visible during ${phase}`);
        assert.match(f.get('progressText').textContent, /112 found/);
        assert.equal(f.get('progressFill').style.width, width);
    }
    assert.match(f.get('progressText').textContent, /Paused/);
    f.update({ ...listing, phase: 'waiting', status: 'waiting' });
    assert.match(f.get('progressText').textContent, /Resuming in \d+ seconds/);
    f.update({ ...listing, listed: 140, current: 140 });
    assert.match(f.get('progressText').textContent, /140 found/);
    assert.equal(f.get('progressSection').classList.contains('hidden'), false);
});

test('reopening during a scheduled listing pause restores the bar and saved count', async () => {
    const f = fixture({ ...base, status: 'waiting', phase: 'waiting', listed: 1002,
        current: 0, fetched: 0, total: 0, error: null, listingComplete: false });
    await f.initialize();
    assert.equal(f.get('progressSection').classList.contains('hidden'), false);
    assert.match(f.get('progressText').textContent, /1002 found.*Resuming in \d+ seconds/);
});


test('scheduled pause countdown ticks down each second without hiding the listing bar', async () => {
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    try {
        const f = fixture({ ...base, status: 'waiting', phase: 'waiting', listed: 1186,
            current: 0, fetched: 0, total: 0, error: null, listingComplete: false, resumeAt: now + 30_000 });
        await f.initialize();
        assert.match(f.get('progressText').textContent, /1186 found.*Resuming in 30 seconds/);
        assert.equal(f.get('jobRetryTime').textContent, 'Resuming in 30 seconds');
        now += 1000;
        f.intervals[0]();
        await new Promise(resolve => setImmediate(resolve));
        assert.match(f.get('progressText').textContent, /Resuming in 29 seconds/);
        assert.equal(f.get('progressSection').classList.contains('hidden'), false);
    } finally { Date.now = originalNow; }
});
