/**
 * JSON Export Module
 * Exports all conversations as a single JSON backup file
 */

/**
 * Create a backup JSON file containing all conversations
 * @param {Array} conversations - Array of full conversation objects
 */
function createBackupJson(conversations) {
    const backup = {
        exported_at: new Date().toISOString(),
        total_conversations: conversations.length,
        conversations: conversations
    };

    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `chatgpt_backup_${dateStr}.json`;

    return {
        filename: filename,
        content: JSON.stringify(backup, null, 2)
    };
}

export {
    createBackupJson
};
