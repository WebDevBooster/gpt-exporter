import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// Load UTF-16LE JSON file
function loadUTF16LEJson(filePath) {
    const buffer = readFileSync(filePath);
    let content;
    if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
        content = buffer.toString('utf16le');
        if (content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1);
        }
    } else {
        content = buffer.toString('utf8');
    }
    return JSON.parse(content);
}

// Load the branching conversations
const testFile = join(projectRoot, 'test-exports-and-logs', '4-branching-conversations_for_mock_API.json');
const conversations = loadUTF16LEJson(testFile);

// Find the Branch conversation
const branchConv = conversations.find(c => c.conversation_id === '6981255a-0c54-8393-9176-98d226ea8c0c');

if (!branchConv) {
    process.stdout.write('ERROR: Branch conversation not found\n');
    process.exit(1);
}

const title = branchConv.title;
process.stdout.write('Title length: ' + title.length + '\n');

// Print each character's code point
for (let i = 0; i < title.length; i++) {
    const char = title[i];
    const code = title.charCodeAt(i);
    process.stdout.write('Char ' + i + ': ' + code.toString(16).padStart(4, '0') + ' = ' + char + '\n');
}

// Compare with expected middle dot
const expectedMiddleDot = '\u00B7';  // Unicode middle dot
process.stdout.write('Expected middle dot code: ' + expectedMiddleDot.charCodeAt(0).toString(16) + '\n');

// Check expected filename character
const expectedFilename = 'Branch_·_Diacritics_and_Accents_6981255a.md';
for (let i = 0; i < 10; i++) {
    const code = expectedFilename.charCodeAt(i);
    process.stdout.write('Expected char ' + i + ': ' + code.toString(16).padStart(4, '0') + ' = ' + expectedFilename[i] + '\n');
}
