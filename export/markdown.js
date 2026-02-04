/**
 * Markdown Export Module
 * Converts ChatGPT conversation JSON to Obsidian-compatible Markdown
 * 
 * Based on message extraction pattern from: https://github.com/pionxzh/chatgpt-exporter
 */

/**
 * Normalize encoding issues from UTF-16LE JSON files
 * The box-drawing characters ┬╖ (U+252C U+2556) appear when a middle dot (·)
 * gets corrupted during UTF-8 to UTF-16LE conversion in the ChatGPT export
 *
 * @param {string} text - Text that may contain encoding corruption
 * @returns {string} Text with encoding issues normalized
 */
function normalizeEncoding(text) {
    if (!text) return text;
    // Replace corrupted middle dot (┬╖) with actual middle dot (·)
    return text.replace(/\u252C\u2556/g, '\u00B7');
}

/**
 * Sanitize filename by replacing invalid characters with underscores
 * and converting spaces to underscores
 */
function sanitizeFilename(title) {
    if (!title) return 'Untitled_Conversation';

    // Normalize encoding issues from UTF-16LE JSON files
    let filename = normalizeEncoding(title);

    // Replace spaces with underscores
    filename = filename.replace(/\s+/g, '_');

    // Replace invalid filename characters with underscores
    // Invalid chars on Windows: \ / : * ? " < > |
    filename = filename.replace(/[\\/:*?"<>|]/g, '_');

    // Remove any leading/trailing underscores and collapse multiple underscores
    filename = filename.replace(/_+/g, '_').replace(/^_|_$/g, '');

    // Limit length to avoid filesystem issues
    if (filename.length > 200) {
        filename = filename.substring(0, 200);
    }

    return filename || 'Untitled_Conversation';
}

/**
 * Extract first 8 characters from conversation_id
 * These 8 hex characters encode the timestamp when user submitted, always unique per user
 *
 * @param {string} conversationId - The full conversation ID (e.g., "6981fddd-2834-8394-9b08-a9b19891753c")
 * @returns {string} First 8 characters (e.g., "6981fddd")
 */
function getShortConversationId(conversationId) {
    if (!conversationId || typeof conversationId !== 'string') {
        return '';
    }
    return conversationId.substring(0, 8);
}

/**
 * Convert project name to valid Obsidian tag
 * Uses only lowercase letters, numbers, and hyphens (NO underscores)
 *
 * Rules:
 * - Convert to lowercase
 * - Transliterate diacritics to ASCII equivalents (a, e, o, u, s, n, z, etc.)
 * - Replace spaces and apostrophes with hyphens
 * - Remove all special characters (&#!,;$, etc.)
 * - Collapse multiple consecutive hyphens to single hyphen
 * - Remove leading/trailing hyphens
 *
 * @param {string} projectName - The project name to sanitize
 * @returns {string} Valid Obsidian tag
 */
function sanitizeProjectTag(projectName) {
    if (!projectName || typeof projectName !== 'string') {
        return '';
    }

    // Step 1: Convert to lowercase
    let tag = projectName.toLowerCase();

    // Step 2: Transliterate common diacritics to ASCII equivalents
    const diacriticMap = {
        'á': 'a', 'à': 'a', 'ä': 'a', 'â': 'a', 'ã': 'a', 'å': 'a', 'ą': 'a', 'ă': 'a',
        'é': 'e', 'è': 'e', 'ë': 'e', 'ê': 'e', 'ę': 'e', 'ě': 'e',
        'í': 'i', 'ì': 'i', 'ï': 'i', 'î': 'i', 'ı': 'i',
        'ó': 'o', 'ò': 'o', 'ö': 'o', 'ô': 'o', 'õ': 'o', 'ø': 'o', 'ő': 'o',
        'ú': 'u', 'ù': 'u', 'ü': 'u', 'û': 'u', 'ű': 'u', 'ů': 'u',
        'ý': 'y', 'ÿ': 'y',
        'ñ': 'n', 'ń': 'n', 'ň': 'n',
        'ç': 'c', 'č': 'c', 'ć': 'c',
        'ß': 'ss',
        'ś': 's', 'š': 's', 'ş': 's',
        'ź': 'z', 'ž': 'z', 'ż': 'z',
        'ł': 'l', 'ľ': 'l',
        'ř': 'r',
        'ť': 't',
        'ď': 'd', 'đ': 'd',
        'æ': 'ae', 'œ': 'oe',
        'þ': 'th', 'ð': 'd'
    };

    tag = tag.split('').map(char => diacriticMap[char] || char).join('');

    // Step 3: Replace spaces and apostrophes with hyphens
    tag = tag.replace(/[\s']/g, '-');

    // Step 4: Remove all characters except lowercase letters, numbers, and hyphens
    tag = tag.replace(/[^a-z0-9-]/g, '');

    // Step 5: Collapse multiple consecutive hyphens to single hyphen
    tag = tag.replace(/-+/g, '-');

    // Step 6: Remove leading/trailing hyphens
    tag = tag.replace(/^-+|-+$/g, '');

    return tag;
}

/**
 * Extract branching information from conversation mapping
 * Searches through all nodes in conversation.mapping to find branching_from_conversation_id
 * and branching_from_conversation_title in message metadata.
 *
 * @param {Object} conversation - The conversation object with mapping
 * @returns {{parentId: string, parentTitle: string}|null} Parent info or null if not found
 */
function extractBranchingInfo(conversation) {
    if (!conversation || !conversation.mapping) {
        return null;
    }

    // Iterate through all nodes in the mapping
    for (const nodeId of Object.keys(conversation.mapping)) {
        const node = conversation.mapping[nodeId];

        // Check if this node has message metadata with branching info
        if (node.message && node.message.metadata) {
            const metadata = node.message.metadata;

            if (metadata.branching_from_conversation_id && metadata.branching_from_conversation_title) {
                return {
                    parentId: metadata.branching_from_conversation_id,
                    parentTitle: metadata.branching_from_conversation_title
                };
            }
        }
    }

    return null;
}

/**
 * Generate filename from title and conversation_id
 * This function is used for BOTH actual file output AND parent internal links
 * to ensure consistency and that Obsidian links resolve correctly.
 *
 * @param {string} title - The conversation title
 * @param {string} conversationId - The full conversation ID
 * @returns {string} Filename without extension (e.g., "Diacritics_and_Accents_698065a8")
 */
function generateFilename(title, conversationId) {
    const sanitized = sanitizeFilename(title);
    const shortId = getShortConversationId(conversationId);

    if (!shortId) {
        return sanitized;
    }

    return `${sanitized}_${shortId}`;
}

/**
 * Escape hashtags in hex color codes that are NOT inside code fences or inline backticks.
 * This prevents Obsidian from treating hex color codes like #ccc or #FF0000 as tags.
 *
 * Supported formats:
 * - 3-character hex: #ccc, #abc
 * - 6-character hex: #4a2e32, #3E393A, #FF0000
 * - 8-character hex (with alpha): #FF0000FF, #00000080
 *
 * @param {string} text - The text to process
 * @returns {string} Text with hex color codes escaped (# -> \#)
 */
function escapeHexColorCodes(text) {
    if (!text) return text;

    // Regex to match hex color codes: # followed by 3, 4, 6, or 8 hex digits
    // 3 digits: #RGB (shorthand)
    // 4 digits: #RGBA (shorthand with alpha)
    // 6 digits: #RRGGBB (standard)
    // 8 digits: #RRGGBBAA (with alpha)
    // We need word boundary or non-hex char after to avoid matching longer sequences
    const hexColorPattern = /#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})(?![0-9A-Fa-f])/g;

    const lines = text.split('\n');
    const result = [];
    let insideCodeFence = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check if this line is a code fence marker
        const isCodeFenceMarker = /^```/.test(line.trim()) || /^~~~/.test(line.trim());

        if (isCodeFenceMarker) {
            if (!insideCodeFence) {
                // Entering code fence
                insideCodeFence = true;
            } else {
                // Exiting code fence
                insideCodeFence = false;
            }
            result.push(line);
        } else if (insideCodeFence) {
            // Inside code fence - don't escape
            result.push(line);
        } else {
            // Outside code fence - need to escape hex colors BUT NOT those in inline backticks
            // Strategy: Split by backticks, only process non-code segments
            const segments = line.split(/(`[^`]*`)/g);
            const processedSegments = segments.map((segment, idx) => {
                // Odd indices are the backtick-enclosed parts (the captured groups)
                // Actually with split on capturing group, the captured content is at odd indices
                if (segment.startsWith('`') && segment.endsWith('`')) {
                    // This is inline code - don't escape
                    return segment;
                } else {
                    // This is regular text - escape hex color codes
                    return segment.replace(hexColorPattern, '\\#$1');
                }
            });
            result.push(processedSegments.join(''));
        }
    }

    return result.join('\n');
}

/**
 * Format user content as an Obsidian callout
 * Prefixes each line with `> ` (angle bracket + space) EXCEPT lines inside code fences.
 * The callout header `> [!me:]` is NOT added by this function - it's added by the caller.
 *
 * Rules:
 * - Lines outside code fences get `> ` prefix
 * - Lines inside code fences (``` ... ```) are NOT prefixed (entire code block is exempt)
 * - The opening and closing ``` markers are also NOT prefixed
 * - Inline code (`code`) does NOT affect prefixing (it's still inside a line)
 * - Empty lines inside callouts become `> ` (just angle bracket + space)
 * - Nested blockquotes in user content get double prefix: `> > `
 *
 * @param {string} content - The user message content
 * @returns {string} Content formatted for Obsidian callout (without header)
 */
function formatUserContentAsCallout(content) {
    if (!content) return '';

    const lines = content.split('\n');
    const result = [];
    let insideCodeFence = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check if this line starts or ends a code fence
        // Code fence starts with ``` at the beginning of the line (possibly with language tag)
        const isCodeFenceMarker = /^```/.test(line.trim());

        if (isCodeFenceMarker) {
            if (!insideCodeFence) {
                // Entering code fence - do NOT prefix the opening fence marker
                result.push(line);
                insideCodeFence = true;
            } else {
                // Exiting code fence - do NOT prefix the closing fence marker
                result.push(line);
                insideCodeFence = false;
            }
        } else if (insideCodeFence) {
            // Inside code fence - no prefix
            result.push(line);
        } else {
            // Outside code fence - add `> ` prefix
            result.push('> ' + line);
        }
    }

    return result.join('\n');
}

/**
 * Extract 10-digit integer from create_time timestamp
 * The create_time is a Unix timestamp in seconds with decimal places
 *
 * @param {number|null|undefined} createTime - Unix timestamp (e.g., 1770126827.760625)
 * @returns {number|null} 10-digit integer portion (e.g., 1770126827) or null if invalid
 */
function getChronum(createTime) {
    if (createTime === null || createTime === undefined) {
        return null;
    }

    // Handle already integer values
    if (Number.isInteger(createTime)) {
        return createTime;
    }

    // Handle floating point - take integer portion (floor)
    if (typeof createTime === 'number' && !isNaN(createTime)) {
        return Math.floor(createTime);
    }

    // Handle string numbers
    if (typeof createTime === 'string') {
        const parsed = parseFloat(createTime);
        if (!isNaN(parsed)) {
            return Math.floor(parsed);
        }
    }

    return null;
}

/**
 * Format ISO date string
 */
function formatDate(timestamp) {
    if (!timestamp) return new Date().toISOString();

    // Handle Unix timestamps (seconds)
    if (typeof timestamp === 'number') {
        return new Date(timestamp * 1000).toISOString();
    }

    return new Date(timestamp).toISOString();
}

/**
 * Format timestamp to truncated YYYY-MM-DDTHH:MM format (no seconds, no Z suffix)
 * This format is used for the created and updated frontmatter properties
 *
 * @param {number|string|null|undefined} timestamp - Unix timestamp in seconds (e.g., 1770126827.760625)
 * @returns {string} Truncated ISO format (e.g., "2026-02-03T13:53")
 */
function formatTruncatedDate(timestamp) {
    if (!timestamp) {
        // Return current time truncated
        return new Date().toISOString().slice(0, 16);
    }

    // Handle Unix timestamps (seconds)
    if (typeof timestamp === 'number') {
        return new Date(timestamp * 1000).toISOString().slice(0, 16);
    }

    // Handle string timestamps (parse as float for Unix timestamps)
    if (typeof timestamp === 'string') {
        const parsed = parseFloat(timestamp);
        if (!isNaN(parsed)) {
            return new Date(parsed * 1000).toISOString().slice(0, 16);
        }
    }

    // Fallback: try to parse as a date string
    const date = new Date(timestamp);
    if (!isNaN(date.getTime())) {
        return date.toISOString().slice(0, 16);
    }

    // Ultimate fallback
    return new Date().toISOString().slice(0, 16);
}

/**
 * Detect the model used in the conversation
 */
function detectModel(conversation) {
    // Try to get model from mapping
    if (conversation.mapping) {
        for (const nodeId of Object.keys(conversation.mapping)) {
            const node = conversation.mapping[nodeId];
            if (node.message?.metadata?.model_slug) {
                return node.message.metadata.model_slug;
            }
        }
    }
    return 'unknown';
}

/**
 * Get a display-friendly model name
 */
function getModelDisplayName(modelSlug) {
    const modelNames = {
        'gpt-4': 'GPT-4',
        'gpt-4o': 'GPT-4o',
        'gpt-4o-mini': 'GPT-4o Mini',
        'gpt-4-turbo': 'GPT-4 Turbo',
        'gpt-3.5-turbo': 'GPT-3.5 Turbo',
        'o1-preview': 'o1-preview',
        'o1-mini': 'o1-mini'
    };
    return modelNames[modelSlug] || modelSlug?.toUpperCase() || 'Unknown';
}

/**
 * Extract text content from a message part (handles different content types)
 */
function extractTextFromPart(part) {
    if (typeof part === 'string') {
        return part;
    }
    // Handle multimodal content - skip non-text parts
    if (part && typeof part === 'object') {
        if (part.content_type === 'image_asset_pointer') {
            return '[Image]';
        }
        if (part.text) {
            return part.text;
        }
    }
    return '';
}

/**
 * Extract text content from a message's content object
 */
function extractMessageText(content) {
    if (!content) return '';

    // Handle text content type
    if (content.content_type === 'text' && content.parts) {
        return content.parts.map(extractTextFromPart).join('\n');
    }

    // Handle multimodal_text content type
    if (content.content_type === 'multimodal_text' && content.parts) {
        return content.parts.map(extractTextFromPart).join('\n');
    }

    // Handle code execution output
    if (content.content_type === 'execution_output' && content.text) {
        return '```\n' + content.text + '\n```';
    }

    // Handle code content
    if (content.content_type === 'code' && content.text) {
        return '```\n' + content.text + '\n```';
    }

    // Fallback for string content
    if (typeof content === 'string') {
        return content;
    }

    return '';
}

/**
 * Transform content references (citations) to markdown links
 * Citations appear as "citeturn0search0" or "citeturn1view0turn2search3" in the text
 */
function transformCitations(text, metadata) {
    let output = text;

    // First, remove products{...} blocks that may have slipped through
    output = output.replace(/products\s*\{[\s\S]*?\}(?=\n|$)/gm, '');

    if (!metadata?.content_references || metadata.content_references.length === 0) {
        // Fallback: just remove citation markers if no metadata available
        return output.replace(/cite[a-zA-Z0-9]+/g, '');
    }

    const contentRefs = metadata.content_references;

    // Sort by matched_text length descending to match longer patterns first
    const sortedRefs = [...contentRefs].sort((a, b) =>
        (b.matched_text?.length || 0) - (a.matched_text?.length || 0)
    );

    for (const ref of sortedRefs) {
        if (!ref.matched_text) continue;

        // Normalize whitespace in matched text
        const matchedText = ref.matched_text.replace(/\s/g, ' ');

        // Get URL and title from items array (new format) or direct fields
        const item = ref.items?.[0];
        const url = item?.url || ref.url;
        const title = item?.title || ref.title;

        if (!url) continue;

        // Check if this reference appears in the output
        if (output.includes(matchedText)) {
            // Replace citation marker with inline link: ([Title](URL))
            const displayTitle = title || url;
            const inlineLink = ` ([${displayTitle}](${url}))`;
            output = output.split(matchedText).join(inlineLink);
        }
    }

    // Remove any remaining unmatched citation markers (like image citations without URLs)
    output = output.replace(/cite[a-zA-Z0-9]+/g, '');

    // No footnotes needed - using inline links now
    return output;
}

/**
 * Check if a message should be skipped (internal tool calls, thinking, etc.)
 */
function shouldSkipMessage(msg) {
    if (!msg) return true;

    const role = msg.author?.role;
    const contentType = msg.content?.content_type;
    const metadata = msg.metadata;

    // Skip system and tool messages
    if (role === 'system' || role === 'tool') {
        return true;
    }

    // Skip messages marked as visually hidden
    if (metadata?.is_visually_hidden_from_conversation) {
        return true;
    }

    // Skip certain content types (thinking, context, etc.)
    const skipContentTypes = [
        'model_editable_context',
        'user_editable_context',
        'thoughts',
        'reasoning_recap',
        'tether_browsing_code',
        'tether_browsing_display'
    ];

    if (skipContentTypes.includes(contentType)) {
        return true;
    }

    // Get the text content of the message
    const text = extractMessageText(msg.content);

    // Skip if empty
    if (!text.trim()) {
        return true;
    }

    // Skip assistant messages that are just tool/search JSON commands
    if (role === 'assistant') {
        let inner = text.trim();

        // Strip code fences: ```...``` or ```json\n...\n```
        if (inner.startsWith('```')) {
            const endIdx = inner.lastIndexOf('```');
            if (endIdx > 3) {
                // Remove opening ``` (plus optional language tag and newline)
                let start = inner.indexOf('\n');
                if (start === -1 || start > endIdx) start = 3;
                else start = start + 1;
                inner = inner.substring(start, endIdx).trim();
            }
        }

        // Check for JSON tool calls
        if (inner.startsWith('{') && inner.endsWith('}')) {
            try {
                const parsed = JSON.parse(inner);
                // Common tool call patterns from ChatGPT internal system
                const toolKeys = [
                    'search_query', 'open', 'find', 'image_query',
                    'product_query', 'response_length', 'selections', 'tags'
                ];
                if (toolKeys.some(key => key in parsed)) {
                    return true;
                }
            } catch (e) {
                // Not valid JSON, might be actual content
            }
        }

        // Skip function call patterns
        if (inner.startsWith('mainline_search(') ||
            inner.match(/^products\s*\{/)) {
            return true;
        }
    }

    return false;
}

/**
 * Extract messages from conversation in order
 * Uses the reference implementation approach: start from current_node and traverse backwards via parent
 */
function extractMessages(conversation) {
    const messages = [];

    if (!conversation.mapping) {
        return messages;
    }

    const nodes = conversation.mapping;

    // Find the starting node (current_node or the node with no children)
    let startNodeId = conversation.current_node;
    if (!startNodeId) {
        // Fallback: find node with no children (leaf node)
        startNodeId = Object.values(nodes).find(node => !node.children || node.children.length === 0)?.id;
    }

    if (!startNodeId) {
        console.log('[Markdown] No start node found');
        return messages;
    }

    // Traverse backwards from current_node to root, collecting messages
    let currentNodeId = startNodeId;
    const collectedNodes = [];

    while (currentNodeId) {
        const node = nodes[currentNodeId];
        if (!node) {
            break;
        }

        // Stop at root (no parent)
        if (node.parent === undefined) {
            break;
        }

        // Process this node if it has a valid message and shouldn't be skipped
        if (node.message && node.message.content && !shouldSkipMessage(node.message)) {
            const msg = node.message;
            const role = msg.author?.role;
            let text = extractMessageText(msg.content);

            // Process citations for assistant messages
            if (role === 'assistant' && msg.metadata) {
                text = transformCitations(text, msg.metadata);
            }

            if (text.trim()) {
                // Prepend to maintain correct order (we're traversing backwards)
                collectedNodes.unshift({
                    role: role,
                    content: text.trim()
                });
            }
        }

        // Move to parent
        currentNodeId = node.parent;
    }

    // Filter to only user and assistant messages for the final output
    return collectedNodes.filter(msg => msg.role === 'user' || msg.role === 'assistant');
}

/**
 * Sanitize a title for use in frontmatter
 * Replaces double quotes with single quotes to avoid YAML parsing issues in Obsidian
 *
 * @param {string} title - The title to sanitize
 * @returns {string} Title safe for frontmatter (double quotes replaced with single quotes)
 */
function sanitizeTitleForFrontmatter(title) {
    if (!title) return title;
    return title.replace(/"/g, "'");
}

/**
 * Wrap image_group outputs in code fences
 *
 * ChatGPT's image_group outputs appear with special Unicode markers:
 * \ue200image_group\ue202{JSON}\ue201
 *
 * This function:
 * 1. Detects lines containing this pattern
 * 2. Removes the Unicode markers (\ue200, \ue202, \ue201)
 * 3. Wraps the cleaned content in code fences
 *
 * Example input:  \ue200image_group\ue202{"query":["test"]}\ue201
 * Example output: ```
 *                 image_group{"query":["test"]}
 *                 ```
 *
 * @param {string} text - The text to process
 * @returns {string} Text with image_group blocks wrapped in code fences
 */
function wrapImageGroupInCodeFences(text) {
    if (!text) return text;

    // Pattern matches the full image_group line with Unicode markers
    // \ue200 = start marker
    // \ue202 = separator between "image_group" and the JSON
    // \ue201 = end marker
    const imageGroupPattern = /\ue200image_group\ue202(\{[^\ue201]*\})\ue201/g;

    // Replace each match with the cleaned content wrapped in code fences
    return text.replace(imageGroupPattern, (match, jsonContent) => {
        return '```\nimage_group' + jsonContent + '\n```';
    });
}

/**
 * Convert conversation to Obsidian-compatible Markdown
 */
function conversationToMarkdown(conversation) {
    // Trim title and normalize encoding issues from UTF-16LE JSON files
    const title = normalizeEncoding((conversation.title || 'Untitled Conversation').trim());
    // Sanitize title for frontmatter (replace double quotes with single quotes)
    const frontmatterTitle = sanitizeTitleForFrontmatter(title);
    const modelSlug = detectModel(conversation);
    const modelDisplayName = getModelDisplayName(modelSlug);
    const created = formatTruncatedDate(conversation.create_time);
    const updated = formatTruncatedDate(conversation.update_time);
    const conversationId = conversation.conversation_id || conversation.id;

    // Handle project conversations (marked with _projectId and _projectName)
    const projectId = conversation._projectId;
    const projectName = conversation._projectName?.trim();

    // Build source URL - different format for project conversations
    const sourceUrl = projectId
        ? `https://chatgpt.com/g/${projectId}/c/${conversationId}`
        : `https://chatgpt.com/c/${conversationId}`;

    // Get chronum from create_time
    const chronum = getChronum(conversation.create_time);

    // Extract branching info for parent property
    const branchingInfo = extractBranchingInfo(conversation);

    // Build parent property - empty list item if no parent, or internal link if parent exists
    let parentProperty = 'parent:\n  - ';
    if (branchingInfo) {
        const parentFilename = generateFilename(branchingInfo.parentTitle, branchingInfo.parentId);
        parentProperty = `parent:\n  - "[[${parentFilename}]]"`;
    }

    // Build aliases property (Modification #6)
    // First alias: 8-character conversation ID
    // Second alias: title + space + 8-character ID
    // Each alias is wrapped in double quotes to ensure Obsidian treats them as strings
    // (important when the first alias is just 8 hex digits, which could be interpreted as a number)
    // Note: Use frontmatterTitle (with double quotes replaced by single quotes)
    const shortId = getShortConversationId(conversationId);
    const aliasesProperty = shortId
        ? `aliases:\n  - "${shortId}"\n  - "${frontmatterTitle} ${shortId}"`
        : 'aliases:\n  - ';

    // Build tags property in YAML list format
    // gpt-chat is always first; if project exists, add sanitized project tag second
    let tagsProperty;
    if (projectName) {
        const projectTag = sanitizeProjectTag(projectName);
        tagsProperty = `tags:\n  - gpt-chat\n  - ${projectTag}`;
    } else {
        tagsProperty = 'tags:\n  - gpt-chat';
    }

    // Build YAML frontmatter (new format per spec)
    // Property order: title, aliases, parent, type, model-name, chronum, created, updated, tags, project, source
    // Note: Use frontmatterTitle for title property (double quotes replaced with single quotes)
    const frontmatterLines = [
        '---',
        `title: "${frontmatterTitle}"`,
        aliasesProperty,
        parentProperty,
        'type: gpt-chat',
        `model-name: ${modelSlug}`,
        `chronum: ${chronum}`,
        `created: ${created}`,
        `updated: ${updated}`,
        tagsProperty,
    ];

    // Add project property if this is a project conversation
    if (projectName) {
        frontmatterLines.push(`project: "${projectName}"`);
    }

    frontmatterLines.push(`source: ${sourceUrl}`);
    frontmatterLines.push('---');

    const frontmatter = frontmatterLines.join('\n');

    // Build message content
    const messages = extractMessages(conversation);
    const messageBlocks = messages.map((msg, index) => {
        if (msg.role === 'user') {
            // Format user messages as Obsidian callouts
            const calloutContent = formatUserContentAsCallout(msg.content);
            return `> [!me:]\n${calloutContent}`;
        } else {
            // Check if this is a JSON-only message followed by another ChatGPT message
            // If so, wrap it in code fences (Feature #38)
            const trimmedContent = msg.content.trim();
            const isJsonObject = trimmedContent.startsWith('{') && trimmedContent.endsWith('}');
            const nextMsg = messages[index + 1];
            const isFollowedByChatGPT = nextMsg && nextMsg.role === 'assistant';

            if (isJsonObject && isFollowedByChatGPT) {
                return `#### ChatGPT:\n\`\`\`\n${msg.content}\n\`\`\``;
            }
            return `#### ChatGPT:\n${msg.content}`;
        }
    });

    // Build body content (title header + messages)
    // Feature #39: Escape hex color codes ONLY in body content, NOT in frontmatter
    // Backslashes in frontmatter break Obsidian's YAML parsing
    let bodyContent = [
        `# ${title}`,
        '',
        messageBlocks.join('\n\n')
    ].join('\n');

    // Feature #41: Wrap image_group outputs in code fences
    // This must be done BEFORE hex color escaping so the code fences protect the content
    bodyContent = wrapImageGroupInCodeFences(bodyContent);

    // Apply hex color code escaping only to body content
    bodyContent = escapeHexColorCodes(bodyContent);

    // Combine frontmatter and body
    const markdown = [
        frontmatter,
        '',
        bodyContent
    ].join('\n');

    // Build file path with project folder if applicable
    // Use generateFilename for consistency with parent links
    const baseFilename = generateFilename(title, conversationId) + '.md';
    let filepath = baseFilename;

    if (projectName) {
        // Put project conversations in their project folder
        const projectFolder = sanitizeFilename(projectName);
        filepath = `${projectFolder}/${baseFilename}`;
    }

    return {
        filename: filepath,
        content: markdown
    };
}

export {
    sanitizeFilename,
    sanitizeProjectTag,
    conversationToMarkdown,
    extractMessages,
    formatDate,
    formatTruncatedDate,
    getShortConversationId,
    getChronum,
    extractBranchingInfo,
    generateFilename,
    formatUserContentAsCallout,
    escapeHexColorCodes,
    sanitizeTitleForFrontmatter,
    wrapImageGroupInCodeFences
};
