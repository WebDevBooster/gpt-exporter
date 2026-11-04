import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');

function fixture(responses) {
    const calls = [], handlers = [];
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        AbortController, AbortSignal, setTimeout, clearTimeout,
        document: { cookie: '', querySelectorAll: () => [] },
        window: { location: { href: 'https://chatgpt.com/' } },
        chrome: { runtime: { onMessage: { addListener: fn => handlers.push(fn) } } },
        fetch: async (url, options) => {
            calls.push({ url, options });
            const next = responses.shift();
            assert.ok(next, `Unexpected fetch: ${url}`);
            return new Response(JSON.stringify(next.body || {}), { status: next.status || 200, headers: next.headers });
        }
    });
    vm.runInContext(source, context);
    return { calls, handlers, context,
        send: message => new Promise(resolve => handlers[0](message, {}, resolve))
    };
}
const session = () => ({ body: { accessToken: 'fixture-token', user: { id: 'fixture-user' } } });

for (const action of ['getConversation', 'getProjectsList', 'getProjectConversations']) {
    test(`${action} propagates 429, Retry-After and details without fallbacks`, async () => {
        const f = fixture([session(), { status: 429, headers: { 'Retry-After': '3600' }, body: { error: 'Slow down' } }]);
        const response = await f.send({ action, id: 'conversation', projectId: 'g-p-123', accountKey: 'fixture-user:personal' });
        assert.equal(response.status, 429);
        assert.equal(response.retryAfter, '3600');
        assert.match(response.detail, /Slow down/);
        assert.equal(f.calls.length, 2);
    });
}

test('project discovery performs exactly one page per scheduled request', async () => {
    const f = fixture([session(), { body: {
        items: [{ gizmo: { gizmo: { id: 'g-p-abc', display: { name: 'Project' } } } }], cursor: 'next-page'
    } }]);
    const response = await f.send({ action: 'getProjectsList' });
    assert.equal(response.items[0].id, 'g-p-abc');
    assert.equal(response.cursor, 'next-page');
    assert.equal(f.calls.length, 2);
});

test('401 refreshes authentication once and a second 401 reaches the scheduler', async () => {
    const f = fixture([session(), { status: 401 }, session(), { status: 401 }]);
    const response = await f.send({ action: 'getConversation', id: 'conversation' });
    assert.equal(response.status, 401);
    assert.equal(f.calls.length, 4);
});

test('session rate limits preserve Retry-After', async () => {
    const f = fixture([{ status: 429, headers: { 'Retry-After': '120' } }]);
    const response = await f.send({ action: 'getAccountContext' });
    assert.equal(response.status, 429);
    assert.equal(response.retryAfter, '120');
});

test('account binding prevents fetching payloads in a different workspace', async () => {
    const f = fixture([session()]);
    const response = await f.send({ action: 'getConversation', id: 'conversation', accountKey: 'other-user:personal' });
    assert.match(response.error, /account or workspace changed/);
    assert.equal(f.calls.length, 1);
});

test('opening a popup cannot issue session requests during cooldown', async () => {
    const f = fixture([]);
    assert.equal((await f.send({ action: 'ping' })).success, true);
    assert.equal(f.calls.length, 0);
});

test('reinjecting the same content script does not register duplicate listeners', () => {
    const f = fixture([]);
    vm.runInContext(source, f.context);
    assert.equal(f.handlers.length, 1);
});
