/**
 * Offscreen document for GPT Exporter.
 *
 * MV3 service workers cannot use URL.createObjectURL, and Chrome's download
 * system rejects data: URLs larger than ~2MB (the download fails with
 * NETWORK_FAILED, shown as "Check internet connection"). This document
 * creates real Blob URLs on behalf of the service worker so downloads of
 * any size work.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target !== 'offscreen') {
        return; // Not for us
    }

    if (message.action === 'create-blob-url') {
        try {
            let blob;
            if (message.isBase64) {
                const binary = atob(message.content);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) {
                    bytes[i] = binary.charCodeAt(i);
                }
                blob = new Blob([bytes], { type: message.mimeType });
            } else {
                blob = new Blob([message.content], { type: message.mimeType });
            }
            const url = URL.createObjectURL(blob);
            sendResponse({ success: true, url });
        } catch (error) {
            sendResponse({ success: false, error: error.message });
        }
    } else if (message.action === 'create-zip-blob-url') {
        // Build a compressed ZIP with the real JSZip (loaded via offscreen.html)
        // and return a Blob URL for it. Async, so keep the channel open.
        (async () => {
            try {
                const zip = new JSZip();
                for (const file of message.files) {
                    zip.file(file.filename, file.content);
                }
                const blob = await zip.generateAsync({
                    type: 'blob',
                    compression: 'DEFLATE',
                    compressionOptions: { level: 6 }
                });
                sendResponse({ success: true, url: URL.createObjectURL(blob) });
            } catch (error) {
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true; // Keep message channel open for async sendResponse
    } else if (message.action === 'revoke-blob-url') {
        try {
            URL.revokeObjectURL(message.url);
        } catch (e) {
            // Ignore - revoking is best-effort
        }
        sendResponse({ success: true });
    }
});
