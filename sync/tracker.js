/**
 * Sync Tracker Module
 * Tracks which conversations have been exported and when
 */

const STORAGE_KEY = 'gpt_exporter_sync_data';

/**
 * Get all sync data from storage
 */
async function getSyncData() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return result[STORAGE_KEY] || {
        exportedConversations: {},
        lastSyncTime: null
    };
}

/**
 * Save sync data to storage
 */
async function saveSyncData(data) {
    await chrome.storage.local.set({ [STORAGE_KEY]: data });
}

/**
 * Mark a conversation as exported
 * @param {string} conversationId 
 * @param {string} updateTime - The update_time from the conversation
 */
async function markExported(conversationId, updateTime) {
    const data = await getSyncData();
    data.exportedConversations[conversationId] = {
        exportedAt: new Date().toISOString(),
        updateTime: updateTime
    };
    data.lastSyncTime = new Date().toISOString();
    await saveSyncData(data);
}

/**
 * Mark multiple conversations as exported
 * @param {Array} conversations - Array of {id, updateTime} objects
 */
async function markMultipleExported(conversations) {
    const data = await getSyncData();
    const now = new Date().toISOString();

    for (const conv of conversations) {
        data.exportedConversations[conv.id] = {
            exportedAt: now,
            updateTime: conv.updateTime
        };
    }

    data.lastSyncTime = now;
    await saveSyncData(data);
}

/**
 * Check if a conversation needs to be exported
 * (either never exported or updated since last export)
 * @param {string} conversationId 
 * @param {string} currentUpdateTime 
 */
async function needsExport(conversationId, currentUpdateTime) {
    const data = await getSyncData();
    const exported = data.exportedConversations[conversationId];

    if (!exported) {
        return true; // Never exported
    }

    // Check if updated since last export
    const exportedUpdateTime = new Date(exported.updateTime).getTime();
    const currentTime = new Date(currentUpdateTime).getTime();

    return currentTime > exportedUpdateTime;
}

/**
 * Filter conversations to only those needing export
 * @param {Array} conversations - Array of conversation metadata
 */
async function filterNeedingExport(conversations) {
    const data = await getSyncData();
    const needExport = [];

    for (const conv of conversations) {
        const id = conv.id;
        const updateTime = conv.update_time;
        const exported = data.exportedConversations[id];

        if (!exported) {
            needExport.push(conv);
        } else {
            // Check if updated since last export
            const exportedUpdateTime = new Date(exported.updateTime).getTime();
            const currentTime = typeof updateTime === 'number'
                ? updateTime * 1000
                : new Date(updateTime).getTime();

            if (currentTime > exportedUpdateTime) {
                needExport.push(conv);
            }
        }
    }

    return needExport;
}

/**
 * Get sync statistics
 */
async function getStats() {
    const data = await getSyncData();
    return {
        totalExported: Object.keys(data.exportedConversations).length,
        lastSyncTime: data.lastSyncTime
    };
}

/**
 * Clear all sync history
 */
async function clearHistory() {
    await saveSyncData({
        exportedConversations: {},
        lastSyncTime: null
    });
}

export {
    getSyncData,
    markExported,
    markMultipleExported,
    needsExport,
    filterNeedingExport,
    getStats,
    clearHistory
};
