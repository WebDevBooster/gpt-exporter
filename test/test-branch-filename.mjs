import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { conversationToMarkdown, generateFilename } from '../export/markdown.js';

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

process.stdout.write('Found branch conversation\n');
process.stdout.write('Title: ' + JSON.stringify(branchConv.title) + '\n');

// Generate markdown
const result = conversationToMarkdown(branchConv);

process.stdout.write('Generated filename: ' + JSON.stringify(result.filename) + '\n');

// Expected filename from test-vault
const expectedFilename = 'Branch_·_Diacritics_and_Accents_6981255a.md';
process.stdout.write('Expected filename: ' + JSON.stringify(expectedFilename) + '\n');

// Check if it matches (with or without project folder)
const filenameWithoutFolder = result.filename.split('/').pop();
process.stdout.write('Filename without folder: ' + JSON.stringify(filenameWithoutFolder) + '\n');
process.stdout.write('Match: ' + (filenameWithoutFolder === expectedFilename) + '\n');
