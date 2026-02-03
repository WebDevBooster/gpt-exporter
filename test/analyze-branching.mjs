/**
 * Analyze branching conversations JSON to understand metadata structure
 */
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

function loadUTF16LEJson(filePath) {
    const buffer = readFileSync(filePath);
    let content;
    if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
        content = buffer.toString('utf16le');
        if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
    } else {
        content = buffer.toString('utf8');
    }
    return JSON.parse(content);
}

const testFile = join(projectRoot, 'test-exports-and-logs', '4-branching-conversations_for_mock_API.json');
const data = loadUTF16LEJson(testFile);

console.log('Number of conversations:', data.length);
console.log('---');

for (let i = 0; i < data.length; i++) {
    const conv = data[i];
    console.log('Conversation', i, ':', conv.title);
    console.log('  ID:', conv.conversation_id);

    // Search mapping for branching metadata
    if (conv.mapping) {
        let foundBranching = false;
        for (const nodeId of Object.keys(conv.mapping)) {
            const node = conv.mapping[nodeId];
            if (node.message && node.message.metadata) {
                const meta = node.message.metadata;
                if (meta.branching_from_conversation_id || meta.branching_from_conversation_title) {
                    foundBranching = true;
                    console.log('  FOUND BRANCHING INFO in node', nodeId);
                    console.log('    branching_from_conversation_id:', meta.branching_from_conversation_id);
                    console.log('    branching_from_conversation_title:', meta.branching_from_conversation_title);
                }
            }
        }
        if (!foundBranching) {
            console.log('  No branching info found');
        }
    }
    console.log('---');
}
