/**
 * ChatGPT API Module
 * Interacts with ChatGPT's backend API using session cookies
 */

const API_BASE = 'https://chatgpt.com/backend-api';
const RATE_LIMIT_DELAY = 2000; // 2 seconds between requests

/**
 * Sleep utility for rate limiting
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Make an authenticated request to ChatGPT API
 */
async function apiRequest(endpoint, options = {}) {
    const url = `${API_BASE}${endpoint}`;
    console.log(`[API] Requesting: ${url}`);

    try {
        const response = await fetch(url, {
            ...options,
            credentials: 'include', // Include session cookies
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            }
        });

        console.log(`[API] Response status: ${response.status} ${response.statusText}`);

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[API] Error response body:`, errorText);
            throw new Error(`API Error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        console.log(`[API] Response data keys:`, Object.keys(data));
        return data;
    } catch (error) {
        console.error(`[API] Request failed:`, error);
        throw error;
    }
}

/**
 * Get list of all conversations (paginated)
 * @param {number} offset - Starting offset
 * @param {number} limit - Number of items per page
 */
async function getConversationsList(offset = 0, limit = 28) {
    const result = await apiRequest(`/conversations?offset=${offset}&limit=${limit}`);
    console.log(`[API] getConversationsList: total=${result.total}, items=${result.items?.length || 0}`);
    return result;
}

/**
 * Fetch ALL conversations by paginating through the entire list
 * @param {function} onProgress - Callback for progress updates (current, total)
 */
async function getAllConversationsMeta(onProgress = null) {
    console.log('[API] getAllConversationsMeta starting...');
    const allConversations = [];
    let offset = 0;
    const limit = 28;
    let total = null;

    while (true) {
        const response = await getConversationsList(offset, limit);

        if (total === null) {
            total = response.total || 0;
            console.log(`[API] Total conversations reported: ${total}`);
        }

        if (!response.items || response.items.length === 0) {
            console.log('[API] No more items, breaking loop');
            break;
        }

        allConversations.push(...response.items);
        console.log(`[API] Fetched ${allConversations.length}/${total} conversations`);

        if (onProgress) {
            onProgress(allConversations.length, total);
        }

        if (allConversations.length >= total) {
            break;
        }

        offset += limit;
        await sleep(RATE_LIMIT_DELAY);
    }

    console.log(`[API] getAllConversationsMeta complete: ${allConversations.length} conversations`);
    return allConversations;
}

/**
 * Get full conversation details by ID
 * @param {string} conversationId 
 */
async function getConversation(conversationId) {
    console.log(`[API] getConversation: ${conversationId}`);
    return apiRequest(`/conversation/${conversationId}`);
}

/**
 * Get multiple conversations with rate limiting
 * @param {string[]} conversationIds - Array of conversation IDs
 * @param {function} onProgress - Callback for progress updates
 */
async function getConversations(conversationIds, onProgress = null) {
    console.log(`[API] getConversations: fetching ${conversationIds.length} conversations`);
    const conversations = [];

    for (let i = 0; i < conversationIds.length; i++) {
        const conversation = await getConversation(conversationIds[i]);
        conversations.push(conversation);

        if (onProgress) {
            onProgress(i + 1, conversationIds.length);
        }

        // Rate limit between requests (except for the last one)
        if (i < conversationIds.length - 1) {
            await sleep(RATE_LIMIT_DELAY);
        }
    }

    return conversations;
}

export {
    getConversationsList,
    getAllConversationsMeta,
    getConversation,
    getConversations,
    RATE_LIMIT_DELAY
};
