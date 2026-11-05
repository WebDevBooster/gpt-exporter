const BASE_DELAY = 60_000;
const MAX_DELAY = 900_000;
const MAX_THROTTLED_PROBES = 6;
const BATCH_SIZE = 100;
const MIN_SPACING_MS = 6100;
const PACING_POLICY_VERSION = 1;

export function enforceMinimumSpacing(job) {
    const rate = job.rate;
    const previous = rate.spacingMs;
    if (previous >= MIN_SPACING_MS) return;
    const lastRequestAt = job.lastActivityAt || (rate.nextRequestAt ? rate.nextRequestAt - previous : 0);
    rate.spacingMs = MIN_SPACING_MS;
    rate.nextRequestAt = Math.max(rate.nextRequestAt, lastRequestAt + MIN_SPACING_MS);
}

export function retryAfterMs(value, now) {
    if (typeof value !== 'string' || !value.trim()) return 0;
    if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

class Deferred extends Error {}

function interruptible(promise, signal) {
    if (!signal) return promise;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}

function requestLabel(message) {
    switch (message.action) {
        case 'getAccountContext': return 'Checking the ChatGPT session';
        case 'getProjectsList': return 'Listing projects';
        case 'getProjectConversations': return 'Listing conversations in a project';
        case 'getConversationsList': return `Listing conversations from item ${(message.offset || 0) + 1}`;
        case 'getConversation': return `Fetching conversation ${message.id}`;
        default: return 'Contacting ChatGPT';
    }
}

export function recordJobEvent(job, message, type = 'info', at = Date.now()) {
    job.events ||= [];
    job.events.push({ id: crypto.randomUUID(), at, type, message });
    job.events = job.events.slice(-200);
}

// All backend calls, including metadata pagination and retries, pass through
// request(). Long waits unwind the job; an alarm starts a new bounded run.
export function createExportRunner({ store, send, discover, finishBatch, finishExceptions, schedule,
    notify = () => {}, now = Date.now, random = Math.random,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    checkCancelled = () => {}, sliceMs = 60_000 }) {
    let busy = false;
    const publish = async job => { await store.save(job); notify(job); };

    async function run(job, { signal } = {}) {
        if (job.status === 'cancelled') return { cancelled: true, job };
        if (busy) throw new Error('An export is already running');
        busy = true;
        const started = now();
        function check() { signal?.throwIfAborted(); checkCancelled(); }
        async function reportDiscovery(conversations, projects) {
            check();
            const listed = Math.max(job.listed || 0, conversations);
            const foundProjects = Math.max(job.projects || 0, projects || 0);
            if (listed === job.listed && foundProjects === job.projects) return;
            job.listed = listed;
            job.projects = foundProjects;
            recordJobEvent(job, `Listing progress: ${job.listed} conversations found${job.projects !== undefined ? ` across ${job.projects} projects` : ''}.`, 'info', now());
            await publish(job);
        }
        async function defer(until, phase = 'waiting') {
            job.status = phase;
            job.phase = phase;
            job.resumeAt = until;
            await publish(job);
            await schedule(until);
            throw new Deferred();
        }
        async function request(message, cache = true, allowedStatuses = []) {
            check();
            const key = JSON.stringify(message);
            if (cache) {
                const cached = await store.get(job, key);
                if (cached !== undefined) return cached;
            }
            const rate = job.rate;
            const eligible = Math.max(rate.nextRequestAt, rate.cooldownUntil);
            if (eligible > now() + 25_000) await defer(eligible, rate.cooldownUntil > now() ? 'cooldown' : 'waiting');
            if (now() - started >= sliceMs) await defer(Math.max(eligible, now() + 30_000));
            if (eligible > now()) await interruptible(sleep(eligible - now()), signal);
            check();
            // Reserve pacing before sending, so interruption cannot erase it.
            // Account verification may be served from the content script cache.
            // It must not reserve a new slot on every resumed run, otherwise a
            // spacing longer than the short-wait threshold could starve the GET.
            if (message.action !== 'getAccountContext') rate.nextRequestAt = now() + rate.spacingMs;
            job.activity = requestLabel(message);
            job.requests = (job.requests || 0) + 1;
            job.lastActivityAt = now();
            await publish(job);
            check();
            let response;
            try { response = await interruptible(send({ ...message, accountKey: job.accountKey, jobId: job.id }, signal), signal); }
            catch (error) { response = { error: error.message }; }
            check();
            if (!response || (response.error && !allowedStatuses.includes(response.status))) {
                const status = response?.status;
                const error = response?.error || 'No response from ChatGPT';
                if (status === 429) {
                    const base = Math.min(MAX_DELAY, BASE_DELAY * 2 ** Math.min(rate.level, 4));
                    const wait = Math.max(base, retryAfterMs(response.retryAfter, now()));
                    rate.cooldownUntil = now() + wait + Math.floor(base * 0.1 * random());
                    rate.level++;
                    rate.consecutive429++;
                    rate.successes = 0;
                    rate.recovering = true;
                    job.error = 'ChatGPT rate limit. Progress is saved.';
                    recordJobEvent(job, `ChatGPT rate limit. Backoff stage ${rate.level}; retry no earlier than ${new Date(rate.cooldownUntil).toISOString()}. ${job.fetched} conversations safely fetched.`, 'warning', now());
                    if (rate.consecutive429 >= MAX_THROTTLED_PROBES) {
                        job.resumeAt = rate.cooldownUntil;
                        throw new Error('Rate limit persists. Progress is saved. Resume later.');
                    }
                    await defer(rate.cooldownUntil, 'cooldown');
                }
                // An old content script must not turn 429 into a generic retry.
                if (!status && /\b429\b/.test(error)) {
                    throw new Error('Reload the ChatGPT tab to update the exporter connection, then resume.');
                }
                if (status && status < 500 && status !== 408) {
                    let detail = response.detail || '';
                    try { detail = JSON.parse(detail).detail || detail; } catch { /* Keep non-JSON server text. */ }
                    throw Object.assign(new Error(`HTTP ${status}: ${detail || error}`), {
                        status, detail: response.detail || '', action: message.action, conversationId: message.id
                    });
                }
                job.transient = job.transient?.key === key
                    ? { key, attempts: job.transient.attempts + 1 } : { key, attempts: 1 };
                if (job.transient.attempts >= 3) throw new Error(error);
                job.error = error;
                rate.nextRequestAt = now() + 10_000 * 2 ** (job.transient.attempts - 1);
                recordJobEvent(job, `${error}. Retry ${job.transient.attempts}/3 scheduled.`, 'warning', now());
                await defer(rate.nextRequestAt);
            }
            if (message.action === 'getAccountContext') return response;
            job.lastSuccessAt = now();
            job.transient = null;
            job.error = null;
            rate.cooldownUntil = 0;
            rate.consecutive429 = 0;
            if (rate.recovering) {
                rate.spacingMs = Math.min(60_000, rate.spacingMs * 2);
                rate.recovering = false;
            }
            if (++rate.successes >= 20) {
                rate.level = 0;
                rate.successes = 0;
                if (rate.spacingMs > MIN_SPACING_MS) {
                    const previous = rate.spacingMs;
                    rate.spacingMs = Math.max(MIN_SPACING_MS, rate.spacingMs / 2);
                    recordJobEvent(job, `20 successful requests: request spacing reduced from ${previous / 1000}s to ${rate.spacingMs / 1000}s.`, 'info', now());
                }
            }
            rate.nextRequestAt = now() + rate.spacingMs;
            if (cache) await store.commit(job, key, response);
            else await store.save(job);
            return response;
        }
        try {
            check();
            // Apply the floor to saved jobs as well as fresh jobs. Preserve any
            // longer server deadline while repairing an old shorter reservation.
            enforceMinimumSpacing(job);
            if (job.rate.pacingPolicyVersion !== PACING_POLICY_VERSION) {
                const rate = job.rate;
                // Old jobs reset the backoff level after stable traffic but
                // retained their enlarged spacing forever. Repair that once.
                if (rate.level === 0 && !rate.recovering && rate.cooldownUntil <= now() && rate.spacingMs > MIN_SPACING_MS) {
                    const previous = rate.spacingMs;
                    rate.spacingMs = Math.max(MIN_SPACING_MS, rate.spacingMs / 2);
                    recordJobEvent(job, `Recovered request pacing: ${previous / 1000}s → ${rate.spacingMs / 1000}s after stable requests.`, 'info', now());
                }
                rate.pacingPolicyVersion = PACING_POLICY_VERSION;
            }
            // Check cooldown before even contacting the account/session endpoint.
            if (!job.finishEarly && job.rate.cooldownUntil > now()) await defer(job.rate.cooldownUntil, 'cooldown');
            const wasPaused = job.status === 'paused';
            job.status = 'running';
            job.phase = job.finishEarly ? 'exporting' : job.meta ? 'fetching_conversations' : 'fetching_list';
            job.error = null;
            job.errorDetail = null;
            job.resumeAt = null;
            await publish(job);
            if (!job.finishEarly) {
                const context = await request({ action: 'getAccountContext' }, false);
                if (!context.accountKey) throw new Error('Reload the ChatGPT tab, then resume the export.');
                if (job.accountKey && context.accountKey !== job.accountKey) {
                    throw new Error('ChatGPT account or workspace changed. Switch back before resuming.');
                }
                job.accountKey = context.accountKey;
                if (wasPaused) recordJobEvent(job, 'Export resumed from saved progress.', 'info', now());
                job.status = 'running';
                job.error = null;
                job.resumeAt = null;
                if (!job.meta) {
                    job.phase = 'fetching_list';
                    await publish(job);
                    const meta = await discover(job, request, reportDiscovery);
                    const unique = new Map();
                    for (const item of meta) if (!unique.has(item.id)) unique.set(item.id, item);
                    job.meta = [...unique.values()];
                    if (job.limit > 0) job.meta = job.meta.slice(0, job.limit);
                    job.total = job.meta.length;
                    await store.getDiscoveryAudit(job);
                    await publish(job);
                }
            }
            job.phase = job.finishEarly ? 'exporting' : 'fetching_conversations';
            await publish(job);
            // Older checkpoints used fetched as the queue cursor. Exceptions need
            // a separate cursor so an omitted item is never counted as fetched.
            job.cursor ??= job.fetched;
            job.exceptions ||= [];
            for (let i = job.cursor; !job.finishEarly && i < job.meta.length; i++) {
                const meta = job.meta[i];
                let conversation;
                try {
                    // A first-item access probe may already have saved this payload.
                    conversation = await store.get(job, `conversation:${meta.id}`);
                    if (!conversation && job.pendingException?.id !== meta.id) {
                        conversation = await request({ action: 'getConversation', id: meta.id }, false);
                    }
                } catch (error) {
                    let detail;
                    try { detail = JSON.parse(error.detail).detail; } catch { /* Unknown 403s remain blocking. */ }
                    const inaccessible = error.action === 'getConversation' &&
                        (error.status === 404 || error.status === 403 && detail === 'Permission denied');
                    if (!inaccessible) throw error;
                    // A genuine per-item denial must not hide account-wide loss of
                    // access. Check another conversation using the same scheduler.
                    // Persist the denial before a probe that may defer to an alarm.
                    job.pendingException ||= {
                        id: meta.id, title: meta.title || '', status: error.status,
                        error: error.message, detail: error.detail, at: new Date(now()).toISOString()
                    };
                    await publish(job);
                }
                if (job.pendingException?.id === meta.id) {
                    if (job.pendingException.status === 403) {
                        const excluded = new Set(job.exceptions.map(item => item.id));
                        const knownGood = job.meta.slice(0, i).reverse().find(item => !excluded.has(item.id));
                        const probe = knownGood || job.meta[i + 1];
                        if (!probe) throw new Error(`${job.pendingException.error}. Cannot verify access to another conversation; export paused.`);
                        const accessible = await request({ action: 'getConversation', id: probe.id }, false);
                        if ((accessible.conversation_id || accessible.id) !== probe.id || !accessible.mapping) {
                            throw new Error('Cannot verify conversation access. Progress is saved.');
                        }
                        if (!knownGood) await store.put(job, `conversation:${probe.id}`, accessible);
                    }
                    const exception = job.pendingException;
                    job.exceptions.push(exception);
                    job.cursor = i + 1;
                    job.pendingException = null;
                    recordJobEvent(job, `Not exported: ${meta.title || '(untitled)'} (${meta.id}). ${exception.error}. Included in the exceptions report.`, 'warning', now());
                    try { await publish(job); }
                    catch (error) {
                        job.exceptions.pop(); job.cursor = i; job.pendingException = exception;
                        throw error;
                    }
                    continue;
                }
                if ((conversation.conversation_id || conversation.id) !== meta.id || !conversation.mapping) {
                    throw new Error(`Invalid conversation response for ${meta.id}. Progress is saved.`);
                }
                if (meta._projectId) Object.assign(conversation, {
                    _projectId: meta._projectId, _projectName: meta._projectName
                });
                job.fetched++;
                job.cursor = i + 1;
                try { await store.commit(job, `conversation:${meta.id}`, conversation); }
                catch (error) { job.fetched--; job.cursor = i; throw error; }
                notify(job);
            }
            const excluded = new Set(job.exceptions.map(item => item.id));
            const exportable = (job.meta || []).slice(0, job.finishEarly ? job.cursor : undefined)
                .filter(meta => !excluded.has(meta.id));
            // Bound packaging memory and checkpoint each completed output batch.
            while (job.saved < exportable.length) {
                check();
                if (now() - started >= sliceMs) await defer(now() + 30_000);
                const metas = exportable.slice(job.saved, job.saved + BATCH_SIZE);
                const batch = [];
                for (const meta of metas) {
                    const payload = await store.get(job, `conversation:${meta.id}`);
                    if (!payload) throw new Error(`Missing saved payload for ${meta.id}`);
                    batch.push(payload);
                }
                job.phase = 'exporting';
                await publish(job);
                const results = await interruptible(finishBatch(batch, job, signal), signal);
                check();
                job.saved += batch.length;
                job.results.push(...results);
                await publish(job);
            }
            if (job.exceptions.length && !job.exceptionsReportSaved) {
                check();
                job.phase = 'exporting';
                job.activity = 'Saving the exceptions report';
                await publish(job);
                if (!finishExceptions) throw new Error('Cannot save the exceptions report. Progress is saved.');
                const result = await interruptible(finishExceptions(job, signal), signal);
                check();
                job.exceptionsReportSaved = true;
                job.results.push(result);
                await publish(job);
            }
            job.status = job.phase = job.finishEarly && job.saved < job.total ? 'partial' : 'complete';
            job.error = null;
            recordJobEvent(job, `${job.status === 'partial' ? 'Partial export saved' : 'Export complete'}. ${job.saved} conversations saved.${job.exceptions.length ? ` ${job.exceptions.length} not exported; see the exceptions report.` : ''}`, 'success', now());
            await publish(job);
            await store.clearResponses();
            return { totalExported: job.saved, partial: job.status === 'partial', remaining: job.total - job.saved, exceptions: job.exceptions.length, results: job.results };
        } catch (error) {
            if (signal?.aborted) error = signal.reason;
            if (!(error instanceof Deferred)) {
                const cancelled = error.code === 'EXPORT_CANCELLED';
                if (error.code === 'EXPORT_END') job.finishEarly = true;
                job.status = job.phase = cancelled ? 'cancelled' : 'paused';
                job.error = cancelled || error.code === 'EXPORT_END' ? null : error.message;
                if (cancelled) job.activity = 'Export cancelled. You can start a new export.';
                else if (error.code === 'EXPORT_PAUSED') job.activity = error.message;
                job.errorDetail = error.status ? { status: error.status, detail: error.detail,
                    action: error.action, conversationId: error.conversationId } : null;
                job.resumeAt = null;
                recordJobEvent(job, `${job.activity && job.activity !== error.message && !cancelled ? `${job.activity}: ` : ''}${error.message}`, cancelled || ['EXPORT_PAUSED', 'EXPORT_END'].includes(error.code) ? 'info' : 'error', now());
                await publish(job);
            }
            return { [error.code === 'EXPORT_END' ? 'ending' : job.status === 'cancelled' ? 'cancelled' : job.status === 'paused' ? 'error' : 'deferred']: job.error || true, job };
        } finally { busy = false; }
    }

    return {
        run,
        async create(options) {
            const existing = await store.getJob();
            if (existing && !['complete', 'partial', 'cancelled'].includes(existing.status)) throw new Error('An unfinished export exists. Resume or cancel it first.');
            await store.clear();
            const previousRate = await store.getRate();
            const job = {
                ...options, id: crypto.randomUUID(), status: 'running', phase: 'fetching_list',
                meta: options.meta || null, fetched: 0, cursor: 0, exceptions: [], total: options.meta?.length || 0, saved: 0, results: [], error: null, events: [],
                rate: previousRate ? { ...previousRate, consecutive429: 0 } : {
                    level: 0, consecutive429: 0, successes: 0, spacingMs: MIN_SPACING_MS,
                    nextRequestAt: 0, cooldownUntil: 0, recovering: false, pacingPolicyVersion: PACING_POLICY_VERSION }
            };
            enforceMinimumSpacing(job);
            await store.save(job);
            return job;
        }
    };
}
