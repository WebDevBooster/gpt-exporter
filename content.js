(() => {
if (globalThis.__gptExporterVersion === '2.3.2') return;
globalThis.__gptExporterVersion = '2.3.2';
/**
 * Content Script - runs in the context of chatgpt.com
 * This script can access the page's cookies for authenticated API calls
 * 
 * Based on authentication pattern from: https://github.com/pionxzh/chatgpt-exporter
 */

const API_BASE = 'https://chatgpt.com/backend-api';
const SESSION_API = 'https://chatgpt.com/api/auth/session';

// Cached only within this page's authenticated session.
let cachedAccessToken = null;
let cachedUserId = null;

function httpError(response, detail = '') {
    return Object.assign(new Error(`API Error: ${response.status} ${response.statusText}`), {
        status: response.status, retryAfter: response.headers.get('Retry-After'),
        detail: detail.slice(0, 500)
    });
}

/**
 * Fetch session to get access token
 */
async function fetchSession(signal) {
    console.log('[GPT-Exporter] Fetching session...');
    const response = await fetch(SESSION_API, {
        credentials: 'include', signal
    });

    if (!response.ok) {
        throw httpError(response);
    }

    const session = await response.json();
    console.log('[GPT-Exporter] Session fetched, has accessToken:', !!session.accessToken);
    return session;
}

/**
 * Get access token (cached)
 * @param {boolean} forceRefresh - Bypass the cache (e.g. after a 401)
 */
async function getAccessToken(forceRefresh = false, signal) {
    if (cachedAccessToken && !forceRefresh) {
        return cachedAccessToken;
    }

    const session = await fetchSession(signal);
    cachedAccessToken = session.accessToken;
    cachedUserId = session.user?.id;
    if (!cachedAccessToken || !cachedUserId) throw new Error('Log in to ChatGPT, then resume the export.');
    return cachedAccessToken;
}

/**
 * Get team account ID if user is on a team workspace
 */
function getWorkspaceAccountId() {
    const match = document.cookie.match(/(^|;)\s*_account\s*=\s*([^;]+)/);
    return match ? match.pop() : null;
}

/**
 * Make an authenticated request to ChatGPT API
 */
const FETCH_TIMEOUT_MS = 30000;

async function apiRequest(endpoint, expectedAccount, signal, isRetryAfter401 = false) {
    const url = `${API_BASE}${endpoint}`;
    console.log(`[GPT-Exporter Content] Requesting: ${url}`);

    try {
        const accessToken = await getAccessToken(isRetryAfter401, signal);
        const accountId = getWorkspaceAccountId();
        if (expectedAccount && expectedAccount !== `${cachedUserId}:${accountId || 'personal'}`) {
            throw new Error('ChatGPT account or workspace changed. Switch back before resuming.');
        }

        const headers = {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
            'X-Authorization': `Bearer ${accessToken}`,
        };

        // Add team account ID if present
        if (accountId) {
            headers['Chatgpt-Account-Id'] = accountId;
            console.log('[GPT-Exporter] Using team account:', accountId);
        }

        const response = await fetch(url, {
            method: 'GET',
            credentials: 'include',
            headers: headers,
            signal
        });

        console.log(`[GPT-Exporter Content] Response status: ${response.status}`);

        // Stale cached token: refresh it once and retry
        if (response.status === 401 && !isRetryAfter401) {
            console.warn('[GPT-Exporter Content] Got 401, refreshing access token and retrying...');
            cachedAccessToken = null;
            return apiRequest(endpoint, expectedAccount, signal, true);
        }

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[GPT-Exporter Content] Error response:`, errorText);
            throw httpError(response, errorText);
        }

        const data = await response.json();
        // Conversation bodies stay out of console logs.
        return data;
    } catch (error) {
        if (error.name === 'AbortError') {
            const timeoutError = new Error(`Request timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${endpoint}`);
            console.error(`[GPT-Exporter Content] ${timeoutError.message}`);
            throw timeoutError;
        }
        console.error(`[GPT-Exporter Content] Fetch error:`, error);
        throw error;
    }
}

// Each message performs at most one backend request. Pagination and fallback
// decisions live in the worker so they share its pacing and durable cooldown.
async function getProjectsPage(message, signal) {
    if (message.source === 'dom') return { items: extractProjectsFromDOM() };
    if (message.source === 'discovery') {
        const response = await apiRequest('/gizmos/discovery', message.accountKey, signal);
        const items = response.cuts
            ? response.cuts.flatMap(cut => cut.list?.items || []).map(item => ({ gizmo: item.resource?.gizmo || item.gizmo || item }))
            : response.items || response.projects || response.list || [];
        return { items: items.filter(item => (item.gizmo?.id || item.id || '').startsWith('g-p-')) };
    }
    let endpoint = '/gizmos/snorlax/sidebar?conversations_per_gizmo=5&owned_only=true';
    if (message.cursor) endpoint += `&cursor=${encodeURIComponent(message.cursor)}`;
    const response = await apiRequest(endpoint, message.accountKey, signal);
    if (!Array.isArray(response.items)) throw new Error('Invalid project list response. Export paused.');
    return {
        items: (response.items || []).map(item => {
            const gizmo = item.gizmo?.gizmo || item.gizmo || item;
            return { id: gizmo.id, gizmo: { id: gizmo.id, display: { name: gizmo.display?.name || gizmo.name || gizmo.id } } };
        }).filter(item => item.id?.startsWith('g-p-')),
        cursor: response.cursor || null
    };
}

/**
 * Extract project IDs from the page DOM (sidebar links)
 * Projects have URLs like: /g/g-p-{id}-{name}/project
 */
function extractProjectsFromDOM() {
    const projects = [];
    const seenIds = new Set();

    // Find all links that look like project links
    const links = document.querySelectorAll('a[href*="/g/g-p-"]');
    console.log(`[GPT-Exporter] Found ${links.length} potential project links in DOM`);

    for (const link of links) {
        const href = link.getAttribute('href');
        // Match pattern: /g/g-p-{uuid}-{name}
        const match = href.match(/\/g\/(g-p-[a-f0-9]+-[^/]+)/);
        if (match && !seenIds.has(match[1])) {
            const projectId = match[1];
            seenIds.add(projectId);

            // Try to get the display name from the link text
            const displayName = link.textContent?.trim() || projectId;

            projects.push({
                id: projectId,
                gizmo: {
                    id: projectId,
                    display: { name: displayName }
                }
            });
            console.log(`[GPT-Exporter] Found project: ${projectId} (${displayName})`);
        }
    }

    return projects;
}


/**
 * Extract the API-compatible project ID (just the UUID, without the slug name)
 * DOM gives us: g-p-67c804d08cac8191af6ee36ed6219624-software-hardware
 * API needs:    g-p-67c804d08cac8191af6ee36ed6219624
 */
function extractProjectUUID(fullProjectId) {
    // Pattern: g-p-{32-char-hex}-{slug-name}
    // Extract: g-p-{32-char-hex}
    const match = fullProjectId.match(/^(g-p-[a-f0-9]{32})/);
    if (match) {
        return match[1];
    }
    // Fallback: return as-is
    return fullProjectId;
}

/**
 * Listen for messages from the extension
 */
const activeRequests = new Set();
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'abortExportRequests') {
        for (const request of activeRequests) {
            if (request.jobId === message.jobId) request.controller.abort();
        }
        sendResponse({ success: true });
        return false;
    }
    console.log('[GPT-Exporter Content] Received message:', message.action);

    const handleAsync = async () => {
        const controller = new AbortController();
        const request = { jobId: message.jobId, controller };
        activeRequests.add(request);
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        const signal = controller.signal;
        try {
            switch (message.action) {
                case 'getConversationsList':
                    return await apiRequest(`/conversations?offset=${message.offset || 0}&limit=${message.limit || 28}`, message.accountKey, signal);

                case 'getConversation':
                    return await apiRequest(`/conversation/${encodeURIComponent(message.id)}`, message.accountKey, signal);

                case 'getProjectsList':
                    return await getProjectsPage(message, signal);

                case 'getProjectConversations':
                    return await apiRequest(`/gizmos/${extractProjectUUID(message.projectId)}/conversations?cursor=${encodeURIComponent(message.cursor || '0')}`, message.accountKey, signal);

                case 'getAccountContext':
                    await getAccessToken(true, signal);
                    return { accountKey: `${cachedUserId}:${getWorkspaceAccountId() || 'personal'}` };

                case 'ping':
                    // Checking the popup must never issue requests during cooldown.
                    return { success: true, url: window.location.href };

                default:
                    throw new Error(`Unknown action: ${message.action}`);
            }
        } catch (error) {
            console.error('[GPT-Exporter Content] Error:', error);
            return { error: error.message, status: error.status || null,
                retryAfter: error.retryAfter || null, detail: error.detail || null };
        } finally {
            clearTimeout(timeoutId);
            activeRequests.delete(request);
        }
    };

    handleAsync().then(sendResponse);
    return true;
});

console.log('[GPT-Exporter Content] Content script loaded on:', window.location.href);

})();
