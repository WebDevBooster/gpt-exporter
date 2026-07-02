/**
 * Background Service Worker
 * Handles extension messaging, API calls via content script, and downloads
 */

import { conversationToMarkdown } from './export/markdown.js';
import { createBackupJson } from './export/json.js';
import { filterNeedingExport, markMultipleExported, getStats, clearHistory } from './sync/tracker.js';
import { loadJSZip } from './lib/jszip-loader.js';
import { parseChatGPTConversationUrl } from './lib/chatgpt-url.js';

const RATE_LIMIT_DELAY = 4000; // 4 seconds between requests (avoid rate limiting)
const ZIP_THRESHOLD = 3; // Bundle into ZIP if more than this many files
const MAX_RETRIES = 3; // Retry failed requests
const RETRY_BACKOFF = 10000; // 10 seconds base backoff on retry

// Export state tracking - allows popup to query current progress
let exportState = {
    isRunning: false,
    phase: null,
    current: 0,
    total: 0,
    startTime: null,
    cancelRequested: false
};

/**
 * Update export state and broadcast to any open popups
 */
function updateExportState(phase, current, total) {
    exportState.phase = phase;
    exportState.current = current;
    exportState.total = total;

    // Broadcast to popup
    chrome.runtime.sendMessage({ type: 'progress', phase, current, total }).catch(() => {
        // Popup not open, ignore
    });
}

/**
 * Get current export state
 */
function getExportState() {
    return { ...exportState };
}

/**
 * Request cancellation of the current export
 */
function cancelExport() {
    if (!exportState.isRunning) {
        return { success: false, error: 'No export is currently running' };
    }
    exportState.cancelRequested = true;
    console.log('[BG] Export cancellation requested');
    return { success: true };
}

/**
 * Check if cancellation was requested and throw if so
 */
function checkCancellation() {
    if (exportState.cancelRequested) {
        throw new Error('Export cancelled by user');
    }
}

/**
 * Sleep utility
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get a random delay between min and max milliseconds
 */
function randomDelay(minMs, maxMs) {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
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

/**
 * Wrapper to call content script with retry logic
 * Handles rate limiting and temporary failures during list fetching
 */
async function sendWithRetry(message, description = 'API call') {
    let lastError = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const response = await sendToContentScript(message);

            if (response.error) {
                lastError = response.error;
                const backoffTime = RETRY_BACKOFF * (attempt + 1);
                console.warn(`[BG] ⚠️ ${description} attempt ${attempt + 1}/${MAX_RETRIES} returned error: ${lastError}`);
                console.log(`[BG] Waiting ${backoffTime / 1000}s before retry...`);
                await sleep(backoffTime);
                continue;
            }

            return response;
        } catch (error) {
            lastError = error.message || String(error);
            const backoffTime = RETRY_BACKOFF * (attempt + 1);
            console.warn(`[BG] ⚠️ ${description} attempt ${attempt + 1}/${MAX_RETRIES} threw exception: ${lastError}`);
            console.log(`[BG] Waiting ${backoffTime / 1000}s before retry...`);
            await sleep(backoffTime);
        }
    }

    console.error(`[BG] ❌ ${description} failed after ${MAX_RETRIES} attempts. Last error: ${lastError}`);
    return { error: lastError };
}

/**
 * Get conversation list via content script (with retry)
 */
async function getConversationsList(offset = 0, limit = 28) {
    return sendWithRetry(
        { action: 'getConversationsList', offset, limit },
        `getConversationsList(offset=${offset})`
    );
}

/**
 * Get list of projects (with retry)
 */
async function getProjectsList() {
    return sendWithRetry(
        { action: 'getProjectsList' },
        'getProjectsList'
    );
}

/**
 * Get conversations within a project (with retry)
 */
async function getProjectConversations(projectId, cursor = '0') {
    return sendWithRetry(
        { action: 'getProjectConversations', projectId, cursor },
        `getProjectConversations(${projectId})`
    );
}

/**
 * Get all conversations from a specific project
 * Uses cursor-based pagination
 * @param {number} maxItems - Optional limit on number of items to fetch (0 = unlimited)
 */
async function getAllProjectConversationsMeta(projectId, projectName, onProgress = null, maxItems = 0) {
    console.log(`[BG] Fetching conversations for project: ${projectName}${maxItems > 0 ? ` (max ${maxItems})` : ''}`);
    const conversations = [];
    let cursor = '0';
    let totalFetched = 0;

    while (true) {
        // Check for cancellation
        checkCancellation();

        const response = await getProjectConversations(projectId, cursor);

        if (response.error) {
            console.log(`[BG] Error fetching project conversations: ${response.error}`);
            break;
        }

        if (!response.items || response.items.length === 0) {
            console.log(`[BG] No more conversations for project "${projectName}"`);
            break;
        }

        // Mark conversations with their project info
        const itemsWithProject = response.items.map(item => ({
            ...item,
            _projectId: projectId,
            _projectName: projectName
        }));

        conversations.push(...itemsWithProject);
        totalFetched += response.items.length;

        console.log(`[BG] Fetched ${totalFetched} conversations from project "${projectName}"`);

        if (onProgress) {
            onProgress(conversations.length, response.total || conversations.length);
        }

        // Check if we've reached the limit
        if (maxItems > 0 && conversations.length >= maxItems) {
            console.log(`[BG] Reached limit of ${maxItems} for project "${projectName}"`);
            break;
        }

        // Check if there's a next page
        if (!response.cursor) {
            console.log(`[BG] No more pages for project "${projectName}"`);
            break;
        }

        cursor = response.cursor;
        await sleep(randomDelay(2000, 4000));
    }

    console.log(`[BG] Total: ${conversations.length} conversations from project "${projectName}"`);
    return conversations;
}


/**
 * Get all conversation metadata (including from projects)
 * Projects are fetched FIRST because they tend to be more important
 * @param {function} onProgress - Progress callback
 * @param {number} fetchLimit - Optional limit on total items to fetch (0 = unlimited)
 */
async function getAllConversationsMeta(onProgress = null, fetchLimit = 0) {
    console.log(`[BG] getAllConversationsMeta starting...${fetchLimit > 0 ? ` (limit: ${fetchLimit})` : ''}`);
    const allConversations = [];

    // FIRST: Fetch projects and their conversations (higher priority)
    console.log('[BG] Fetching projects first (higher priority)...');
    const projectsResponse = await getProjectsList();

    if (projectsResponse.items && projectsResponse.items.length > 0) {
        console.log(`[BG] Found ${projectsResponse.items.length} projects`);

        for (const project of projectsResponse.items) {
            // Check for cancellation
            checkCancellation();

            // Check if we've reached the limit
            if (fetchLimit > 0 && allConversations.length >= fetchLimit) {
                console.log(`[BG] Reached fetch limit of ${fetchLimit}, stopping project fetch`);
                break;
            }

            const projectId = project.gizmo?.id || project.id;
            const projectName = project.gizmo?.display?.name || project.display?.name || projectId;

            if (!projectId) continue;

            // Random delay 2-4 seconds between project fetches
            await sleep(randomDelay(2000, 4000));

            // Calculate remaining items we can fetch
            const remainingLimit = fetchLimit > 0 ? fetchLimit - allConversations.length : 0;

            const projectConversations = await getAllProjectConversationsMeta(
                projectId,
                projectName,
                (current, projectTotal) => {
                    if (onProgress) {
                        // Report progress as we fetch project conversations
                        onProgress(allConversations.length + current, allConversations.length + current);
                    }
                },
                remainingLimit
            );

            if (projectConversations.length > 0) {
                allConversations.push(...projectConversations);
                console.log(`[BG] Added ${projectConversations.length} conversations from project "${projectName}"`);
            }
        }
    } else {
        console.log('[BG] No projects found or projects API not available');
    }

    // Check if we've already reached the limit from projects
    if (fetchLimit > 0 && allConversations.length >= fetchLimit) {
        console.log(`[BG] Reached fetch limit of ${fetchLimit} from projects alone`);
        console.log(`[BG] Total conversations (projects only): ${allConversations.length}`);
        return allConversations;
    }

    // SECOND: Get main/regular conversations
    console.log('[BG] Now fetching main/regular conversations...');
    let offset = 0;
    const pageSize = 28;

    while (true) {
        // Check for cancellation
        checkCancellation();

        const response = await getConversationsList(offset, pageSize);

        if (response.error) {
            throw new Error(response.error);
        }

        // Continue until API returns no more items (don't trust 'total' - it may be capped)
        if (!response.items || response.items.length === 0) {
            console.log(`[BG] No more main conversations at offset ${offset}`);
            break;
        }

        allConversations.push(...response.items);
        console.log(`[BG] Fetched ${response.items.length} main conversations (total so far: ${allConversations.length})`);

        if (onProgress) {
            onProgress(allConversations.length, allConversations.length);
        }

        // Check if we've reached the limit
        if (fetchLimit > 0 && allConversations.length >= fetchLimit) {
            console.log(`[BG] Reached fetch limit of ${fetchLimit}, stopping main conversation fetch`);
            break;
        }

        offset += pageSize;
        // Random delay 2-4 seconds between list pages
        await sleep(randomDelay(2000, 4000));
    }

    console.log(`[BG] Total conversations (projects + main): ${allConversations.length}`);
    return allConversations;
}

/**
 * Get single conversation via content script
 */
async function getConversation(id) {
    return sendToContentScript({ action: 'getConversation', id });
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

async function getProjectNameForCurrentConversation(tab, projectId) {
    if (!projectId) {
        return null;
    }

    try {
        const response = await sendToTab(tab, { action: 'getProjectsList' });
        if (response?.error) {
            return null;
        }

        const apiProjectId = extractProjectUUID(projectId);

        for (const project of response.items || []) {
            const candidateId = project.gizmo?.id || project.id;
            if (!candidateId) {
                continue;
            }

            if (candidateId === projectId || extractProjectUUID(candidateId) === apiProjectId) {
                return project.gizmo?.display?.name || project.display?.name || null;
            }
        }
    } catch (error) {
        console.warn('[BG] Project name lookup failed for current conversation:', error.message);
    }

    return null;
}

async function buildExportFiles(fullConversations, formats, reportProgress) {
    const filesToBundle = [];

    if (formats.markdown) {
        for (let i = 0; i < fullConversations.length; i++) {
            const md = conversationToMarkdown(fullConversations[i]);
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

async function downloadExportFiles(filesToBundle, folder = '') {
    const results = [];

    if (filesToBundle.length > ZIP_THRESHOLD) {
        updateExportState('zipping', 0, filesToBundle.length);
        const today = new Date().toISOString().split('T')[0];
        const zipFilename = `ChatGPT_Export_${today}.zip`;
        await createZipBundle(filesToBundle, zipFilename, folder);
        results.push({ type: 'zip', filename: zipFilename, fileCount: filesToBundle.length });
        updateExportState('complete', filesToBundle.length, filesToBundle.length);
        return results;
    }

    for (const file of filesToBundle) {
        await downloadFile(file.filename, file.content, file.mimeType, folder);
        results.push({ type: file.mimeType.includes('markdown') ? 'markdown' : 'json', filename: file.filename });
    }

    updateExportState('complete', filesToBundle.length, filesToBundle.length);
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

/**
 * Get multiple conversations with rate limiting, retry logic, and batch pauses
 */
async function getConversations(conversationIds, onProgress = null) {
    const conversations = [];
    let consecutiveErrors = 0;
    const totalCount = conversationIds.length;
    const startTime = Date.now();

    console.log(`[BG] Starting to fetch ${totalCount} conversations...`);

    for (let i = 0; i < conversationIds.length; i++) {
        // Check for cancellation
        checkCancellation();

        const conversationNum = i + 1;
        let conversation = null;
        let lastError = null;

        // Every 100 conversations, take a longer break (2-4 minutes)
        if (i > 0 && i % 100 === 0) {
            const pauseMinutes = randomDelay(2 * 60 * 1000, 4 * 60 * 1000);
            const pauseMinutesDisplay = (pauseMinutes / 60000).toFixed(1);
            console.log(`[BG] === BATCH PAUSE === Completed ${i}/${totalCount} conversations. Taking a ${pauseMinutesDisplay} minute break to avoid rate limiting...`);
            await sleep(pauseMinutes);
            console.log(`[BG] === RESUMING === Continuing with conversation ${conversationNum}/${totalCount}...`);
        }

        // Retry logic with exponential backoff
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                console.log(`[BG] Fetching conversation ${conversationNum}/${totalCount}: ${conversationIds[i]}${attempt > 0 ? ` (retry ${attempt})` : ''}`);
                conversation = await getConversation(conversationIds[i]);

                if (conversation.error) {
                    lastError = conversation.error;
                    conversation = null;

                    // Wait with backoff before retry
                    const backoffTime = RETRY_BACKOFF * (attempt + 1);
                    console.warn(`[BG] ⚠️ Attempt ${attempt + 1}/${MAX_RETRIES} failed for conversation ${conversationIds[i]}: ${lastError}`);
                    console.log(`[BG] Waiting ${backoffTime / 1000}s before retry...`);
                    await sleep(backoffTime);
                    continue;
                }

                // Success - reset consecutive error counter
                consecutiveErrors = 0;
                break;
            } catch (error) {
                lastError = error.message || String(error);
                const backoffTime = RETRY_BACKOFF * (attempt + 1);
                console.warn(`[BG] ⚠️ Attempt ${attempt + 1}/${MAX_RETRIES} threw exception: ${lastError}`);
                console.log(`[BG] Waiting ${backoffTime / 1000}s before retry...`);
                await sleep(backoffTime);
            }
        }

        if (!conversation) {
            console.error(`[BG] ❌ FAILED to fetch conversation ${conversationIds[i]} after ${MAX_RETRIES} attempts. Last error: ${lastError}`);
            consecutiveErrors++;

            // If we get 5 consecutive errors, something is seriously wrong - abort
            if (consecutiveErrors >= 5) {
                const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
                console.error(`[BG] ❌ ABORTING: ${consecutiveErrors} consecutive failures. Fetched ${conversations.length}/${totalCount} in ${elapsed} minutes.`);
                throw new Error(`Export aborted after ${consecutiveErrors} consecutive failures. Fetched ${conversations.length} conversations. Try again later.`);
            }
            continue;
        }

        conversations.push(conversation);

        if (onProgress) {
            onProgress(conversationNum, totalCount);
        }

        // Random delay between 2-4 seconds before next request
        if (i < conversationIds.length - 1) {
            const delay = randomDelay(2000, 4000);
            await sleep(delay);
        }

        // Log progress every 25 conversations
        if (conversationNum % 25 === 0) {
            const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
            const rate = (conversationNum / (Date.now() - startTime) * 60000).toFixed(1);
            console.log(`[BG] 📊 Progress: ${conversationNum}/${totalCount} (${elapsed} min elapsed, ~${rate} convos/min)`);
        }
    }

    const totalElapsed = ((Date.now() - startTime) / 60000).toFixed(1);
    console.log(`[BG] ✅ Completed fetching ${conversations.length}/${totalCount} conversations in ${totalElapsed} minutes`);

    return conversations;
}

/**
 * Offscreen document helpers.
 *
 * Chrome's download system rejects data: URLs larger than ~2MB - the download
 * fails with NETWORK_FAILED ("Check internet connection" in the UI). MV3
 * service workers can't call URL.createObjectURL, so we delegate Blob URL
 * creation to an offscreen document. This makes downloads work regardless
 * of file size (fixes long conversations failing in "Export Current Chat").
 */
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

// Track blob URLs per download so we can revoke them when the download settles
const pendingBlobUrls = new Map();

chrome.downloads.onChanged.addListener((delta) => {
    if (!delta.state || !pendingBlobUrls.has(delta.id)) {
        return;
    }
    const state = delta.state.current;
    if (state === 'complete' || state === 'interrupted') {
        const url = pendingBlobUrls.get(delta.id);
        pendingBlobUrls.delete(delta.id);
        chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'revoke-blob-url',
            url
        }).catch(() => {
            // Offscreen document may already be gone - nothing to revoke then
        });
    }
});

/**
 * Start a download from a blob: URL and register cleanup.
 */
async function downloadBlobUrl(blobUrl, fullPath) {
    const downloadId = await chrome.downloads.download({
        url: blobUrl,
        filename: fullPath,
        saveAs: false,
        conflictAction: 'uniquify'
    });
    pendingBlobUrls.set(downloadId, blobUrl);
    return downloadId;
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

        console.log(`[BG] Download initiated: ${fullPath} (ID: ${downloadId})`);

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

    // Dynamically load JSZip
    const JSZip = await loadJSZip();
    const zip = new JSZip();

    for (const file of files) {
        zip.file(file.filename, file.content);
    }

    // Generate ZIP as base64
    const zipContent = await zip.generateAsync({
        type: 'base64',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
    });

    let fullPath = zipFilename;
    if (folder) {
        folder = folder.replace(/^[/\\]+|[/\\]+$/g, '');
        fullPath = `${folder}/${zipFilename}`;
    }

    try {
        // Blob URL via offscreen document (data: URLs fail for large ZIPs)
        const blobUrl = await createBlobUrl(zipContent, 'application/zip', true);
        const downloadId = await downloadBlobUrl(blobUrl, fullPath);

        console.log(`[BG] ZIP download initiated: ${fullPath} (ID: ${downloadId})`);

        return downloadId;
    } catch (error) {
        console.error(`[BG] ZIP download failed:`, error);
        throw error;
    }
}

/**
 * Check connection by pinging content script
 */
async function checkConnection() {
    try {
        console.log('[BG] checkConnection starting...');
        const response = await sendToContentScript({ action: 'ping' });
        console.log('[BG] checkConnection response:', response);
        const connected = response && response.success;
        console.log('[BG] checkConnection result:', connected);
        return connected;
    } catch (e) {
        console.log('[BG] Connection check failed:', e.message);
        return false;
    }
}

/**
 * Export all conversations
 */
async function exportAll(formats, onProgress, folder = '', limit = 0) {
    // Clear cached tab at start of new export to get a fresh, valid tab
    clearCachedTab();

    // Track export state
    exportState.isRunning = true;
    exportState.cancelRequested = false;
    exportState.startTime = Date.now();

    const reportProgress = (phase, current, total) => {
        updateExportState(phase, current, total);
        onProgress({ phase, current, total });
    };

    try {
        reportProgress('fetching_list', 0, 0);

        // Pass limit to avoid fetching more metadata than needed
        const allMeta = await getAllConversationsMeta((current, total) => {
            reportProgress('fetching_list', current, total);
        }, limit);

        let toExport = allMeta;
        if (limit > 0 && limit < allMeta.length) {
            toExport = allMeta.slice(0, limit);
        }

        reportProgress('fetching_conversations', 0, toExport.length);

        // Build lookup map for project metadata before fetching full conversations
        const projectLookup = new Map();
        for (const meta of toExport) {
            if (meta._projectId) {
                projectLookup.set(meta.id, {
                    _projectId: meta._projectId,
                    _projectName: meta._projectName
                });
            }
        }

        const conversationIds = toExport.map(c => c.id);
        const fullConversations = await getConversations(conversationIds, (current, total) => {
            reportProgress('fetching_conversations', current, total);
        });

        // Merge project metadata into full conversations
        for (const conv of fullConversations) {
            const projectInfo = projectLookup.get(conv.conversation_id || conv.id);
            if (projectInfo) {
                conv._projectId = projectInfo._projectId;
                conv._projectName = projectInfo._projectName;
            }
        }

        reportProgress('exporting', 0, fullConversations.length);

        const filesToBundle = await buildExportFiles(fullConversations, formats, reportProgress);
        const results = await downloadExportFiles(filesToBundle, folder);

        await markConversationsAsExported(fullConversations);

        return {
            totalExported: fullConversations.length,
            results
        };
    } finally {
        exportState.isRunning = false;
        exportState.phase = null;
    }
}

/**
 * Export only new or updated conversations
 */
async function exportNewUpdated(formats, onProgress, folder = '', limit = 0) {
    // Clear cached tab at start of new export to get a fresh, valid tab
    clearCachedTab();

    // Track export state
    exportState.isRunning = true;
    exportState.cancelRequested = false;
    exportState.startTime = Date.now();

    const reportProgress = (phase, current, total) => {
        updateExportState(phase, current, total);
        onProgress({ phase, current, total });
    };

    try {
        reportProgress('fetching_list', 0, 0);

        // Determine fetch limit based on export history
        // If user has never exported, all conversations need export - no buffer needed
        // If user has history, some will be filtered out - use buffer
        let fetchLimit = 0;
        if (limit > 0) {
            const stats = await getStats();
            if (stats.totalExported === 0) {
                // First time export - no filtering will occur, use limit directly
                fetchLimit = limit;
            } else {
                // Has history - some will be filtered, use 3x buffer
                fetchLimit = Math.max(limit * 3, limit + 100);
            }
        }

        const allMeta = await getAllConversationsMeta((current, total) => {
            reportProgress('fetching_list', current, total);
        }, fetchLimit);

        let needExport = await filterNeedingExport(allMeta);

        if (needExport.length === 0) {
            return {
                totalExported: 0,
                message: 'All conversations are already up to date!',
                results: []
            };
        }

        if (limit > 0 && limit < needExport.length) {
            needExport = needExport.slice(0, limit);
        }

        reportProgress('fetching_conversations', 0, needExport.length);

        // Build lookup map for project metadata before fetching full conversations
        const projectLookup = new Map();
        for (const meta of needExport) {
            if (meta._projectId) {
                projectLookup.set(meta.id, {
                    _projectId: meta._projectId,
                    _projectName: meta._projectName
                });
            }
        }

        const conversationIds = needExport.map(c => c.id);
        const fullConversations = await getConversations(conversationIds, (current, total) => {
            reportProgress('fetching_conversations', current, total);
        });

        // Merge project metadata into full conversations
        for (const conv of fullConversations) {
            const projectInfo = projectLookup.get(conv.conversation_id || conv.id);
            if (projectInfo) {
                conv._projectId = projectInfo._projectId;
                conv._projectName = projectInfo._projectName;
            }
        }

        reportProgress('exporting', 0, fullConversations.length);

        const filesToBundle = await buildExportFiles(fullConversations, formats, reportProgress);
        const results = await downloadExportFiles(filesToBundle, folder);

        await markConversationsAsExported(fullConversations);

        return {
            totalExported: fullConversations.length,
            results
        };
    } finally {
        exportState.isRunning = false;
        exportState.phase = null;
    }
}

/**
 * Export only the currently active conversation tab
 */
async function exportCurrentConversation(formats, onProgress, folder = '') {
    clearCachedTab();

    exportState.isRunning = true;
    exportState.cancelRequested = false;
    exportState.startTime = Date.now();

    const reportProgress = (phase, current, total) => {
        updateExportState(phase, current, total);
        onProgress({ phase, current, total });
    };

    try {
        reportProgress('fetching_conversations', 0, 1);

        const target = await getCurrentConversationTarget();
        const conversation = await sendToTab(target.tab, {
            action: 'getConversation',
            id: target.conversationId
        });

        if (conversation.error) {
            throw new Error(conversation.error);
        }

        if (target.projectId) {
            conversation._projectId = target.projectId;
            conversation._projectName = await getProjectNameForCurrentConversation(target.tab, target.projectId);
        }

        reportProgress('fetching_conversations', 1, 1);
        reportProgress('exporting', 0, 1);

        const fullConversations = [conversation];
        const filesToBundle = await buildExportFiles(fullConversations, formats, reportProgress);
        const results = await downloadExportFiles(filesToBundle, folder);

        await markConversationsAsExported(fullConversations);

        return {
            totalExported: 1,
            results
        };
    } finally {
        exportState.isRunning = false;
        exportState.phase = null;
    }
}

/**
 * Handle messages from popup
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handleAsync = async () => {
        try {
            switch (message.action) {
                case 'checkConnection':
                    return { connected: await checkConnection() };

                case 'getStats':
                    return await getStats();

                case 'getExportState':
                    return getExportState();

                case 'getCurrentConversationTarget': {
                    const target = await getCurrentConversationTarget();
                    return {
                        available: true,
                        conversationId: target.conversationId,
                        projectId: target.projectId
                    };
                }

                case 'exportAll':
                    return await exportAll(
                        message.formats,
                        (progress) => chrome.runtime.sendMessage({ type: 'progress', ...progress }),
                        message.downloadFolder || '',
                        message.limit || 0
                    );

                case 'exportNewUpdated':
                    return await exportNewUpdated(
                        message.formats,
                        (progress) => chrome.runtime.sendMessage({ type: 'progress', ...progress }),
                        message.downloadFolder || '',
                        message.limit || 0
                    );

                case 'exportCurrentConversation':
                    return await exportCurrentConversation(
                        message.formats,
                        (progress) => chrome.runtime.sendMessage({ type: 'progress', ...progress }),
                        message.downloadFolder || ''
                    );

                case 'clearHistory':
                    await clearHistory();
                    return { success: true };

                case 'cancelExport':
                    return cancelExport();

                default:
                    throw new Error(`Unknown action: ${message.action}`);
            }
        } catch (error) {
            console.error('[BG] Error:', error);
            return { error: error.message };
        }
    };

    handleAsync().then(sendResponse);
    return true;
});

console.log('GPT Exporter background service worker loaded');
