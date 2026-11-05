// Payloads and their checkpoint are committed in the same IndexedDB transaction.
export function createExportStore(indexedDB = globalThis.indexedDB) {
    let opening;
    function open() {
        if (!opening) opening = new Promise((resolve, reject) => {
            const request = indexedDB.open('gpt-exporter-jobs', 1);
            request.onupgradeneeded = () => {
                request.result.createObjectStore('jobs');
                request.result.createObjectStore('responses');
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        return opening;
    }
    async function transaction(mode, work) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(['jobs', 'responses'], mode);
            let result;
            tx.oncomplete = () => resolve(result?.result);
            tx.onabort = () => reject(tx.error || new Error('Export checkpoint transaction aborted'));
            tx.onerror = () => {}; // onabort reports the transaction failure.
            try { result = work(tx); } catch (error) { tx.abort(); reject(error); }
        });
    }
    function writeJob(tx, job) {
        // The queue can contain thousands of titles. Write it once rather than
        // rewriting the entire queue with every successful conversation.
        const { meta, ...checkpoint } = job;
        if (meta && !job.metaSaved) {
            tx.objectStore('jobs').put(meta, 'meta');
            checkpoint.metaSaved = true;
        }
        tx.objectStore('jobs').put(checkpoint, 'active');
        tx.objectStore('jobs').put(job.rate, 'rate');
    }
    function checkpoint(work, job) {
        return transaction('readwrite', tx => { work(tx); writeJob(tx, job); }).then(() => {
            if (job.meta) job.metaSaved = true;
        });
    }
    return {
        getJob: (includeMeta = true) => transaction('readonly', tx => {
            const request = tx.objectStore('jobs').get('active');
            request.onsuccess = () => {
                const job = request.result;
                if (!job) return;
                job.meta = null;
                if (includeMeta && job.metaSaved) {
                    const meta = tx.objectStore('jobs').get('meta');
                    meta.onsuccess = () => { job.meta = meta.result; };
                }
            };
            return request;
        }),
        getRate: () => transaction('readonly', tx => tx.objectStore('jobs').get('rate')),
        save: job => checkpoint(() => {}, job),
        get: (job, key) => transaction('readonly', tx => tx.objectStore('responses').get([job.id, key])),
        put: (job, key, value) => transaction('readwrite', tx => tx.objectStore('responses').put(value, [job.id, key])),
        getDownloads: job => transaction('readonly', tx => {
            const receipts = [];
            const cursor = tx.objectStore('responses').openKeyCursor();
            cursor.onsuccess = () => {
                const item = cursor.result;
                if (!item) return;
                if (item.key[0] === job.id && item.key[1].startsWith('download:')) {
                    const request = tx.objectStore('responses').get(item.key);
                    request.onsuccess = () => receipts.push(request.result);
                }
                item.continue();
            };
            return { result: receipts };
        }),
        async getDiscoveryAudit(job) {
            const cached = await transaction('readonly', tx => tx.objectStore('jobs').get('audit'));
            if (cached?.jobId === job.id) return cached.summary;
            const entries = await transaction('readonly', tx => {
                const pages = { projects: [], main: [] };
                const cursor = tx.objectStore('responses').openKeyCursor();
                cursor.onsuccess = () => {
                    const item = cursor.result;
                    if (!item) return;
                    if (item.key[0] === job.id && item.key[1].startsWith('{')) {
                        const action = JSON.parse(item.key[1]).action;
                        const source = action === 'getProjectConversations' ? 'projects'
                            : action === 'getConversationsList' ? 'main' : null;
                        if (source) {
                            const request = tx.objectStore('responses').get(item.key);
                            request.onsuccess = () => {
                                for (const entry of request.result.items || []) {
                                    pages[source].push({ id: entry.id, title: entry.title || '' });
                                }
                            };
                        }
                    }
                    item.continue();
                };
                return { result: pages };
            });
            const projectIds = new Map(entries.projects.filter(e => typeof e.id === 'string').map(e => [e.id, e.title]));
            const mainIds = new Map(entries.main.filter(e => typeof e.id === 'string').map(e => [e.id, e.title]));
            const unique = new Set([...projectIds.keys(), ...mainIds.keys()]);
            const overlap = [...projectIds.keys()].filter(id => mainIds.has(id));
            const summary = {
                projectEntries: entries.projects.length, mainEntries: entries.main.length,
                uniqueConversations: unique.size,
                repeatedEntries: entries.projects.length + entries.main.length - unique.size,
                inBothLists: overlap.length,
                examples: overlap.slice(0, 3).map(id => ({ id, title: projectIds.get(id) || mainIds.get(id) }))
            };
            if (entries.projects.length || entries.main.length) {
                await transaction('readwrite', tx => tx.objectStore('jobs').put({ jobId: job.id, summary }, 'audit'));
            }
            return summary;
        },
        commit: (job, key, response) => checkpoint(tx => {
            tx.objectStore('responses').put(response, [job.id, key]);
        }, job),
        clear: () => transaction('readwrite', tx => {
            tx.objectStore('responses').clear();
            // Discarding a job must not let a new job bypass a server cooldown.
            tx.objectStore('jobs').delete('active');
            tx.objectStore('jobs').delete('meta');
            tx.objectStore('jobs').delete('audit');
        }),
        clearResponses: () => transaction('readwrite', tx => tx.objectStore('responses').clear())
    };
}
