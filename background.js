/**
 * Background Service Worker
 * Handles extension messaging, API calls via content script, and downloads
 */

import { conversationToMarkdown } from './export/markdown.js';
import { createBackupJson } from './export/json.js';
import { filterNeedingExport, markMultipleExported, getStats, clearHistory } from './sync/tracker.js';
import { loadJSZip } from './lib/jszip-loader.js';

const RATE_LIMIT_DELAY = 4000; // 4 seconds between requests (avoid rate limiting)
const ZIP_THRESHOLD = 3; // Bundle into ZIP if more than this many files
const MAX_RETRIES = 3; // Retry failed requests
const RETRY_BACKOFF = 10000; // 10 seconds base backoff on retry

// Track pending download filenames (Chrome doesn't properly handle filenames for data URLs)
const pendingDownloadFilenames = new Map();

// Export state tracking - allows popup to query current progress
let exportState = {
    isRunning: false,
    phase: null,
    current: 0,
    total: 0,
    startTime: null
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

// Listen for download filename determination to override it
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
    const intendedFilename = pendingDownloadFilenames.get(downloadItem.id);
    if (intendedFilename) {
        console.log(`[BG] Overriding filename for download ${downloadItem.id}: "${intendedFilename}"`);
        suggest({ filename: intendedFilename });
        pendingDownloadFilenames.delete(downloadItem.id);
    }
});

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
 * Send message to content script using cached tab
 */
async function sendToContentScript(message) {
    const tab = await getExportTab();

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
            // Clear the cached tab so we try a different one next time
            console.error(`[BG] Injection failed on tab ${tab.id}:`, injectError.message);
            cachedExportTab = null;
            throw new Error(`Failed to connect to ChatGPT tab. Please ensure you have a ChatGPT page open and try again.`);
        }
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

    // Convert content to base64 data URL
    // Handle large content by chunking to avoid call stack issues
    const encoder = new TextEncoder();
    const data = encoder.encode(content);

    // Convert Uint8Array to base64 in chunks to handle large files
    let base64 = '';
    const chunkSize = 32768; // 32KB chunks
    for (let i = 0; i < data.length; i += chunkSize) {
        const chunk = data.slice(i, i + chunkSize);
        base64 += btoa(String.fromCharCode.apply(null, chunk));
    }

    const dataUrl = `data:${mimeType};base64,${base64}`;
    console.log(`[BG] Data URL length: ${dataUrl.length}`);

    try {
        const downloadId = await chrome.downloads.download({
            url: dataUrl,
            filename: fullPath,
            saveAs: false,
            conflictAction: 'uniquify'
        });

        // Store the intended filename for the onDeterminingFilename handler
        pendingDownloadFilenames.set(downloadId, fullPath);
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

    const dataUrl = `data:application/zip;base64,${zipContent}`;

    try {
        const downloadId = await chrome.downloads.download({
            url: dataUrl,
            filename: fullPath,
            saveAs: false,
            conflictAction: 'uniquify'
        });

        pendingDownloadFilenames.set(downloadId, fullPath);
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

        const results = [];
        const filesToBundle = [];

        // Generate all file contents
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

        // Decide whether to ZIP or download individually
        if (filesToBundle.length > ZIP_THRESHOLD) {
            reportProgress('zipping', 0, filesToBundle.length);
            const today = new Date().toISOString().split('T')[0];
            const zipFilename = `ChatGPT_Export_${today}.zip`;
            await createZipBundle(filesToBundle, zipFilename, folder);
            results.push({ type: 'zip', filename: zipFilename, fileCount: filesToBundle.length });
            reportProgress('complete', filesToBundle.length, filesToBundle.length);
        } else {
            // Download files individually
            for (const file of filesToBundle) {
                await downloadFile(file.filename, file.content, file.mimeType, folder);
                results.push({ type: file.mimeType.includes('markdown') ? 'markdown' : 'json', filename: file.filename });
            }
            reportProgress('complete', filesToBundle.length, filesToBundle.length);
        }

        const exportedData = fullConversations.map(c => ({
            id: c.conversation_id || c.id,
            updateTime: c.update_time
                ? (typeof c.update_time === 'number'
                    ? new Date(c.update_time * 1000).toISOString()
                    : c.update_time)
                : new Date().toISOString()
        }));

        await markMultipleExported(exportedData);

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

        const results = [];
        const filesToBundle = [];

        // Generate all file contents
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

        // Decide whether to ZIP or download individually
        if (filesToBundle.length > ZIP_THRESHOLD) {
            reportProgress('zipping', 0, filesToBundle.length);
            const today = new Date().toISOString().split('T')[0];
            const zipFilename = `ChatGPT_Export_${today}.zip`;
            await createZipBundle(filesToBundle, zipFilename, folder);
            results.push({ type: 'zip', filename: zipFilename, fileCount: filesToBundle.length });
            reportProgress('complete', filesToBundle.length, filesToBundle.length);
        } else {
            // Download files individually
            for (const file of filesToBundle) {
                await downloadFile(file.filename, file.content, file.mimeType, folder);
                results.push({ type: file.mimeType.includes('markdown') ? 'markdown' : 'json', filename: file.filename });
            }
            reportProgress('complete', filesToBundle.length, filesToBundle.length);
        }

        const exportedData = fullConversations.map(c => ({
            id: c.conversation_id || c.id,
            updateTime: c.update_time
                ? (typeof c.update_time === 'number'
                    ? new Date(c.update_time * 1000).toISOString()
                    : c.update_time)
                : new Date().toISOString()
        }));

        await markMultipleExported(exportedData);

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

                case 'clearHistory':
                    await clearHistory();
                    return { success: true };

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
