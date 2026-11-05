import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { createExportStore } from '../lib/export-store.js';
import { createExportRunner, retryAfterMs } from '../lib/export-job.js';

function fixture(count = 1) {
    const db = new IDBFactory();
    const store = createExportStore(db);
    const calls = [], alarms = [], batches = [], states = [];
    let clock = Date.UTC(2026, 10, 4), respond, account = 'user:personal';
    const meta = Array.from({ length: count }, (_, i) => ({ id: `conversation-${i + 1}` }));
    const options = {
        store, now: () => clock, random: () => 0, sliceMs: Infinity,
        sleep: async ms => { clock += ms; },
        schedule: async when => alarms.push(when), notify: job => states.push({ status: job.status, fetched: job.fetched, saved: job.saved, error: job.error }),
        discover: async () => meta,
        send: async message => {
            calls.push({ message, at: clock });
            if (message.action === 'getAccountContext') return { accountKey: account };
            return respond ? respond(message) : { id: message.id, mapping: {} };
        },
        finishBatch: async (batch, job) => {
            batches.push({ batch, savedBeforeDownload: job.saved });
            return [{ filename: `part-${batches.length}.zip` }];
        }
    };
    let runner = createExportRunner(options);
    return { store, calls, alarms, batches, states, meta, options,
        get runner() { return runner; },
        get now() { return clock; }, set now(value) { clock = value; },
        set respond(value) { respond = value; }, set account(value) { account = value; },
        async create() { return runner.create({ kind: 'all', formats: { markdown: true }, limit: 0 }); },
        async run() { return runner.run(await store.getJob()); },
        restart() { runner = createExportRunner({ ...options, store: createExportStore(db) }); }
    };
}

test('Retry-After supports seconds and HTTP dates and ignores invalid or past values', () => {
    const now = Date.UTC(2026, 10, 4);
    assert.equal(retryAfterMs('120', now), 120_000);
    assert.equal(retryAfterMs(new Date(now + 3600_000).toUTCString(), now), 3600_000);
    assert.equal(retryAfterMs(new Date(now - 1000).toUTCString(), now), 0);
    for (const invalid of [null, '', 'invalid']) assert.equal(retryAfterMs(invalid, now), 0);
});

test('2515 conversations: 429 at 217 survives worker restart and resumes without losing or refetching the first 216', async () => {
    const f = fixture(2515);
    await f.create();
    let limited = true;
    f.respond = message => limited && message.id === 'conversation-217'
        ? { error: 'Too many requests', status: 429 }
        : { id: message.id, mapping: {} };
    const result = await f.run();
    assert.equal(result.job.status, 'cooldown');
    assert.equal(result.job.fetched, 216);
    assert.equal(result.job.saved, 0);
    assert.equal(f.batches.length, 0);
    assert.equal(result.job.resumeAt - f.now, 60_000);
    assert.deepEqual(await f.store.get(result.job, 'conversation:conversation-216'), { id: 'conversation-216', mapping: {} });
    const requestsBeforeRestart = f.calls.length;
    f.restart();
    await f.run();
    assert.equal(f.calls.length, requestsBeforeRestart, 'No requests, including session requests, may bypass cooldown');
    f.now = result.job.resumeAt;
    limited = false;
    const complete = await f.run();
    assert.equal(complete.totalExported, 2515);
    assert.equal(f.calls.filter(c => c.message.id === 'conversation-1').length, 1);
    assert.equal(f.calls.filter(c => c.message.id === 'conversation-217').length, 2);
    assert.equal(f.batches.length, 26);
    assert.ok(f.batches.every(b => b.batch.length <= 100));
    assert.equal(f.batches.reduce((n, b) => n + b.batch.length, 0), 2515);
    assert.equal((await f.store.getJob()).status, 'complete');
});

test('exponential cooldown caps at 15 minutes, respects Retry-After and pauses after six throttled probes', async () => {
    const f = fixture();
    await f.create();
    f.respond = () => ({ error: '429', status: 429 });
    const waits = [];
    for (let i = 0; i < 6; i++) {
        const result = await f.run();
        waits.push(result.job.rate.cooldownUntil - f.now);
        assert.equal(result.job.fetched, 0);
        assert.equal(result.job.status, i === 5 ? 'paused' : 'cooldown');
        f.now = result.job.rate.cooldownUntil;
        f.restart();
    }
    assert.deepEqual(waits, [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
    assert.equal(f.alarms.length, 5, 'Exhausted automatic retries must leave the job paused');
    assert.match((await f.store.getJob()).error, /Resume later/);
    assert.equal(f.batches.length, 0);
});

for (const format of ['seconds', 'date']) {
    test(`Retry-After ${format} beyond the backoff cap is never shortened, including on manual resume`, async () => {
        const f = fixture();
        await f.create();
        f.respond = () => ({ error: '429', status: 429, retryAfter: format === 'seconds' ? '3600' : new Date(f.now + 3600_000).toUTCString() });
        const result = await f.run();
        assert.equal(result.job.resumeAt - f.now, 3600_000);
        const count = f.calls.length;
        const job = await f.store.getJob();
        job.rate.consecutive429 = 0;
        await f.runner.run(job);
        assert.equal(f.calls.length, count);
    });
}

test('one intermittent success retains the backoff level and doubles pacing', async () => {
    const f = fixture(2);
    await f.create();
    f.respond = () => ({ error: '429', status: 429 });
    let result = await f.run();
    f.now = result.job.resumeAt;
    f.respond = message => message.id === 'conversation-1' ? { id: message.id, mapping: {} } : { error: '429', status: 429 };
    result = await f.run();
    assert.equal(result.job.fetched, 1);
    assert.equal(result.job.rate.spacingMs, 6000);
    assert.equal(result.job.rate.level, 2);
    assert.equal(result.job.resumeAt - f.now, 120_000);
});

test('twenty sustained successes reset the cooldown level', async () => {
    const f = fixture(21);
    await f.create();
    let job = await f.store.getJob();
    job.rate.level = 4;
    await f.store.save(job);
    f.respond = message => message.id === 'conversation-21' ? { error: '429', status: 429 } : { id: message.id, mapping: {} };
    const result = await f.run();
    assert.equal(result.job.fetched, 20);
    assert.equal(result.job.resumeAt - f.now, 60_000);
});

test('metadata pages share cooldown, cache successful discovery and never treat 429 as an empty project', async () => {
    const f = fixture();
    let limited = true;
    f.options.discover = async (job, request) => {
        await request({ action: 'getProjectsList' });
        await request({ action: 'getProjectConversations', projectId: 'p' });
        return f.meta;
    };
    f.restart();
    await f.create();
    f.respond = message => {
        if (message.action === 'getProjectConversations' && limited) return { error: '429', status: 429 };
        if (message.action === 'getConversation') return { id: message.id, mapping: {} };
        return { items: [] };
    };
    const result = await f.run();
    assert.equal(result.job.meta, null);
    assert.equal(result.job.status, 'cooldown');
    f.restart(); f.now = result.job.resumeAt; limited = false;
    assert.equal((await f.run()).totalExported, 1);
    assert.equal(f.calls.filter(c => c.message.action === 'getProjectsList').length, 1);
});

test('network failures retry exponentially then pause without skipping the pending conversation', async () => {
    const f = fixture(2);
    await f.create();
    f.respond = () => ({ error: 'Network unavailable' });
    for (const delay of [10_000, 20_000]) {
        const result = await f.run();
        assert.equal(result.job.resumeAt - f.now, delay);
        f.now = result.job.resumeAt;
    }
    assert.equal((await f.run()).job.status, 'paused');
    assert.equal(f.calls.filter(c => c.message.id === 'conversation-2').length, 0);
});

test('401/403/404 pause without a retry storm or incomplete success', async () => {
    for (const status of [401, 403, 404]) {
        const f = fixture(2);
        await f.create();
        f.respond = () => ({ error: `HTTP ${status}`, status });
        const result = await f.run();
        assert.equal(result.job.status, 'paused');
        assert.equal(result.job.fetched, 0);
        assert.equal(f.alarms.length, 0);
        assert.equal(f.batches.length, 0);
    }
});

test('failed downloads retain all payloads and do not advance the saved checkpoint', async () => {
    const f = fixture();
    f.options.finishBatch = async () => { throw new Error('FILE_NO_SPACE'); };
    f.restart(); await f.create();
    const result = await f.run();
    assert.equal(result.job.fetched, 1);
    assert.equal(result.job.saved, 0);
    assert.equal(result.job.status, 'paused');
    assert.ok(await f.store.get(result.job, 'conversation:conversation-1'));
    f.options.finishBatch = async () => [];
    f.restart();
    assert.equal((await f.run()).totalExported, 1);
    assert.equal(f.calls.filter(c => c.message.id === 'conversation-1').length, 1);
});

test('a checkpoint write failure cannot advance fetched progress past the durable payload', async () => {
    const f = fixture();
    const commit = f.store.commit;
    f.store.commit = async () => { throw new Error('Disk full'); };
    await f.create();
    const result = await f.run();
    assert.equal(result.job.fetched, 0);
    assert.equal((await f.store.getJob()).fetched, 0);
    f.store.commit = commit;
    assert.equal((await f.run()).totalExported, 1);
});

test('account changes pause a saved job before fetching or exporting its contents', async () => {
    const f = fixture();
    await f.create();
    f.respond = () => ({ error: '429', status: 429 });
    const result = await f.run();
    f.now = result.job.resumeAt;
    f.account = 'different-user:personal';
    const count = f.calls.length;
    assert.match((await f.run()).error, /account or workspace changed/);
    assert.equal(f.calls.length, count + 1);
    assert.equal(f.batches.length, 0);
});

test('bounded execution yields to an alarm and cannot erase queue progress', async () => {
    const f = fixture(50);
    f.options.sliceMs = 10_000; f.restart();
    await f.create();
    const result = await f.run();
    assert.equal(result.job.status, 'waiting');
    assert.ok(result.job.fetched > 0 && result.job.fetched < 50);
    assert.equal(f.alarms.at(-1), result.job.resumeAt);
    assert.equal(result.job.saved, 0);
});

test('a saved unfinished job blocks creation of another export', async () => {
    const f = fixture();
    await f.create();
    await assert.rejects(f.create(), /unfinished export exists/);
});


test('discarding a throttled job cannot bypass its cooldown by starting another', async () => {
    const f = fixture();
    await f.create();
    f.respond = () => ({ error: '429', status: 429 });
    const result = await f.run();
    await f.store.clear();
    const next = await f.create();
    assert.equal(next.rate.cooldownUntil, result.job.rate.cooldownUntil);
    const before = f.calls.length;
    await f.runner.run(next);
    assert.equal(f.calls.length, before);
});

test('successfully recovered jobs retain their warning and completion events', async () => {
    const f = fixture();
    await f.create();
    f.respond = () => ({ error: '429', status: 429 });
    const result = await f.run();
    f.now = result.job.resumeAt;
    f.respond = message => ({ id: message.id, mapping: {} });
    await f.run();
    const job = await f.store.getJob();
    assert.ok(job.events.some(e => e.type === 'warning' && /rate limit/.test(e.message)));
    assert.ok(job.events.some(e => e.type === 'success' && /complete/.test(e.message)));
});

test('slow recovery pacing still makes progress after restarting between alarm runs', async () => {
    const f = fixture(2);
    await f.create();
    const job = await f.store.getJob();
    job.rate.spacingMs = 60_000;
    await f.store.save(job);
    let result = await f.run();
    assert.equal(result.job.fetched, 1);
    f.now = result.job.resumeAt;
    f.restart();
    result = await f.run();
    assert.equal(result.totalExported, 2);
});

test('listing audit measures actual repeated IDs and survives payload cleanup', async () => {
    const f = fixture();
    const job = await f.create();
    await f.store.commit(job, JSON.stringify({ action: 'getProjectConversations', projectId: 'p', cursor: '0' }), {
        items: [{ id: 'a', title: 'Project only' }, { id: 'b', title: 'Returned twice' }]
    });
    await f.store.commit(job, JSON.stringify({ action: 'getConversationsList', offset: 0, limit: 28 }), {
        items: [{ id: 'b', title: 'Returned twice' }, { id: 'c', title: 'Main only' }]
    });
    const audit = await f.store.getDiscoveryAudit(job);
    assert.equal(audit.projectEntries, 2);
    assert.equal(audit.mainEntries, 2);
    assert.equal(audit.uniqueConversations, 3);
    assert.equal(audit.repeatedEntries, 1);
    assert.equal(audit.inBothLists, 1);
    assert.deepEqual(audit.examples, [{ id: 'b', title: 'Returned twice' }]);
    await f.store.clearResponses();
    assert.deepEqual(await f.store.getDiscoveryAudit(job), audit);
});

test('listing audit reports no overlap when the returned conversation IDs are disjoint', async () => {
    const f = fixture();
    const job = await f.create();
    await f.store.commit(job, JSON.stringify({ action: 'getProjectConversations', projectId: 'p', cursor: '0' }), { items: [{ id: 'a' }] });
    await f.store.commit(job, JSON.stringify({ action: 'getConversationsList', offset: 0, limit: 28 }), { items: [{ id: 'b' }] });
    const audit = await f.store.getDiscoveryAudit(job);
    assert.equal(audit.uniqueConversations, 2);
    assert.equal(audit.repeatedEntries, 0);
    assert.equal(audit.inBothLists, 0);
    assert.deepEqual(audit.examples, []);
});

test('stable traffic gradually restores 48-second pacing to the three-second baseline', async () => {
    const f = fixture(81);
    await f.create();
    const job = await f.store.getJob();
    Object.assign(job.rate, { spacingMs: 48_000, level: 2, pacingPolicyVersion: 1 });
    await f.store.save(job);
    let result;
    for (let rounds = 0; rounds < 100; rounds++) {
        result = await f.run();
        if (result.totalExported !== undefined) break;
        assert.ok(result.deferred);
        f.now = result.job.resumeAt;
        f.restart();
    }
    assert.equal(result.totalExported, 81);
    const saved = await f.store.getJob();
    assert.equal(saved.rate.spacingMs, 3000);
    const calls = f.calls.filter(c => c.message.action === 'getConversation');
    for (const [index, delay] of [[20, 24_000], [40, 12_000], [60, 6000], [80, 3000]]) {
        assert.equal(calls[index].at - calls[index - 1].at, delay);
    }
    assert.equal(saved.events.filter(e => /20 successful requests/.test(e.message)).length, 4);
});

test('an old job stuck at 48 seconds with reset backoff is repaired once', async () => {
    const f = fixture();
    await f.create();
    const job = await f.store.getJob();
    Object.assign(job.rate, { spacingMs: 48_000, level: 0, successes: 0 });
    delete job.rate.pacingPolicyVersion;
    await f.store.save(job);
    await f.run();
    assert.equal((await f.store.getJob()).rate.spacingMs, 24_000);
    await f.create();
    await f.run();
    assert.equal((await f.store.getJob()).rate.spacingMs, 24_000, 'Restarting or creating a job must not repeatedly halve the pacing');
});

test('pacing recovery never shortens a server cooldown', async () => {
    const f = fixture();
    await f.create();
    const job = await f.store.getJob();
    Object.assign(job.rate, { spacingMs: 48_000, level: 0, cooldownUntil: f.now + 3600_000 });
    delete job.rate.pacingPolicyVersion;
    await f.store.save(job);
    const result = await f.run();
    assert.equal(result.job.resumeAt, job.rate.cooldownUntil);
    assert.equal(result.job.rate.spacingMs, 48_000);
    assert.equal(f.calls.length, 0);
});

test('repairing old spacing preserves an already scheduled retry', async () => {
    const f = fixture();
    await f.create();
    const job = await f.store.getJob();
    const deadline = f.now + 20_000;
    Object.assign(job.rate, { spacingMs: 48_000, level: 0, nextRequestAt: deadline });
    delete job.rate.pacingPolicyVersion;
    await f.store.save(job);
    await f.run();
    assert.equal(f.calls[0].at, deadline);
});
