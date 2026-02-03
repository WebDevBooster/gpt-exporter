/**
 * Verify all mock JSON files load correctly
 */
import { loadUTF16LEJson } from './runner.mjs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const files = [
    '1-conversation_for_mock_API.json',
    '3-conversations_for_mock_API.json',
    '4-branching-conversations_for_mock_API.json'
];

console.log('Verifying UTF-16LE JSON loading for all mock files:\n');

let allPassed = true;

for (const file of files) {
    try {
        const data = loadUTF16LEJson(join(projectRoot, 'test-exports-and-logs', file));
        const info = Array.isArray(data) ? data.length + ' conversations' : typeof data;
        console.log('  ✓', file + ':', info);

        // Verify each conversation has required fields
        if (Array.isArray(data)) {
            for (const conv of data) {
                if (!conv.title || !conv.conversation_id || !conv.mapping) {
                    console.log('    Warning: conversation missing required fields');
                }
            }
        }
    } catch (e) {
        console.log('  ✗', file + ':', e.message);
        allPassed = false;
    }
}

console.log('\n' + (allPassed ? 'All files loaded successfully!' : 'Some files failed to load.'));
process.exit(allPassed ? 0 : 1);
