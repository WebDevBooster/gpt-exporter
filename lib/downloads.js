/** Wait for Chrome to finish writing an export before it can enter sync history. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export function createDownloadManager({ downloads, revokeBlobUrl, isCancelled = () => false,
    timeoutMs = DOWNLOAD_TIMEOUT_MS }) {
    const pending = new Map();

    function revoke(url) {
        try { Promise.resolve(revokeBlobUrl(url)).catch(() => {}); } catch { /* best effort */ }
    }

    function finish(id, error) {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        clearTimeout(entry.timer);
        revoke(entry.url);
        if (error) entry.reject(error);
        else entry.resolve(id);
    }

    function cancel(id, error) {
        finish(id, error);
        try { Promise.resolve(downloads.cancel(id)).catch(() => {}); } catch { /* already ended */ }
    }

    function terminal(id, state, reason) {
        if (state === 'complete') finish(id);
        if (state === 'interrupted') {
            finish(id, new Error(`Download ${id} failed: ${reason || 'interrupted'}`));
        }
    }

    downloads.onChanged.addListener(delta => {
        if (delta.state) terminal(delta.id, delta.state.current, delta.error?.current);
    });

    function cancelPending() {
        for (const id of pending.keys()) {
            cancel(id, new Error('Export cancelled by user (USER_CANCELED)'));
        }
    }

    async function download(url, filename) {
        if (isCancelled()) {
            revoke(url);
            throw new Error('Export cancelled by user (USER_CANCELED)');
        }
        let id;
        try {
            id = await downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
            if (!Number.isInteger(id)) throw new Error('Chrome did not return a download ID');
        } catch (error) {
            revoke(url);
            throw error;
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cancel(id, new Error(`Download ${id} did not finish within 10 minutes; export history was not updated`));
            }, timeoutMs);
            pending.set(id, { url, resolve, reject, timer });
            if (isCancelled()) {
                cancelPending();
                return;
            }
            // A small download can finish before download() returns its ID. Querying after
            // registering the waiter closes that race without missing subsequent events.
            Promise.resolve().then(() => downloads.search({ id })).then(items => {
                if (!pending.has(id)) return;
                const item = items.find(item => item.id === id);
                if (!item) {
                    cancel(id, new Error(`Download ${id} is missing; export history was not updated`));
                    return;
                }
                terminal(id, item.state, item.error);
            }).catch(error => {
                if (pending.has(id)) {
                    cancel(id, new Error(`Cannot verify download ${id}: ${error.message}`));
                }
            });
        });
    }

    return { download, cancelPending };
}
