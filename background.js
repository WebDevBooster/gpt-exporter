/**
 * Background Service Worker
 * Handles extension messaging, API calls via content script, and downloads
 */

import { conversationToMarkdown } from './export/markdown.js';
import { createBackupJson } from './export/json.js';
import { filterNeedingExport, markMultipleExported, getStats, clearHistory } from './sync/tracker.js';
import { parseChatGPTConversationUrl } from './lib/chatgpt-url.js';
import { createDownloadManager } from './lib/downloads.js';

import { createExportStore } from './lib/export-store.js';
import { createExportRunner, recordJobEvent } from './lib/export-job.js';

const ZIP_THRESHOLD = 3;
const JOB_ALARM = 'gpt-exporter-resume';
const jobStore = createExportStore();
let activeRun = null;
let controlBusy = false;
let pausing = false;
let exportState = { isRunning: false, phase: null, cancelRequested: false };

function updateExportState(phase, current, total) {
    exportState = { ...exportState, phase, current, total };
    chrome.runtime.sendMessage({ type: 'progress', ...exportState }).catch(() => {});
}

function checkCancellation() {
    if (exportState.cancelRequested) throw new Error('Export paused by user. Progress is saved.');
}

function stateFromJob(job) {
    return job ? {
        isRunning: ['running', 'waiting', 'cooldown'].includes(job.status),
        phase: job.phase, status: job.status, current: job.fetched, total: job.total,
        fetched: job.fetched, pending: Math.max(0, job.total - job.fetched), saved: job.saved,
        failed: job.status === 'paused' && job.error ? 1 : 0,
        error: job.error, resumeAt: job.resumeAt, cooldownUntil: job.rate.cooldownUntil,
        retryLevel: job.rate.level, spacingMs: job.rate.spacingMs,
        events: job.events || [],
        canResume: job.status === 'paused', canDiscard: job.status !== 'complete'
    } : { isRunning: false, phase: null };
}

function notifyJob(job) {
    exportState = { ...stateFromJob(job), cancelRequested: exportState.cancelRequested };
    chrome.runtime.sendMessage({ type: 'progress', ...exportState }).catch(() => {});
    const badge = job.status === 'paused' ? '!' : job.status === 'cooldown' ? '429' : '';
    chrome.action?.setBadgeText({ text: badge }).catch(() => {});
    chrome.action?.setBadgeBackgroundColor({ color: job.status === 'paused' ? '#b91c1c' : '#b45309' }).catch(() => {});
}

/**
 * Find a ChatGPT tab to communicate with
 * Prefers: 1) Active tab in current window, 2) Regular chat tabs over Custom GPT tabs
 */
async function findChatGPTTab() {
    // First try to find tabs in the current/focused window
    const currentWindowTabs = await chrome.tabs.query({
        url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
        currentWindow: true
    });

    console.log(`[BG] Found ${currentWindowTabs.length} ChatGPT tab(s) in current window`);

    if (currentWindowTabs.length > 0) {
        // Prefer regular chat tabs (not Custom GPTs which have /g/ in URL)
        const regularTabs = currentWindowTabs.filter(t => !t.url.includes('/g/'));
        const activeTab = currentWindowTabs.find(t => t.active);

        if (activeTab) {
            console.log(`[BG] Using active tab: ${activeTab.id} (${activeTab.url})`);
            return activeTab;
        }
        if (regularTabs.length > 0) {
            console.log(`[BG] Using regular chat tab: ${regularTabs[0].id}`);
            return regularTabs[0];
        }
        return currentWindowTabs[0];
    }

    // Fallback: check all windows, prefer regular chat tabs
    const allTabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] });
    if (allTabs.length === 0) {
        throw new Error('No ChatGPT tab found. Please open chatgpt.com first.');
    }

    const regularTabs = allTabs.filter(t => !t.url.includes('/g/'));
    const selected = regularTabs.length > 0 ? regularTabs[0] : allTabs[0];
    console.log(`[BG] Using tab from other window: ${selected.id} (${selected.url})`);
    return selected;
}
/**
 * Cached tab for current export session
 * This prevents tab switching from breaking an ongoing export
 */
let cachedExportTab = null;

/**
 * Clear the cached tab (call at start of new export)
 */
function clearCachedTab() {
    cachedExportTab = null;
    console.log('[BG] Cleared cached export tab');
}

/**
 * Get or find a ChatGPT tab for the export session
 * Uses cached tab if available and valid, otherwise finds a new one
 */
async function getExportTab() {
    // If we have a cached tab, verify it still exists
    if (cachedExportTab) {
        try {
            const tab = await chrome.tabs.get(cachedExportTab.id);
            if (tab && tab.url && (tab.url.includes('chatgpt.com') || tab.url.includes('chat.openai.com'))) {
                return cachedExportTab;
            }
        } catch (e) {
            // Tab no longer exists
            console.log('[BG] Cached tab no longer available, finding new one...');
        }
        cachedExportTab = null;
    }

    // Find a new tab
    const tab = await findChatGPTTab();
    cachedExportTab = tab;
    console.log(`[BG] Cached export tab: ${tab.id} (${tab.url})`);
    return tab;
}

/**
 * Send message to a specific ChatGPT tab
 */
async function sendToTab(tab, message) {
    if (!tab?.id) {
        throw new Error('No valid ChatGPT tab available.');
    }

    // First try to send message directly
    try {
        const response = await chrome.tabs.sendMessage(tab.id, message);
        return response;
    } catch (error) {
        // Content script not loaded, try to inject it
        console.log(`[BG] Content script not responding on tab ${tab.id}, attempting injection...`);

        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content.js']
            });
            console.log('[BG] Content script injected, waiting...');

            // Wait for script to initialize
            await new Promise(r => setTimeout(r, 500));

            // Try again
            const response = await chrome.tabs.sendMessage(tab.id, message);
            return response;
        } catch (injectError) {
            console.error(`[BG] Injection failed on tab ${tab.id}:`, injectError.message);
            throw new Error('Failed to connect to ChatGPT tab. Please ensure you have a ChatGPT page open and try again.');
        }
    }
}

/**
 * Send message to content script using cached tab
 */
async function sendToContentScript(message) {
    const tab = await getExportTab();
    try {
        return await sendToTab(tab, message);
    } catch (error) {
        // Clear the cached tab so we try a different one next time
        cachedExportTab = null;
        throw error;
    }
}


function extractProjectUUID(projectId) {
    if (!projectId || typeof projectId !== 'string') {
        return null;
    }

    const match = projectId.match(/^(g-p-[a-f0-9]{32})/);
    return match ? match[1] : projectId;
}

function getConversationTargetFromTab(tab) {
    if (!tab?.id || !tab.url) {
        return null;
    }

    const parsed = parseChatGPTConversationUrl(tab.url);
    if (!parsed) {
        return null;
    }

    return {
        tab,
        conversationId: parsed.conversationId,
        projectId: parsed.projectId
    };
}

async function getCurrentConversationTarget() {
    const focusedTabs = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true
    });
    const focusedTarget = getConversationTargetFromTab(focusedTabs[0]);
    if (focusedTarget) {
        return focusedTarget;
    }

    const activeTabs = await chrome.tabs.query({ active: true });
    const matchingTargets = activeTabs
        .map(getConversationTargetFromTab)
        .filter(Boolean);

    if (matchingTargets.length === 1) {
        return matchingTargets[0];
    }

    if (matchingTargets.length > 1) {
        throw new Error('Multiple active ChatGPT conversations found in different windows. Focus the one you want, then try again.');
    }

    throw new Error('No active ChatGPT conversation found. Open the chat you want to export, then try again.');
}

async function buildExportFiles(fullConversations, formats, reportProgress) {
    const filesToBundle = [];

    if (formats.markdown) {
        const markdownOptions = { includeAboveBranchedFrom: !!formats.includeAboveBranchedFrom };
        for (let i = 0; i < fullConversations.length; i++) {
            const md = conversationToMarkdown(fullConversations[i], markdownOptions);
            filesToBundle.push({ filename: md.filename, content: md.content, mimeType: 'text/markdown' });
            reportProgress('exporting', i + 1, fullConversations.length);
        }
    }

    if (formats.json) {
        const json = createBackupJson(fullConversations);
        filesToBundle.push({ filename: json.filename, content: json.content, mimeType: 'application/json' });
    }

    return filesToBundle;
}

async function downloadExportFiles(filesToBundle, folder = '', suffix = '') {
    const results = [];

    if (filesToBundle.length > ZIP_THRESHOLD) {
        updateExportState('zipping', 0, filesToBundle.length);
        const today = new Date().toISOString().split('T')[0];
        const zipFilename = `ChatGPT_Export_${today}${suffix}.zip`;
        await createZipBundle(filesToBundle, zipFilename, folder);
        results.push({ type: 'zip', filename: zipFilename, fileCount: filesToBundle.length });
        return results;
    }

    for (const file of filesToBundle) {
        await downloadFile(file.filename, file.content, file.mimeType, folder);
        results.push({ type: file.mimeType.includes('markdown') ? 'markdown' : 'json', filename: file.filename });
    }

    return results;
}

async function markConversationsAsExported(fullConversations) {
    const exportedData = fullConversations.map(c => ({
        id: c.conversation_id || c.id,
        updateTime: c.update_time
            ? (typeof c.update_time === 'number'
                ? new Date(c.update_time * 1000).toISOString()
                : c.update_time)
            : new Date().toISOString()
    }));

    await markMultipleExported(exportedData);
}

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
let offscreenCreating = null;

async function ensureOffscreenDocument() {
    if (await chrome.offscreen.hasDocument()) {
        return;
    }
    if (!offscreenCreating) {
        offscreenCreating = chrome.offscreen.createDocument({
            url: OFFSCREEN_DOCUMENT_PATH,
            reasons: ['BLOBS'],
            justification: 'Create Blob URLs for downloading exported files (data URLs fail for files larger than ~2MB)'
        }).finally(() => {
            offscreenCreating = null;
        });
    }
    await offscreenCreating;
}

/**
 * Create a Blob URL in the offscreen document.
 * @param {string} content - File content (text, or base64 if isBase64 is true)
 * @param {string} mimeType
 * @param {boolean} isBase64
 * @returns {Promise<string>} blob: URL
 */
async function createBlobUrl(content, mimeType, isBase64 = false) {
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'create-blob-url',
        content,
        mimeType,
        isBase64
    });
    if (!response || !response.success) {
        throw new Error(`Failed to create blob URL: ${response ? response.error : 'no response from offscreen document'}`);
    }
    return response.url;
}

const downloadManager = createDownloadManager({
    downloads: chrome.downloads,
    isCancelled: () => exportState.cancelRequested,
    revokeBlobUrl: url => chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'revoke-blob-url',
        url
    })
});

/**
 * Download a blob and wait for successful terminal completion, including cleanup.
 */
async function downloadBlobUrl(blobUrl, fullPath) {
    updateExportState('saving', 0, 1);
    let receipt;
    let existingId;
    let delegated = false;
    try {
        const job = await jobStore.getJob(false);
        const key = `download:${job.saved}:${fullPath}`;
        receipt = await jobStore.get(job, key);
        if (receipt) {
            const items = await chrome.downloads.search({ id: receipt.id });
            const previous = items.find(item => item.id === receipt.id);
            if (previous?.state === 'complete') return receipt.id;
            if (previous?.state === 'in_progress') existingId = receipt.id;
        }
        const startedAt = existingId ? receipt.startedAt : Date.now();
        delegated = true;
        return await downloadManager.download(blobUrl, fullPath, {
            existingId,
            waitTimeoutMs: Math.max(1, 600_000 - (Date.now() - startedAt)),
            onStarted: id => jobStore.put(job, key, { id, url: blobUrl, startedAt })
        });
    } finally {
        // Includes receipts completed while their original worker was absent.
        for (const url of new Set([!delegated && blobUrl, receipt?.url !== blobUrl && receipt?.url].filter(Boolean))) {
            chrome.runtime.sendMessage({ target: 'offscreen', action: 'revoke-blob-url', url }).catch(() => {});
        }
    }
}

/**
 * Download a file using Chrome downloads API
 */
async function downloadFile(filename, content, mimeType = 'text/plain', folder = '') {
    console.log(`[BG] downloadFile called with filename: "${filename}"`);

    let fullPath = filename;
    if (folder) {
        folder = folder.replace(/^[/\\]+|[/\\]+$/g, '');
        fullPath = `${folder}/${filename}`;
    }

    console.log(`[BG] Full download path: "${fullPath}"`);

    try {
        // Use a Blob URL created in the offscreen document. Unlike data:
        // URLs, blob: URLs have no size limit in the downloads system.
        const blobUrl = await createBlobUrl(content, mimeType, false);
        const downloadId = await downloadBlobUrl(blobUrl, fullPath);

        console.log(`[BG] Download complete: ${fullPath} (ID: ${downloadId})`);

        return downloadId;
    } catch (error) {
        console.error(`[BG] Download failed for ${fullPath}:`, error);
        throw error;
    }
}

/**
 * Create a ZIP bundle from multiple files
 * @param {Array} files - Array of {filename, content, mimeType} objects
 * @param {string} zipFilename - Name of the output ZIP file
 * @param {string} folder - Optional folder path
 */
async function createZipBundle(files, zipFilename, folder = '') {
    console.log(`[BG] Creating ZIP bundle with ${files.length} files`);

    let fullPath = zipFilename;
    if (folder) {
        folder = folder.replace(/^[/\\]+|[/\\]+$/g, '');
        fullPath = `${folder}/${zipFilename}`;
    }

    try {
        // ZIP is built with real JSZip (DEFLATE compression) in the offscreen
        // document, which returns a Blob URL (no data: URL size limit).
        await ensureOffscreenDocument();
        const response = await chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'create-zip-blob-url',
            files: files.map(f => ({ filename: f.filename, content: f.content }))
        });
        if (!response || !response.success) {
            throw new Error(`ZIP creation failed: ${response ? response.error : 'no response from offscreen document'}`);
        }
        const downloadId = await downloadBlobUrl(response.url, fullPath);

        console.log(`[BG] ZIP download complete: ${fullPath} (ID: ${downloadId})`);

        return downloadId;
    } catch (error) {
        console.error(`[BG] ZIP download failed:`, error);
        throw error;
    }
}

async function projects(request) {
    const items = [];
    const seen = new Set();
    let cursor = null;
    do {
        const response = await request({ action: 'getProjectsList', cursor }, true, [404]);
        if (response.status === 404) {
            const fallback = await request({ action: 'getProjectsList', source: 'discovery' }, true, [404]);
            if (!fallback.error) items.push(...(fallback.items || []));
            break;
        }
        items.push(...(response.items || []));
        cursor = response.cursor;
        if (cursor && seen.has(cursor)) throw new Error('Project pagination repeated a cursor. Export paused.');
        seen.add(cursor);
    } while (cursor);
    if (!items.length) items.push(...(await request({ action: 'getProjectsList', source: 'dom' })).items || []);
    return items;
}

async function discover(job, request) {
    if (job.kind === 'current') {
        const meta = { id: job.target.conversationId };
        if (job.target.projectId) {
            const project = (await projects(request)).find(p => extractProjectUUID(p.gizmo?.id || p.id) === extractProjectUUID(job.target.projectId));
            meta._projectId = job.target.projectId;
            meta._projectName = project?.gizmo?.display?.name || project?.display?.name || job.target.projectId;
        }
        return [meta];
    }
    // Cache each metadata page so interrupted discovery resumes without repeating
    // successful requests. Keep project metadata when main listings repeat IDs.
    const all = new Map();
    let fetchLimit = job.limit || 0;
    if (job.kind === 'new' && fetchLimit && (await getStats()).totalExported > 0) {
        fetchLimit = Math.max(fetchLimit * 3, fetchLimit + 100);
    }
    for (const project of await projects(request)) {
        const projectId = project.gizmo?.id || project.id;
        const projectName = project.gizmo?.display?.name || project.display?.name || projectId;
        if (!projectId) continue;
        let cursor = '0';
        const seen = new Set();
        do {
            const response = await request({ action: 'getProjectConversations', projectId, cursor });
            if (!Array.isArray(response.items)) throw new Error('Invalid project conversation list. Export paused.');
            for (const item of response.items || []) all.set(item.id, { ...item, _projectId: projectId, _projectName: projectName });
            cursor = response.cursor;
            if (cursor && seen.has(cursor)) throw new Error('Conversation pagination repeated a cursor. Export paused.');
            seen.add(cursor);
        } while (cursor && (!fetchLimit || all.size < fetchLimit));
        if (fetchLimit && all.size >= fetchLimit) break;
    }
    if (!fetchLimit || all.size < fetchLimit) {
        for (let offset = 0; ; offset += 28) {
            const response = await request({ action: 'getConversationsList', offset, limit: 28 });
            if (!Array.isArray(response.items)) throw new Error('Invalid conversation list. Export paused.');
            if (!response.items.length) break;
            for (const item of response.items) if (!all.has(item.id)) all.set(item.id, item);
            if (fetchLimit && all.size >= fetchLimit) break;
        }
    }
    const meta = [...all.values()];
    return job.kind === 'new' ? filterNeedingExport(meta) : meta;
}

const runner = createExportRunner({
    store: jobStore,
    send: sendToContentScript,
    discover,
    checkCancelled: checkCancellation,
    schedule: when => chrome.alarms.create(JOB_ALARM, { when }),
    notify: notifyJob,
    async finishBatch(batch, job) {
        const files = await buildExportFiles(batch, job.formats, updateExportState);
        const suffix = job.total > 100 ? `_${job.id.slice(0, 8)}_part-${Math.floor(job.saved / 100) + 1}` : '';
        const results = await downloadExportFiles(files, job.folder, suffix);
        checkCancellation();
        await markConversationsAsExported(batch);
        return results;
    }
});

async function execute(job) {
    if (activeRun) throw new Error('An export is already running');
    exportState.cancelRequested = false;
    // A watchdog survives an unexpected termination in the middle of a fetch or
    // download. The next normal checkpoint replaces it with the precise alarm.
    // Only bounded work runs in an event. Cooldowns and long jobs continue via alarms.
    activeRun = (async () => {
        await chrome.alarms.create(JOB_ALARM, { when: Date.now() + 120_000 });
        return runner.run(job);
    })();
    try {
        const { job: checkpoint, ...result } = await activeRun;
        if (!checkpoint || checkpoint.status === 'paused') await chrome.alarms.clear(JOB_ALARM);
        return result;
    }
    finally { activeRun = null; }
}

async function startExport(kind, message) {
    if (!message.formats || (!message.formats.markdown && !message.formats.json)) throw new Error('Select at least one export format.');
    if (controlBusy || activeRun || pausing) throw new Error('An export is already running');
    controlBusy = true;
    try {
        clearCachedTab();
        const target = kind === 'current' ? await getCurrentConversationTarget() : null;
        if (target) cachedExportTab = target.tab;
        const job = await runner.create({ kind, formats: message.formats, folder: message.downloadFolder || '',
            limit: Math.max(0, Number(message.limit) || 0), target });
        return await execute(job);
    } finally { controlBusy = false; }
}

async function resumeExport() {
    if (controlBusy || activeRun || pausing) throw new Error('An export is already running');
    controlBusy = true;
    try {
        const job = await jobStore.getJob();
        if (!job || job.status === 'complete') throw new Error('No unfinished export to resume');
        job.rate.consecutive429 = 0;
        job.transient = null;
        return await execute(job);
    } finally { controlBusy = false; }
}

async function cancelExport() {
    if (pausing) throw new Error('The export is already being paused.');
    if (controlBusy && !activeRun) throw new Error('The export is starting. Try Pause again shortly.');
    pausing = true;
    try {
        exportState.cancelRequested = true;
        downloadManager.cancelPending();
        await chrome.alarms.clear(JOB_ALARM);
        if (activeRun) await activeRun;
        const job = await jobStore.getJob();
        if (!job || job.status === 'complete') return { success: false, error: 'No unfinished export' };
        job.status = job.phase = 'paused';
        job.error = 'Export paused by user. Progress is saved.';
        recordJobEvent(job, job.error);
        await jobStore.save(job);
        await chrome.alarms.clear(JOB_ALARM);
        notifyJob(job);
        return { success: true };
    } finally { pausing = false; }
}

// Register listeners synchronously so Chrome can wake a suspended worker.
chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name !== JOB_ALARM) return;
    return ready.then(async () => {
        if (controlBusy || activeRun || pausing) {
            await chrome.alarms.create(JOB_ALARM, { when: Date.now() + 120_000 });
            return;
        }
        const job = await jobStore.getJob();
        if (job && ['running', 'cooldown', 'waiting'].includes(job.status)) await execute(job);
    }).catch(console.error);
});

const ready = (async () => {
    const job = await jobStore.getJob(false);
    if (!job) return;
    notifyJob(job);
    // Recreate alarms after worker termination, extension update or browser restart.
    if (['running', 'cooldown', 'waiting'].includes(job.status)) {
        await chrome.alarms.create(JOB_ALARM, { when: Math.max(Date.now() + 1000, job.resumeAt || 0, job.rate.cooldownUntil) });
    }
})();

chrome.runtime.onStartup?.addListener(() => { ready.catch(console.error); });
chrome.runtime.onInstalled?.addListener(() => { ready.catch(console.error); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target === 'offscreen') return;
    // Content scripts cannot start, discard or otherwise control export jobs.
    if (sender.tab) return;
    (async () => {
        await ready;
        switch (message.action) {
            case 'checkConnection': {
                const response = await sendToContentScript({ action: 'ping' });
                return { connected: !!response?.success };
            }
            case 'getStats': return getStats();
            case 'getExportState': return { ...stateFromJob(await jobStore.getJob(false)), ...(activeRun ? exportState : {}) };
            case 'getCurrentConversationTarget': {
                const target = await getCurrentConversationTarget();
                return { available: true, conversationId: target.conversationId, projectId: target.projectId };
            }
            case 'exportAll': return startExport('all', message);
            case 'exportNewUpdated': return startExport('new', message);
            case 'exportCurrentConversation': return startExport('current', message);
            case 'resumeExport': return resumeExport();
            case 'cancelExport': return cancelExport();
            case 'discardExport':
                if (activeRun || controlBusy || pausing) throw new Error('Pause the export before discarding it.');
                controlBusy = true;
                try {
                    await chrome.alarms.clear(JOB_ALARM);
                    await jobStore.clear();
                    exportState = { isRunning: false, phase: null, cancelRequested: false };
                    chrome.action?.setBadgeText({ text: '' }).catch(() => {});
                    chrome.runtime.sendMessage({ type: 'progress', ...exportState }).catch(() => {});
                    return { success: true };
                } finally { controlBusy = false; }
            case 'clearHistory': return clearHistory();
            default: throw new Error(`Unknown action: ${message.action}`);
        }
    })().then(sendResponse, error => sendResponse({ error: error.message }));
    return true;
});
