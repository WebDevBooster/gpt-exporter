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
        commit: (job, key, response) => checkpoint(tx => {
            tx.objectStore('responses').put(response, [job.id, key]);
        }, job),
        clear: () => transaction('readwrite', tx => {
            tx.objectStore('responses').clear();
            // Discarding a job must not let a new job bypass a server cooldown.
            tx.objectStore('jobs').delete('active');
            tx.objectStore('jobs').delete('meta');
        }),
        clearResponses: () => transaction('readwrite', tx => tx.objectStore('responses').clear())
    };
}
