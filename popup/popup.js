/**
 * Popup Script
 * Handles UI interactions and communicates with background worker
 */

// DOM Elements
const connectionStatus = document.getElementById('connectionStatus');
const exportedCount = document.getElementById('exportedCount');
const lastSync = document.getElementById('lastSync');
const downloadFolder = document.getElementById('downloadFolder');
const exportLimit = document.getElementById('exportLimit');
const formatMarkdown = document.getElementById('formatMarkdown');
const includeAboveBranchedFrom = document.getElementById('includeAboveBranchedFrom');
const formatJson = document.getElementById('formatJson');
const btnExportNew = document.getElementById('btnExportNew');
const btnExportCurrent = document.getElementById('btnExportCurrent');
const btnExportAll = document.getElementById('btnExportAll');
const btnCancelProcess = document.getElementById('btnCancelProcess');
const btnClearHistory = document.getElementById('btnClearHistory');
const btnClearLog = document.getElementById('btnClearLog');
const btnPopout = document.getElementById('btnPopout');
const progressSection = document.getElementById('progressSection');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const logOutput = document.getElementById('logOutput');

const jobStatus = document.getElementById('jobStatus');
const jobStatusTitle = document.getElementById('jobStatusTitle');
const jobCounts = document.getElementById('jobCounts');
const jobMessage = document.getElementById('jobMessage');
const jobRetryTime = document.getElementById('jobRetryTime');
const btnResume = document.getElementById('btnResume');
const btnDiscard = document.getElementById('btnDiscard');
let lastJobState = null;
let lastLogKey = '';
const loggedEvents = new Set();

function renderJobState(state) {
    const previousStatus = lastJobState?.status;
    lastJobState = state;
    const unfinished = state.phase && state.status !== 'complete';
    jobStatus.classList.toggle('hidden', !state.phase);
    jobStatus.dataset.status = state.status || '';
    for (const event of state.events || []) {
        if (!loggedEvents.has(event.id)) {
            log(event.message, event.type, event.at);
            loggedEvents.add(event.id);
        }
    }
    const titles = {
        running: 'Export in progress', cooldown: 'ChatGPT rate limit: export cooling down',
        waiting: 'Export waiting to continue', paused: 'Export paused: action required', complete: 'Export complete'
    };
    jobStatusTitle.textContent = titles[state.status] || 'Export in progress';
    jobCounts.textContent = `${state.fetched || 0} fetched · ${state.pending || 0} pending · ${state.saved || 0} saved · ${state.failed || 0} blocking errors`;
    jobMessage.textContent = state.error || (state.status === 'complete' ? 'All requested files finished saving.' : 'Successful fetches are saved automatically.');
    const retryAt = state.status === 'cooldown' || state.status === 'waiting' ? state.resumeAt : state.cooldownUntil;
    const seconds = Math.max(0, Math.ceil(((retryAt || 0) - Date.now()) / 1000));
    jobRetryTime.textContent = retryAt && seconds > 0
        ? `${state.status === 'paused' ? 'Resume no earlier than' : 'Continues at or after'} ${new Date(retryAt).toLocaleTimeString()} (${seconds}s remaining)`
        : state.isRunning && state.status !== 'running' ? 'Waiting for Chrome to resume the job.' : '';
    btnResume.classList.toggle('hidden', !state.canResume);
    btnDiscard.classList.toggle('hidden', !state.canDiscard || state.isRunning);
    btnCancelProcess.disabled = !state.isRunning;
    if (unfinished) {
        btnExportNew.disabled = btnExportAll.disabled = btnExportCurrent.disabled = true;
    } else if (connectionStatus.classList.contains('connected')) {
        btnExportNew.disabled = btnExportAll.disabled = false;
        // The availability check additionally validates the focused chat tab.
        if (state.status === 'complete' && previousStatus !== 'complete') {
            updateStats();
            updateCurrentConversationAvailability();
        }
    }
    if (state.phase && !['paused', 'cooldown', 'waiting'].includes(state.phase)) {
        showProgress(state.phase, state.current || 0, state.total || 0);
    } else hideProgress();
    const logKey = `${state.status}:${state.phase}:${state.error || ''}:${state.retryLevel || 0}:${Math.floor((state.fetched || 0) / 25)}`;
    if (state.phase && logKey !== lastLogKey) {
        const retry = state.resumeAt ? ` ${state.status === 'paused' ? 'Resume no earlier than' : 'Next attempt at or after'} ${new Date(state.resumeAt).toLocaleTimeString()}.` : '';
        log(`${jobStatusTitle.textContent}. ${jobCounts.textContent}. ${state.error || ''}${retry}`,
            state.status === 'paused' ? 'error' : state.status === 'cooldown' ? 'warning' : 'info');
        lastLogKey = logKey;
    }
}

/**
 * Check if running in a popup or a window
 */
function isPopup() {
    return window.innerWidth < 400;
}

/**
 * Open this popup as a detached window
 */
function handlePopout() {
    chrome.windows.create({
        url: chrome.runtime.getURL('popup/popup.html'),
        type: 'popup',
        width: 420,
        height: 650,
        focused: true
    });
    // Close the popup
    window.close();
}

const SETTINGS_KEY = 'gpt_exporter_settings';

/**
 * Add entry to visible log
 */
function log(message, type = 'info', at = Date.now()) {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const time = new Date(at).toLocaleTimeString();
    entry.textContent = `[${time}] ${message}`;
    logOutput.appendChild(entry);
    logOutput.scrollTop = logOutput.scrollHeight;
    console.log(`[GPT Exporter] ${message}`);
}

/**
 * Clear log
 */
function clearLog() {
    logOutput.innerHTML = '';
}

/**
 * Send message to background script with logging
 */
async function sendMessage(message) {
    log(`Sending: ${message.action}`, 'info');
    try {
        const response = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(message, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve(response);
                }
            });
        });

        if (response === undefined) {
            log(`Response undefined - service worker may not be running`, 'error');
            return { error: 'No response from background script' };
        }

        if (response.error) {
            log(`Error: ${response.error}`, 'error');
        } else {
            log(`Response received for ${message.action}`, 'success');
        }

        return response;
    } catch (error) {
        log(`Send failed: ${error.message}`, 'error');
        return { error: error.message };
    }
}

/**
 * Load settings from storage
 */
async function loadSettings() {
    const result = await chrome.storage.local.get(SETTINGS_KEY);
    const settings = result[SETTINGS_KEY] || {};

    downloadFolder.value = settings.downloadFolder || '';
    exportLimit.value = settings.exportLimit || '';
    // Default unchecked: exports omit content above the "Branched from"
    // divider unless the user opts back in.
    includeAboveBranchedFrom.checked = settings.includeAboveBranchedFrom || false;
    log('Settings loaded');
}

/**
 * Save settings to storage
 */
async function saveSettings() {
    const settings = {
        downloadFolder: downloadFolder.value.trim(),
        exportLimit: parseInt(exportLimit.value) || 0,
        includeAboveBranchedFrom: includeAboveBranchedFrom.checked
    };
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    log('Settings saved');
    return settings;
}

/**
 * Format relative time
 */
function formatRelativeTime(dateString) {
    if (!dateString) return 'Never';

    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
}

/**
 * Update connection status display
 */
async function updateConnectionStatus() {
    log('Checking connection...');
    const result = await sendMessage({ action: 'checkConnection' });

    connectionStatus.classList.remove('connected', 'disconnected');

    if (result && result.connected) {
        connectionStatus.classList.add('connected');
        connectionStatus.querySelector('.status-text').textContent = 'Connected';
        connectionStatus.title = 'Connected to the ChatGPT tab';
        btnExportNew.disabled = false;
        btnExportAll.disabled = false;
        btnExportCurrent.disabled = false;
        log('Connected to ChatGPT', 'success');
    } else {
        const reason = result?.error || 'The extension could not connect to the ChatGPT tab. Reload the tab and try again.';
        connectionStatus.classList.add('disconnected');
        connectionStatus.querySelector('.status-text').textContent = 'Connection unavailable';
        connectionStatus.title = reason;
        btnExportNew.disabled = true;
        btnExportAll.disabled = true;
        btnExportCurrent.disabled = true;
        log(`Connection unavailable: ${reason}`, 'error');
    }
}

/**
 * Enable current-chat export only when the active tab is a concrete conversation
 */
async function updateCurrentConversationAvailability() {
    if (lastJobState?.phase && lastJobState.status !== 'complete') {
        btnExportCurrent.disabled = true;
        return;
    }
    if (!connectionStatus.classList.contains('connected')) {
        btnExportCurrent.disabled = true;
        btnExportCurrent.title = 'Connect to a ChatGPT tab first';
        return;
    }

    const result = await sendMessage({ action: 'getCurrentConversationTarget' });
    const isAvailable = !!(result && result.available && result.conversationId);

    btnExportCurrent.disabled = !isAvailable;
    btnExportCurrent.title = isAvailable
        ? 'Export only the active ChatGPT conversation tab'
        : (result?.error || 'Open the ChatGPT conversation you want to export');
}

/**
 * Update stats display
 */
async function updateStats() {
    const stats = await sendMessage({ action: 'getStats' });

    if (stats && !stats.error) {
        exportedCount.textContent = stats.totalExported || 0;
        lastSync.textContent = formatRelativeTime(stats.lastSyncTime);
    }
}

/**
 * Get selected formats and settings
 */
function getExportOptions() {
    return {
        formats: {
            markdown: formatMarkdown.checked,
            json: formatJson.checked,
            includeAboveBranchedFrom: includeAboveBranchedFrom.checked
        },
        downloadFolder: downloadFolder.value.trim(),
        limit: parseInt(exportLimit.value) || 0
    };
}

/**
 * Show progress UI
 */
function showProgress(phase, current, total) {
    progressSection.classList.remove('hidden');

    let phaseText = '';
    let percent = 0;

    switch (phase) {
        case 'fetching_list':
            phaseText = `Fetching conversation list... ${current}/${total || '?'}`;
            percent = total ? (current / total) * 25 : 10;
            break;
        case 'fetching_conversations':
            phaseText = `Downloading conversations... ${current}/${total}`;
            percent = 25 + (total ? current / total : 0) * 45;
            break;
        case 'exporting':
            phaseText = `Preparing files... ${current}/${total}`;
            percent = 70 + (total ? current / total : 0) * 15;
            break;
        case 'zipping':
            phaseText = `Creating ZIP archive... ${total} files`;
            percent = 90;
            break;
        case 'complete':
            phaseText = `Export complete! ${total} files`;
            percent = 100;
            break;
        case 'saving':
            phaseText = 'Saving export... waiting for Chrome to finish';
            percent = 95;
            break;
        default:
            phaseText = 'Processing...';
            percent = 50;
    }

    progressFill.style.width = `${Math.min(percent, 100)}%`;
    progressText.textContent = phaseText;
}

/**
 * Hide progress UI
 */
function hideProgress() {
    progressSection.classList.add('hidden');
    progressFill.style.width = '0%';
}

/**
 * Show completion message
 */
function showComplete(message) {
    progressSection.classList.remove('hidden');
    progressFill.style.width = '100%';
    progressText.textContent = message;
    log(message, 'success');

    setTimeout(() => {
        hideProgress();
        updateStats();
    }, 3000);
}

/**
 * Handle export button click
 */
async function handleExport(exportType) {
    const options = getExportOptions();
    log(`Starting export: ${exportType}, limit: ${options.limit}, folder: ${options.downloadFolder || '(default)'}`);

    if (!options.formats.markdown && !options.formats.json) {
        alert('Please select at least one export format.');
        return;
    }

    // Save settings before export
    await saveSettings();

    btnExportNew.disabled = true;
    btnExportCurrent.disabled = true;
    btnExportAll.disabled = true;

    try {
        const actionMap = {
            all: 'exportAll',
            new: 'exportNewUpdated',
            current: 'exportCurrentConversation'
        };
        const action = actionMap[exportType];
        log(`Calling action: ${action}`);

        const result = await sendMessage({
            action,
            formats: options.formats,
            downloadFolder: options.downloadFolder,
            limit: options.limit
        });

        if (result?.error) log(result.error, 'error');
        if (result?.totalExported !== undefined) {
            log(`Exported ${result.totalExported} conversation(s)`, 'success');
            await updateStats();
        }
    } catch (error) {
        log(`Export failed: ${error.message}`, 'error');
    } finally {
        await checkExportState();
    }
}

/**
 * Handle cancel current process
 */
async function handleCancelProcess() {
    const result = await sendMessage({ action: 'cancelExport' });
    if (result?.error) log(result.error, 'error');
    await checkExportState();
}

async function handleResume() {
    btnResume.disabled = true;
    try {
        const result = await sendMessage({ action: 'resumeExport' });
        if (result?.error) log(result.error, 'error');
    } finally {
        btnResume.disabled = false;
        await checkExportState();
    }
}

async function handleDiscard() {
    if (!confirm('Discard this unfinished job and its saved fetches? Downloaded files and export history are kept.')) return;
    const result = await sendMessage({ action: 'discardExport' });
    if (!result?.error) {
        lastLogKey = '';
        await updateConnectionStatus();
        await updateCurrentConversationAvailability();
    }
    await checkExportState();
}

/**
 * Handle clear history
 */
async function handleClearHistory() {
    if (!confirm('Clear all export history? This will not delete any downloaded files.')) {
        return;
    }

    await sendMessage({ action: 'clearHistory' });
    log('Export history cleared');
    await updateStats();
}

// Warnings and failures are surfaced here even when the initial export call
// has already returned. The saved job is the source of truth after reopening.
chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'progress') renderJobState(message);
});

btnResume.addEventListener('click', handleResume);
btnDiscard.addEventListener('click', handleDiscard);

// Auto-save settings on change
downloadFolder.addEventListener('change', saveSettings);
exportLimit.addEventListener('change', saveSettings);
includeAboveBranchedFrom.addEventListener('change', saveSettings);

// Event listeners
btnExportNew.addEventListener('click', () => handleExport('new'));
btnExportCurrent.addEventListener('click', () => handleExport('current'));
btnExportAll.addEventListener('click', () => handleExport('all'));
btnCancelProcess.addEventListener('click', handleCancelProcess);
btnClearHistory.addEventListener('click', handleClearHistory);
btnClearLog.addEventListener('click', clearLog);
if (btnPopout) {
    btnPopout.addEventListener('click', handlePopout);
}

/**
 * Check if an export is currently running and show progress
 */
async function checkExportState() {
    try {
        const state = await chrome.runtime.sendMessage({ action: 'getExportState' });
        if (state && (state.status || !state.error)) renderJobState(state);
        else if (state?.error && !state.status) log(`Cannot read export status: ${state.error}`, 'error');
    } catch (error) { log(`Cannot read export status: ${error.message}`, 'error'); }
}

// Keep countdowns and completion current without flooding the visible log.
setInterval(() => {
    if (lastJobState?.isRunning) checkExportState();
    else if (lastJobState?.phase) renderJobState(lastJobState);
}, 1000);

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    log('GPT Exporter popup initialized');
    await loadSettings();
    await updateConnectionStatus();
    await updateCurrentConversationAvailability();
    await updateStats();
    await checkExportState(); // Check if export is already running
});
