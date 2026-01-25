/**
 * Content Script - runs in the context of chatgpt.com
 * This script can access the page's cookies for authenticated API calls
 * 
 * Based on authentication pattern from: https://github.com/pionxzh/chatgpt-exporter
 */

const API_BASE = 'https://chatgpt.com/backend-api';
const SESSION_API = 'https://chatgpt.com/api/auth/session';

// Cached access token
let cachedAccessToken = null;

/**
 * Fetch session to get access token
 */
async function fetchSession() {
    console.log('[GPT-Exporter] Fetching session...');
    const response = await fetch(SESSION_API, {
        credentials: 'include'
    });

    if (!response.ok) {
        throw new Error(`Session fetch failed: ${response.status}`);
    }

    const session = await response.json();
    console.log('[GPT-Exporter] Session fetched, has accessToken:', !!session.accessToken);
    return session;
}

/**
 * Get access token (cached)
 */
async function getAccessToken() {
    if (cachedAccessToken) {
        return cachedAccessToken;
    }

    const session = await fetchSession();
    cachedAccessToken = session.accessToken;
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
async function apiRequest(endpoint) {
    const url = `${API_BASE}${endpoint}`;
    console.log(`[GPT-Exporter Content] Requesting: ${url}`);

    try {
        const accessToken = await getAccessToken();
        const accountId = getWorkspaceAccountId();

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
            headers: headers
        });

        console.log(`[GPT-Exporter Content] Response status: ${response.status}`);

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[GPT-Exporter Content] Error response:`, errorText);
            throw new Error(`API Error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        console.log(`[GPT-Exporter Content] Response data:`, data);
        return data;
    } catch (error) {
        console.error(`[GPT-Exporter Content] Fetch error:`, error);
        throw error;
    }
}

/**
 * Get conversation list (main/non-project conversations)
 */
async function getConversationsList(offset = 0, limit = 28) {
    return apiRequest(`/conversations?offset=${offset}&limit=${limit}`);
}

/**
 * Get single conversation
 */
async function getConversation(id) {
    return apiRequest(`/conversation/${id}`);
}

/**
 * Fetch all projects from the snorlax/sidebar API with cursor pagination
 * This endpoint returns all projects, not just the visible 5
 */
async function fetchAllProjectsFromSidebar() {
    const projects = [];
    let cursor = null;
    const seenIds = new Set();

    while (true) {
        let url = '/gizmos/snorlax/sidebar?conversations_per_gizmo=5&owned_only=true';
        if (cursor) {
            url += `&cursor=${encodeURIComponent(cursor)}`;
        }

        console.log(`[GPT-Exporter] Fetching projects from snorlax/sidebar${cursor ? ' (next page)' : ''}...`);
        const response = await apiRequest(url);

        console.log(`[GPT-Exporter] snorlax/sidebar response:`, JSON.stringify(response).substring(0, 500));

        // Response has 'items' array with gizmo objects
        // Structure is: item.gizmo.gizmo.id (double-nested!)
        if (response.items && Array.isArray(response.items)) {
            for (const item of response.items) {
                // Handle double-nested structure: item.gizmo.gizmo
                const innerGizmo = item.gizmo?.gizmo || item.gizmo || item;
                const id = innerGizmo.id || item.gizmo?.id || item.id;

                // Only include projects (IDs starting with g-p-)
                if (id && id.startsWith('g-p-') && !seenIds.has(id)) {
                    seenIds.add(id);
                    const displayName = innerGizmo.display?.name || innerGizmo.name || id;
                    projects.push({
                        id: id,
                        gizmo: {
                            id: id,
                            display: { name: displayName }
                        }
                    });
                    console.log(`[GPT-Exporter] Found project: ${id} (${displayName})`);
                }
            }
        }

        // Check for next page
        if (response.cursor) {
            cursor = response.cursor;
        } else {
            console.log(`[GPT-Exporter] No more pages, found ${projects.length} total projects`);
            break;
        }
    }

    return projects;
}

/**
 * Get list of projects (GPT Projects use gizmo infrastructure)
 * Projects have IDs starting with "g-p-"
 * Uses the snorlax/sidebar endpoint which returns all projects with pagination
 */
async function getProjectsList() {
    // First try the snorlax/sidebar endpoint which returns all projects
    try {
        const allProjects = await fetchAllProjectsFromSidebar();
        if (allProjects.length > 0) {
            console.log(`[GPT-Exporter] Found ${allProjects.length} projects from snorlax/sidebar API`);
            return { items: allProjects };
        }
    } catch (error) {
        console.log(`[GPT-Exporter] snorlax/sidebar failed:`, error.message);
    }

    // Fallback to other endpoints
    const endpoints = [
        { url: '/gizmos/discovery', parse: 'cuts' },
    ];

    for (const endpoint of endpoints) {
        try {
            console.log(`[GPT-Exporter] Trying projects endpoint: ${endpoint.url}`);
            const response = await apiRequest(endpoint.url);

            console.log(`[GPT-Exporter] Response from ${endpoint.url}:`, JSON.stringify(response).substring(0, 800));

            let items = [];

            // Parse based on response structure
            if (endpoint.parse === 'cuts' && response.cuts) {
                for (const cut of response.cuts) {
                    if (cut.list?.items) {
                        for (const item of cut.list.items) {
                            if (item.resource?.gizmo) {
                                items.push({ gizmo: item.resource.gizmo });
                            } else if (item.gizmo) {
                                items.push(item);
                            } else {
                                items.push(item);
                            }
                        }
                    }
                }
            } else {
                items = response.items || response.projects || response.list || [];
            }

            if (!Array.isArray(items)) continue;

            // Filter to only include projects (IDs starting with g-p-)
            const projects = items.filter(item => {
                const id = item.id || item.gizmo?.id || item.project_id || '';
                return id.startsWith('g-p-');
            });

            console.log(`[GPT-Exporter] Found ${projects.length} projects (g-p- prefix) from ${endpoint.url}`);

            if (projects.length > 0) {
                return { items: projects };
            }
        } catch (error) {
            console.log(`[GPT-Exporter] Endpoint ${endpoint.url} failed:`, error.message);
        }
    }

    // FALLBACK: Extract project IDs from sidebar DOM
    console.log('[GPT-Exporter] API endpoints failed, trying DOM extraction...');
    try {
        const projectsFromDOM = extractProjectsFromDOM();
        if (projectsFromDOM.length > 0) {
            console.log(`[GPT-Exporter] Found ${projectsFromDOM.length} projects from DOM`);
            return { items: projectsFromDOM };
        }
    } catch (error) {
        console.log('[GPT-Exporter] DOM extraction failed:', error.message);
    }

    console.log('[GPT-Exporter] No projects found from any source');
    return { items: [] };
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
 * Get conversations within a specific project
 * Uses the /gizmos/{id}/conversations endpoint with cursor-based pagination
 */
async function getProjectConversations(projectId, cursor = '0') {
    // Extract just the UUID part for the API call
    const apiProjectId = extractProjectUUID(projectId);
    const endpoint = `/gizmos/${apiProjectId}/conversations?cursor=${cursor}`;

    try {
        console.log(`[GPT-Exporter] Fetching project conversations: ${endpoint}`);
        const response = await apiRequest(endpoint);

        console.log(`[GPT-Exporter] Response:`, JSON.stringify(response).substring(0, 300));

        // Response has 'items' array and 'cursor' for next page
        if (response.items) {
            console.log(`[GPT-Exporter] Found ${response.items.length} conversations, next cursor: ${response.cursor || 'none'}`);
            return {
                items: response.items,
                cursor: response.cursor || null,
                total: response.total || response.items.length
            };
        }

        return { items: [], cursor: null, total: 0 };
    } catch (error) {
        console.log(`[GPT-Exporter] Failed to get project conversations:`, error.message);
        return { items: [], cursor: null, total: 0 };
    }
}


/**
 * Listen for messages from the extension
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[GPT-Exporter Content] Received message:', message.action);

    const handleAsync = async () => {
        try {
            switch (message.action) {
                case 'getConversationsList':
                    return await getConversationsList(message.offset || 0, message.limit || 28);

                case 'getConversation':
                    return await getConversation(message.id);

                case 'getProjectsList':
                    return await getProjectsList();

                case 'getProjectConversations':
                    return await getProjectConversations(message.projectId, message.cursor || '0');

                case 'ping':
                    // Also verify we can get a token
                    try {
                        await getAccessToken();
                        return { success: true, url: window.location.href, hasToken: true };
                    } catch (e) {
                        return { success: true, url: window.location.href, hasToken: false, tokenError: e.message };
                    }

                default:
                    throw new Error(`Unknown action: ${message.action}`);
            }
        } catch (error) {
            console.error('[GPT-Exporter Content] Error:', error);
            return { error: error.message };
        }
    };

    handleAsync().then(sendResponse);
    return true;
});

console.log('[GPT-Exporter Content] Content script loaded on:', window.location.href);
