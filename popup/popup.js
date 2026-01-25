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
const formatJson = document.getElementById('formatJson');
const btnExportNew = document.getElementById('btnExportNew');
const btnExportAll = document.getElementById('btnExportAll');
const btnClearHistory = document.getElementById('btnClearHistory');
const btnClearLog = document.getElementById('btnClearLog');
const btnPopout = document.getElementById('btnPopout');
const progressSection = document.getElementById('progressSection');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const logOutput = document.getElementById('logOutput');

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
function log(message, type = 'info') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    const time = new Date().toLocaleTimeString();
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
    log('Settings loaded');
}

/**
 * Save settings to storage
 */
async function saveSettings() {
    const settings = {
        downloadFolder: downloadFolder.value.trim(),
        exportLimit: parseInt(exportLimit.value) || 0
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
        btnExportNew.disabled = false;
        btnExportAll.disabled = false;
        log('Connected to ChatGPT', 'success');
    } else {
        connectionStatus.classList.add('disconnected');
        connectionStatus.querySelector('.status-text').textContent = 'Not logged in';
        btnExportNew.disabled = true;
        btnExportAll.disabled = true;
        log('Not connected - please log in to chatgpt.com', 'error');
    }
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
            json: formatJson.checked
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
            percent = 25 + (current / total) * 45;
            break;
        case 'exporting':
            phaseText = `Preparing files... ${current}/${total}`;
            percent = 70 + (current / total) * 15;
            break;
        case 'zipping':
            phaseText = `Creating ZIP archive... ${total} files`;
            percent = 90;
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
    btnExportAll.disabled = true;

    try {
        const action = exportType === 'all' ? 'exportAll' : 'exportNewUpdated';
        log(`Calling action: ${action}`);

        const result = await sendMessage({
            action,
            formats: options.formats,
            downloadFolder: options.downloadFolder,
            limit: options.limit
        });

        log(`Result: ${JSON.stringify(result)}`, result?.error ? 'error' : 'info');

        if (result?.error) {
            throw new Error(result.error);
        }

        if (result?.totalExported === 0) {
            showComplete(result.message || 'Nothing to export!');
        } else if (result?.totalExported > 0) {
            showComplete(`✓ Exported ${result.totalExported} conversation(s)`);
        } else {
            log('Unexpected result format', 'error');
        }
    } catch (error) {
        console.error('Export error:', error);
        log(`Export failed: ${error.message}`, 'error');
        hideProgress();
        alert(`Export failed: ${error.message}`);
    } finally {
        btnExportNew.disabled = false;
        btnExportAll.disabled = false;
    }
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

// Listen for progress updates from background
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'progress') {
        showProgress(message.phase, message.current, message.total);
        log(`Progress: ${message.phase} ${message.current}/${message.total}`);
    }
});

// Auto-save settings on change
downloadFolder.addEventListener('change', saveSettings);
exportLimit.addEventListener('change', saveSettings);

// Event listeners
btnExportNew.addEventListener('click', () => handleExport('new'));
btnExportAll.addEventListener('click', () => handleExport('all'));
btnClearHistory.addEventListener('click', handleClearHistory);
btnClearLog.addEventListener('click', clearLog);
if (btnPopout) {
    btnPopout.addEventListener('click', handlePopout);
}

/**
 * Check if an export is currently running and show progress
 */
async function checkExportState() {
    const state = await sendMessage({ action: 'getExportState' });

    if (state && state.isRunning && state.phase) {
        log(`Export in progress: ${state.phase} ${state.current}/${state.total}`);
        showProgress(state.phase, state.current, state.total);

        // Disable buttons while export is running
        btnExportNew.disabled = true;
        btnExportAll.disabled = true;
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    log('GPT Exporter popup initialized');
    await loadSettings();
    await updateConnectionStatus();
    await updateStats();
    await checkExportState(); // Check if export is already running
});
