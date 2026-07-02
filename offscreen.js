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
    } else if (message.action === 'revoke-blob-url') {
        try {
            URL.revokeObjectURL(message.url);
        } catch (e) {
            // Ignore - revoking is best-effort
        }
        sendResponse({ success: true });
    }
});
