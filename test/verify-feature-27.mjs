/**
 * Verify Feature #27: Aliases appear in correct YAML list format
 *
 * This script generates markdown from mock data and compares
 * the aliases format against expected test-vault output.
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

import { conversationToMarkdown } from '../export/markdown.js';

/**
 * Load a UTF-16LE encoded JSON file with BOM
 */
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

console.log('=== Feature #27 Verification: Aliases YAML List Format ===\n');

// Test 1: Unusual Adjective conversation
console.log('Test 1: Unusual Adjective conversation\n');
const testFile1 = join(projectRoot, 'test-exports-and-logs', '1-conversation_for_mock_API.json');
const conversations1 = loadUTF16LEJson(testFile1);
const conv1 = conversations1[0];

// Add project info
conv1._projectId = 'g-p-69817ef78ab48191bc06ca7b51f5cc70';
conv1._projectName = "Tëster's Pläýground for &#!,;$£ Frieñd̄žß";

const result1 = conversationToMarkdown(conv1);

// Extract aliases section
const aliasesMatch1 = result1.content.match(/aliases:\n([\s\S]*?)parent:/);
console.log('Generated aliases:');
console.log('aliases:');
if (aliasesMatch1) {
    console.log(aliasesMatch1[1].trimEnd());
}

console.log('\nExpected aliases (from test-vault):');
console.log('aliases:');
console.log('  - 6981fddd');
console.log('  - Unusual Adjective 6981fddd');

// Verify
const expectedFormat1 = 'aliases:\n  - 6981fddd\n  - Unusual Adjective 6981fddd\n';
const pass1 = result1.content.includes(expectedFormat1);
console.log(`\nTest 1 ${pass1 ? 'PASSED' : 'FAILED'}: ${pass1 ? 'Aliases match expected format' : 'Aliases do NOT match expected format'}`);

// Test 2: Diacritics and Accents conversation
console.log('\n' + '='.repeat(50));
console.log('\nTest 2: Diacritics and Accents conversation\n');
const testFile2 = join(projectRoot, 'test-exports-and-logs', '4-branching-conversations_for_mock_API.json');
const conversations2 = loadUTF16LEJson(testFile2);
const conv2 = conversations2.find(c => c.conversation_id === '698065a8-9160-8392-a810-0ae50700979b');

// Add project info
conv2._projectId = 'g-p-678ce30e20dc8191ab325e517603d768';
conv2._projectName = 'English Checking & Tutoring';

const result2 = conversationToMarkdown(conv2);

// Extract aliases section
const aliasesMatch2 = result2.content.match(/aliases:\n([\s\S]*?)parent:/);
console.log('Generated aliases:');
console.log('aliases:');
if (aliasesMatch2) {
    console.log(aliasesMatch2[1].trimEnd());
}

console.log('\nExpected aliases (from test-vault):');
console.log('aliases:');
console.log('  - 698065a8');
console.log('  - Diacritics and Accents 698065a8');

// Verify
const expectedFormat2 = 'aliases:\n  - 698065a8\n  - Diacritics and Accents 698065a8\n';
const pass2 = result2.content.includes(expectedFormat2);
console.log(`\nTest 2 ${pass2 ? 'PASSED' : 'FAILED'}: ${pass2 ? 'Aliases match expected format' : 'Aliases do NOT match expected format'}`);

// Test 3: Verify two-space indentation
console.log('\n' + '='.repeat(50));
console.log('\nTest 3: Verify two-space indentation before list dash\n');

const lines1 = aliasesMatch1[1].split('\n').filter(l => l.trim());
let indentPass = true;
for (const line of lines1) {
    if (!line.startsWith('  - ')) {
        indentPass = false;
        console.log(`FAIL: Line does not have two-space indent: "${line}"`);
    }
}
console.log(`Test 3 ${indentPass ? 'PASSED' : 'FAILED'}: ${indentPass ? 'All aliases have correct two-space indentation' : 'Indentation issues found'}`);

// Summary
console.log('\n' + '='.repeat(50));
console.log('\n=== SUMMARY ===\n');
const allPass = pass1 && pass2 && indentPass;
console.log(`Feature #27 Verification: ${allPass ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}`);
console.log(`- Test 1 (Unusual Adjective): ${pass1 ? 'PASS' : 'FAIL'}`);
console.log(`- Test 2 (Diacritics and Accents): ${pass2 ? 'PASS' : 'FAIL'}`);
console.log(`- Test 3 (Two-space indentation): ${indentPass ? 'PASS' : 'FAIL'}`);

process.exit(allPass ? 0 : 1);
