/**
 * Parse a ChatGPT conversation URL.
 * Supports:
 * - https://chatgpt.com/c/{conversationId}
 * - https://chatgpt.com/g/{projectId}/c/{conversationId}
 * - https://chat.openai.com/c/{conversationId}
 * - https://chat.openai.com/g/{projectId}/c/{conversationId}
 *
 * @param {string} rawUrl
 * @returns {{conversationId: string, projectId: string|null}|null}
 */
function parseChatGPTConversationUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') {
        return null;
    }

    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        return null;
    }

    if (!['chatgpt.com', 'chat.openai.com'].includes(url.hostname)) {
        return null;
    }

    const parts = url.pathname.split('/').filter(Boolean);

    if (parts.length >= 2 && parts[0] === 'c' && parts[1]) {
        return {
            conversationId: parts[1],
            projectId: null
        };
    }

    if (parts.length >= 4 && parts[0] === 'g' && parts[1] && parts[2] === 'c' && parts[3]) {
        return {
            projectId: parts[1],
            conversationId: parts[3]
        };
    }

    return null;
}

export {
    parseChatGPTConversationUrl
};
