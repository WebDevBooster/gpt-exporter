/**
 * GPT Exporter Test Runner
 *
 * Tests the markdown export functionality for the Chrome extension.
 * Handles UTF-16LE encoded JSON files and compares generated output
 * against expected files in test-vault/
 *
 * Usage:
 *   node test/runner.mjs                    # Run all tests
 *   node test/runner.mjs --file <path>      # Test specific JSON file
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

// Get directory paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

// Import the markdown module (will be updated as modifications are implemented)
import {
    sanitizeFilename,
    sanitizeProjectTag,
    conversationToMarkdown,
    extractMessages,
    formatDate,
    formatTruncatedDate,
    getShortConversationId,
    getChronum,
    extractBranchingInfo,
    generateFilename
} from '../export/markdown.js';

/**
 * Load a UTF-16LE encoded JSON file with BOM
 * The mock API JSON files use this encoding format
 *
 * @param {string} filePath - Path to the JSON file
 * @returns {Array|Object} Parsed JSON data
 */
function loadUTF16LEJson(filePath) {
    // Read the file as a buffer
    const buffer = readFileSync(filePath);

    // Check for UTF-16LE BOM (0xFF 0xFE)
    let content;
    if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
        // UTF-16LE encoding with BOM
        content = buffer.toString('utf16le');
        // Remove BOM character if present
        if (content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1);
        }
    } else {
        // Fallback to UTF-8
        content = buffer.toString('utf8');
    }

    // Parse JSON
    try {
        return JSON.parse(content);
    } catch (e) {
        console.error(`Error parsing JSON from ${filePath}:`, e.message);
        throw e;
    }
}

/**
 * Compare generated markdown against expected output
 *
 * @param {string} generated - Generated markdown content
 * @param {string} expectedPath - Path to expected .md file
 * @returns {{pass: boolean, diff: string|null}} Comparison result
 */
function compareMarkdown(generated, expectedPath) {
    if (!existsSync(expectedPath)) {
        return {
            pass: false,
            diff: `Expected file not found: ${expectedPath}`
        };
    }

    // Read expected file (UTF-8)
    const expected = readFileSync(expectedPath, 'utf8');

    // Normalize line endings for cross-platform compatibility
    const normalizedGenerated = generated.replace(/\r\n/g, '\n').trim();
    const normalizedExpected = expected.replace(/\r\n/g, '\n').trim();

    if (normalizedGenerated === normalizedExpected) {
        return { pass: true, diff: null };
    }

    // Generate diff
    const generatedLines = normalizedGenerated.split('\n');
    const expectedLines = normalizedExpected.split('\n');

    let diff = '';
    const maxLines = Math.max(generatedLines.length, expectedLines.length);

    for (let i = 0; i < maxLines; i++) {
        const gen = generatedLines[i] || '';
        const exp = expectedLines[i] || '';

        if (gen !== exp) {
            diff += `\nLine ${i + 1}:\n`;
            diff += `  Expected: ${JSON.stringify(exp)}\n`;
            diff += `  Got:      ${JSON.stringify(gen)}\n`;
        }
    }

    return {
        pass: false,
        diff: diff || 'Files differ (content mismatch)'
    };
}

/**
 * Test result tracking
 */
const results = {
    passed: 0,
    failed: 0,
    errors: []
};

/**
 * Run a single test case
 *
 * @param {string} name - Test name
 * @param {Function} testFn - Test function
 */
async function test(name, testFn) {
    try {
        await testFn();
        console.log(`  ✓ ${name}`);
        results.passed++;
    } catch (error) {
        console.log(`  ✗ ${name}`);
        console.log(`    Error: ${error.message}`);
        results.failed++;
        results.errors.push({ name, error: error.message });
    }
}

/**
 * Assert that a condition is true
 */
function assert(condition, message) {
    if (!condition) {
        throw new Error(message || 'Assertion failed');
    }
}

/**
 * Assert that two values are equal
 */
function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(
            message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
        );
    }
}

/**
 * Run infrastructure tests
 */
async function runInfrastructureTests() {
    console.log('\n=== Test Infrastructure ===\n');

    // Test 1: UTF-16LE JSON loading
    await test('loads UTF-16LE JSON files correctly', () => {
        const testFile = join(projectRoot, 'test-exports-and-logs', '1-conversation_for_mock_API.json');
        assert(existsSync(testFile), `Test file not found: ${testFile}`);

        const data = loadUTF16LEJson(testFile);
        assert(Array.isArray(data), 'Should return an array');
        assert(data.length > 0, 'Array should not be empty');
        assert(data[0].title, 'First item should have a title');
        assertEqual(data[0].title, 'Unusual Adjective', 'Title should match');
    });

    // Test 2: ES module imports work
    await test('can import ES modules from export/markdown.js', () => {
        assert(typeof sanitizeFilename === 'function', 'sanitizeFilename should be a function');
        assert(typeof conversationToMarkdown === 'function', 'conversationToMarkdown should be a function');
        assert(typeof extractMessages === 'function', 'extractMessages should be a function');
        assert(typeof formatDate === 'function', 'formatDate should be a function');
    });

    // Test 3: Output comparison utility
    await test('output comparison utility detects differences', () => {
        // Test 1: Should fail for nonexistent file
        const result1 = compareMarkdown('foo\nbar', 'nonexistent.md');
        assert(!result1.pass, 'Should fail for nonexistent file');
        assert(result1.diff.includes('Expected file not found'), 'Should include error message');

        // Test 2: Should pass when comparing against an actual file with matching content
        const expectedPath = join(projectRoot, 'test-vault', 'English_Checking_&_Tutoring', 'Diacritics_and_Accents_698065a8.md');
        const expectedContent = readFileSync(expectedPath, 'utf8');
        const result2 = compareMarkdown(expectedContent, expectedPath);
        assert(result2.pass, 'Should pass when content matches expected file');
        assert(result2.diff === null, 'Diff should be null when content matches');

        // Test 3: Should fail and report differences when content doesn't match
        const modifiedContent = expectedContent.replace('Diacritics', 'MODIFIED');
        const result3 = compareMarkdown(modifiedContent, expectedPath);
        assert(!result3.pass, 'Should fail when content differs');
        assert(result3.diff && result3.diff.includes('Line'), 'Diff should include line information');

        // Test 4: Line endings normalization test
        const withCRLF = expectedContent.replace(/\n/g, '\r\n');
        const result4 = compareMarkdown(withCRLF, expectedPath);
        assert(result4.pass, 'Should pass with CRLF line endings (normalized)');
    });
}

/**
 * Run helper function tests (to be implemented as modifications are made)
 */
async function runHelperTests() {
    console.log('\n=== Helper Function Tests ===\n');

    // Placeholder tests - these will be expanded as functions are implemented

    await test('sanitizeFilename replaces spaces with underscores', () => {
        const result = sanitizeFilename('Hello World');
        assertEqual(result, 'Hello_World');
    });

    await test('sanitizeFilename removes invalid characters', () => {
        const result = sanitizeFilename('Test: File?');
        assert(!result.includes(':'), 'Should not contain colon');
        assert(!result.includes('?'), 'Should not contain question mark');
    });

    // getChronum tests
    await test('getChronum extracts 10-digit integer from create_time', () => {
        const result = getChronum(1770126827.760625);
        assertEqual(result, 1770126827);
    });

    await test('getChronum handles integer input', () => {
        const result = getChronum(1770126827);
        assertEqual(result, 1770126827);
    });

    await test('getChronum returns null for null input', () => {
        const result = getChronum(null);
        assertEqual(result, null);
    });

    await test('getChronum returns null for undefined input', () => {
        const result = getChronum(undefined);
        assertEqual(result, null);
    });

    await test('getChronum handles string number input', () => {
        const result = getChronum('1770126827.760625');
        assertEqual(result, 1770126827);
    });

    // getShortConversationId tests
    await test('getShortConversationId extracts first 8 characters', () => {
        const result = getShortConversationId('6981fddd-2834-8394-9b08-a9b19891753c');
        assertEqual(result, '6981fddd');
    });

    await test('getShortConversationId returns empty string for null', () => {
        const result = getShortConversationId(null);
        assertEqual(result, '');
    });

    await test('getShortConversationId returns empty string for undefined', () => {
        const result = getShortConversationId(undefined);
        assertEqual(result, '');
    });

    // getChronum edge case tests
    await test('getChronum handles edge cases in frontmatter context', () => {
        // Test with a conversation that has missing create_time
        const conversation = {
            title: 'Test Conversation',
            update_time: 1770126827.760625,
            conversation_id: '6981fddd-2834-8394-9b08-a9b19891753c',
            mapping: {}
        };

        const result = conversationToMarkdown(conversation);
        // Should still generate markdown even without create_time
        assert(result.content.includes('---'), 'Should have frontmatter');
        // chronum should show null when create_time is missing
        assert(result.content.includes('chronum: null'), 'chronum should be null when create_time is missing');
    });

    // formatTruncatedDate tests
    await test('formatTruncatedDate formats timestamp to YYYY-MM-DDTHH:MM', () => {
        const result = formatTruncatedDate(1770126827.760625);
        assertEqual(result, '2026-02-03T13:53');
    });

    await test('formatTruncatedDate removes seconds and Z suffix', () => {
        const result = formatTruncatedDate(1770126827.760625);
        assert(!result.includes(':47'), 'Should not contain seconds');
        assert(!result.endsWith('Z'), 'Should not end with Z');
        assertEqual(result.length, 16, 'Should be exactly 16 characters');
    });

    await test('formatTruncatedDate handles integer timestamps', () => {
        const result = formatTruncatedDate(1770022467);
        assertEqual(result, '2026-02-02T08:54');
    });

    await test('formatTruncatedDate handles string timestamps', () => {
        const result = formatTruncatedDate('1770071387');
        assertEqual(result, '2026-02-02T22:29');
    });

    await test('formatTruncatedDate returns current time for null', () => {
        const result = formatTruncatedDate(null);
        assert(result.length === 16, 'Should return 16-char truncated date');
        assert(result.includes('T'), 'Should contain T separator');
    });

    // Feature #10: Timestamp edge case tests
    await test('formatTruncatedDate handles undefined timestamp gracefully', () => {
        const result = formatTruncatedDate(undefined);
        // Should return a valid truncated format (current time)
        assert(typeof result === 'string', 'Should return a string');
        assert(result.length === 16, 'Should be 16 characters (YYYY-MM-DDTHH:MM)');
        assert(result.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/), 'Should match truncated ISO format');
    });

    await test('formatTruncatedDate handles NaN gracefully', () => {
        const result = formatTruncatedDate(NaN);
        // NaN is falsy so should return current time
        assert(typeof result === 'string', 'Should return a string');
        assert(result.length === 16, 'Should be 16 characters (YYYY-MM-DDTHH:MM)');
        assert(result.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/), 'Should match truncated ISO format');
    });

    await test('formatTruncatedDate handles invalid string gracefully', () => {
        const result = formatTruncatedDate('not-a-date');
        // Invalid string should fallback to current time
        assert(typeof result === 'string', 'Should return a string');
        assert(result.length === 16, 'Should be 16 characters (YYYY-MM-DDTHH:MM)');
        assert(result.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/), 'Should match truncated ISO format');
    });

    // Feature #8: created timestamp uses truncated format
    await test('created timestamp uses truncated format in frontmatter', () => {
        const conversation = {
            title: 'Test Conversation',
            create_time: 1770126827.760625,
            update_time: 1770126833.018922,
            conversation_id: '6981fddd-2834-8394-9b08-a9b19891753c',
            mapping: {}
        };

        const result = conversationToMarkdown(conversation);
        const content = result.content;

        // Check that created uses truncated format (no seconds, no Z)
        assert(content.includes('created: 2026-02-03T13:53'), 'created should use truncated format: 2026-02-03T13:53');
        assert(!content.match(/created: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/), 'created should NOT have seconds');
        assert(!content.includes('created: 2026-02-03T13:53:47'), 'created should NOT include seconds');
    });

    // Feature #9: updated timestamp uses truncated format
    await test('updated timestamp uses truncated format in frontmatter', () => {
        const conversation = {
            title: 'Test Conversation',
            create_time: 1770126827.760625,
            update_time: 1770126833.018922,
            conversation_id: '6981fddd-2834-8394-9b08-a9b19891753c',
            mapping: {}
        };

        const result = conversationToMarkdown(conversation);
        const content = result.content;

        // Check that updated uses truncated format (no seconds, no Z)
        assert(content.includes('updated: 2026-02-03T13:53'), 'updated should use truncated format: 2026-02-03T13:53');
        assert(!content.match(/updated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/), 'updated should NOT have seconds');
        assert(!content.includes('updated: 2026-02-03T13:53:53'), 'updated should NOT include seconds');
    });

    await test('formatTruncatedDate handles zero timestamp', () => {
        const result = formatTruncatedDate(0);
        // 0 is falsy, should return current time (not 1970-01-01)
        assert(typeof result === 'string', 'Should return a string');
        assert(result.length === 16, 'Should be 16 characters (YYYY-MM-DDTHH:MM)');
        assert(result.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/), 'Should match truncated ISO format');
    });

    await test('formatTruncatedDate handles empty string gracefully', () => {
        const result = formatTruncatedDate('');
        // Empty string is falsy, should return current time
        assert(typeof result === 'string', 'Should return a string');
        assert(result.length === 16, 'Should be 16 characters (YYYY-MM-DDTHH:MM)');
        assert(result.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/), 'Should match truncated ISO format');
    });

    // sanitizeProjectTag tests - Feature #11: converts to lowercase
    await test('sanitizeProjectTag converts to lowercase', () => {
        const result = sanitizeProjectTag('English Checking & Tutoring');
        assert(result.startsWith('english'), `Expected result to start with 'english', got: ${result}`);
    });

    await test('sanitizeProjectTag handles mixed case input', () => {
        const result = sanitizeProjectTag('TEST Project NAME');
        assert(!result.match(/[A-Z]/), 'Should not contain any uppercase characters');
        assertEqual(result, 'test-project-name');
    });

    await test('sanitizeProjectTag handles all uppercase input', () => {
        const result = sanitizeProjectTag('ALL CAPS PROJECT');
        assertEqual(result, 'all-caps-project');
    });

    // Feature #12: sanitizeProjectTag transliterates diacritics to ASCII equivalents
    await test('sanitizeProjectTag transliterates diacritics to ASCII equivalents', () => {
        // Test case from feature description: Tëster's Pläýground for Frieñd̄žß
        const result = sanitizeProjectTag("Tëster's Pläýground for Frieñdžß");
        assert(result.includes('tester'), `Expected 'tester' in result, got: ${result}`);
        assert(result.includes('playground'), `Expected 'playground' in result, got: ${result}`);
        // ñ->n, ž->z, ß->ss gives "friendzss"
        assert(result.includes('friendzss'), `Expected 'friendzss' in result, got: ${result}`);
    });

    await test('sanitizeProjectTag handles ä, ö, ü umlaut characters', () => {
        const result = sanitizeProjectTag('Überäöü');
        assertEqual(result, 'uberaou', 'German umlauts should transliterate correctly');
    });

    await test('sanitizeProjectTag handles ß (sharp S)', () => {
        const result = sanitizeProjectTag('Straße');
        assertEqual(result, 'strasse', 'ß should become ss');
    });

    await test('sanitizeProjectTag handles ñ (n with tilde)', () => {
        const result = sanitizeProjectTag('España');
        assertEqual(result, 'espana', 'ñ should become n');
    });

    await test('sanitizeProjectTag handles ž, š, č (Slavic characters)', () => {
        const result = sanitizeProjectTag('Prážský šílenec');
        assert(result.includes('prazsky'), `Expected 'prazsky' in result, got: ${result}`);
        assert(result.includes('silenec'), `Expected 'silenec' in result, got: ${result}`);
    });

    await test('sanitizeProjectTag handles accented vowels á, é, í, ó, ú', () => {
        const result = sanitizeProjectTag('Café résumé');
        assertEqual(result, 'cafe-resume', 'Accented vowels should transliterate correctly');
    });

    // Feature #13: sanitizeProjectTag replaces spaces and apostrophes with hyphens
    await test('sanitizeProjectTag replaces spaces with hyphens', () => {
        const result = sanitizeProjectTag('Hello World Test');
        assertEqual(result, 'hello-world-test', 'Spaces should become hyphens');
    });

    await test('sanitizeProjectTag replaces apostrophes with hyphens', () => {
        const result = sanitizeProjectTag("Tester's Playground");
        assertEqual(result, 'tester-s-playground', 'Apostrophes should become hyphens');
    });

    await test('sanitizeProjectTag handles multiple consecutive spaces', () => {
        const result = sanitizeProjectTag('Hello   World');
        assertEqual(result, 'hello-world', 'Multiple spaces should collapse to single hyphen');
    });

    await test('sanitizeProjectTag handles tab and newline whitespace', () => {
        const result = sanitizeProjectTag("Hello\tWorld\nTest");
        assertEqual(result, 'hello-world-test', 'All whitespace should become hyphens');
    });

    await test('sanitizeProjectTag handles both spaces and apostrophes together', () => {
        const result = sanitizeProjectTag("John's Test Project");
        assertEqual(result, 'john-s-test-project', 'Mixed spaces and apostrophes should work');
    });

    // Feature #14: sanitizeProjectTag removes special characters and collapses hyphens
    await test('sanitizeProjectTag removes special characters &#!,;$£', () => {
        // Test the exact characters mentioned in the feature
        const result = sanitizeProjectTag('test&#!,;$£end');
        assertEqual(result, 'testend', 'All special characters should be removed');
    });

    await test('sanitizeProjectTag collapses multiple hyphens to single', () => {
        const result = sanitizeProjectTag('a---b----c');
        assertEqual(result, 'a-b-c', 'Multiple consecutive hyphens should collapse to single');
    });

    await test('sanitizeProjectTag removes leading hyphens', () => {
        const result = sanitizeProjectTag('---test');
        assertEqual(result, 'test', 'Leading hyphens should be removed');
    });

    await test('sanitizeProjectTag removes trailing hyphens', () => {
        const result = sanitizeProjectTag('test---');
        assertEqual(result, 'test', 'Trailing hyphens should be removed');
    });

    await test('sanitizeProjectTag handles spec example: Tester\'s Playground for &#!,;$ Friendzss', () => {
        const result = sanitizeProjectTag("Tester's Playground for &#!,;$ Friendzss");
        assertEqual(result, 'tester-s-playground-for-friendzss', 'Should match expected output from spec');
    });

    await test('sanitizeProjectTag removes ampersand character', () => {
        const result = sanitizeProjectTag('rock&roll');
        assertEqual(result, 'rockroll', 'Ampersand should be removed');
    });

    await test('sanitizeProjectTag removes hash character', () => {
        const result = sanitizeProjectTag('item#1');
        assertEqual(result, 'item1', 'Hash should be removed');
    });

    await test('sanitizeProjectTag handles combined special chars and spaces creating multiple hyphens', () => {
        // When special chars are between spaces, removal creates consecutive hyphens
        const result = sanitizeProjectTag('hello & world');
        assertEqual(result, 'hello-world', 'Special chars between spaces should not create double hyphens');
    });

    // Feature #15: sanitizeProjectTag produces correct output for test cases
    await test('sanitizeProjectTag: English Checking & Tutoring -> english-checking-tutoring', () => {
        const result = sanitizeProjectTag('English Checking & Tutoring');
        assertEqual(result, 'english-checking-tutoring', 'Should produce exact expected output');
    });

    await test('sanitizeProjectTag: complex diacritics with special chars -> tester-s-playground-for-friendzss', () => {
        // Test: 'Tëster's Pläýground for &#!,;$£ Frieñd̄žß' -> 'tester-s-playground-for-friendzss'
        const result = sanitizeProjectTag("Tëster's Pläýground for &#!,;$£ Frieñd̄žß");
        assertEqual(result, 'tester-s-playground-for-friendzss', 'Should handle complex diacritics and special chars');
    });

    await test('sanitizeProjectTag output contains NO underscores', () => {
        // Test various inputs that might accidentally produce underscores
        const testCases = [
            'Hello World',
            'Test_Project',
            'My_App_Name',
            'English Checking & Tutoring',
            "Tester's Playground for &#!,;$ Friendzss"
        ];

        for (const input of testCases) {
            const result = sanitizeProjectTag(input);
            assert(!result.includes('_'), `Output "${result}" from input "${input}" should not contain underscores`);
        }
    });

    await test('sanitizeProjectTag uses only hyphens as separators (not underscores)', () => {
        const result = sanitizeProjectTag('Multi Word Project Name');
        assert(result.includes('-'), 'Should use hyphens as separators');
        assert(!result.includes('_'), 'Should NOT use underscores');
        assertEqual(result, 'multi-word-project-name');
    });

    // chronum in frontmatter tests
    await test('chronum property appears in frontmatter after model-name', () => {
        // Create a minimal conversation object
        const conversation = {
            title: 'Test Conversation',
            create_time: 1770126827.760625,
            update_time: 1770126827.760625,
            conversation_id: '6981fddd-2834-8394-9b08-a9b19891753c',
            mapping: {}
        };

        const result = conversationToMarkdown(conversation);
        const content = result.content;

        // Check that chronum appears in the frontmatter
        assert(content.includes('chronum: 1770126827'), 'Should include chronum property');

        // Check property order: model-name before chronum before created
        const modelNameIndex = content.indexOf('model-name:');
        const chronumIndex = content.indexOf('chronum:');
        const createdIndex = content.indexOf('created:');

        assert(modelNameIndex > 0, 'model-name should be in frontmatter');
        assert(chronumIndex > 0, 'chronum should be in frontmatter');
        assert(createdIndex > 0, 'created should be in frontmatter');

        assert(chronumIndex > modelNameIndex, 'chronum should come after model-name');
        assert(chronumIndex < createdIndex, 'chronum should come before created');
    });

    // Feature #16: extractBranchingInfo tests
    await test('extractBranchingInfo finds branching metadata in conversation mapping', () => {
        // Load branching conversations from test data
        const testFile = join(projectRoot, 'test-exports-and-logs', '4-branching-conversations_for_mock_API.json');
        const conversations = loadUTF16LEJson(testFile);

        // Find a conversation WITH branching info (conversation index 3 = "Branch · Diacritics and Accents")
        const branchConv = conversations.find(c => c.conversation_id === '6981255a-0c54-8393-9176-98d226ea8c0c');
        assert(branchConv, 'Should find the branch conversation');

        const result = extractBranchingInfo(branchConv);
        assert(result !== null, 'Should find branching info');
        assertEqual(result.parentId, '698065a8-9160-8392-a810-0ae50700979b', 'Should extract correct parent ID');
        assertEqual(result.parentTitle, 'Diacritics and Accents', 'Should extract correct parent title');
    });

    await test('extractBranchingInfo returns null for conversation without parent', () => {
        // Load branching conversations from test data
        const testFile = join(projectRoot, 'test-exports-and-logs', '4-branching-conversations_for_mock_API.json');
        const conversations = loadUTF16LEJson(testFile);

        // Find the root conversation (no branching info) - "Diacritics and Accents"
        const rootConv = conversations.find(c => c.conversation_id === '698065a8-9160-8392-a810-0ae50700979b');
        assert(rootConv, 'Should find the root conversation');

        const result = extractBranchingInfo(rootConv);
        assertEqual(result, null, 'Should return null for conversation without branching info');
    });

    await test('extractBranchingInfo returns null for null conversation', () => {
        const result = extractBranchingInfo(null);
        assertEqual(result, null, 'Should return null for null input');
    });

    await test('extractBranchingInfo returns null for conversation without mapping', () => {
        const result = extractBranchingInfo({ title: 'Test', conversation_id: '123' });
        assertEqual(result, null, 'Should return null when mapping is missing');
    });

    // Feature #19: generateFilename tests - Parent link uses same filename generation as actual files
    await test('generateFilename combines sanitized title with short conversation ID', () => {
        const result = generateFilename('Diacritics and Accents', '698065a8-9160-8392-a810-0ae50700979b');
        assertEqual(result, 'Diacritics_and_Accents_698065a8', 'Should match expected filename format');
    });

    await test('generateFilename handles title: Unusual Adjective', () => {
        const result = generateFilename('Unusual Adjective', '6981fddd-2834-8394-9b08-a9b19891753c');
        assertEqual(result, 'Unusual_Adjective_6981fddd', 'Should produce correct filename');
    });

    await test('generateFilename handles title with special characters', () => {
        const result = generateFilename('Branch · Diacritics and Accents', '6981255a-0c54-8393-9176-98d226ea8c0c');
        assertEqual(result, 'Branch_·_Diacritics_and_Accents_6981255a', 'Should handle special characters in title');
    });

    await test('generateFilename returns sanitized title when conversationId is missing', () => {
        const result = generateFilename('Test Title', null);
        assertEqual(result, 'Test_Title', 'Should return just sanitized title without ID');
    });

    await test('generateFilename returns sanitized title when conversationId is empty', () => {
        const result = generateFilename('Test Title', '');
        assertEqual(result, 'Test_Title', 'Should return just sanitized title without ID');
    });

    // Verify that file output uses generateFilename (consistency test)
    await test('conversationToMarkdown filename includes short conversation ID', () => {
        const conversation = {
            title: 'Diacritics and Accents',
            create_time: 1770022467,
            update_time: 1770022712.607,
            conversation_id: '698065a8-9160-8392-a810-0ae50700979b',
            mapping: {}
        };

        const result = conversationToMarkdown(conversation);
        // Filename should include the short ID
        assert(result.filename.includes('698065a8'), 'Filename should include short conversation ID');
        assertEqual(result.filename, 'Diacritics_and_Accents_698065a8.md', 'Filename should match expected format');
    });

    // Feature #23: Verify exact output filename from spec
    await test('output filename: Unusual_Adjective_6981fddd.md (spec requirement)', () => {
        const conversation = {
            title: 'Unusual Adjective',
            create_time: 1770126827.760625,
            update_time: 1770126833.018922,
            conversation_id: '6981fddd-2834-8394-9b08-a9b19891753c',
            mapping: {}
        };

        const result = conversationToMarkdown(conversation);
        assertEqual(result.filename, 'Unusual_Adjective_6981fddd.md',
            'Output filename must match spec example exactly');
    });

    // Test that project conversations also use generateFilename
    await test('conversationToMarkdown with project uses generateFilename', () => {
        const conversation = {
            title: 'Diacritics and Accents',
            create_time: 1770022467,
            update_time: 1770022712.607,
            conversation_id: '698065a8-9160-8392-a810-0ae50700979b',
            _projectId: 'g-p-678ce30e20dc8191ab325e517603d768',
            _projectName: 'English Checking & Tutoring',
            mapping: {}
        };

        const result = conversationToMarkdown(conversation);
        // Should have project folder + filename with ID
        assertEqual(result.filename, 'English_Checking_&_Tutoring/Diacritics_and_Accents_698065a8.md',
            'Filename with project should include short conversation ID');
    });

    // Test that parent link uses same filename format as actual file
    await test('parent link format matches actual filename format', () => {
        // The expected parent link for Branch conversation
        const parentTitle = 'Diacritics and Accents';
        const parentId = '698065a8-9160-8392-a810-0ae50700979b';

        // Generate what the parent link SHOULD be
        const expectedParentLink = generateFilename(parentTitle, parentId);
        assertEqual(expectedParentLink, 'Diacritics_and_Accents_698065a8',
            'Parent link should use generateFilename format');

        // Generate the actual filename for comparison
        const conversation = {
            title: parentTitle,
            create_time: 1770022467,
            update_time: 1770022712.607,
            conversation_id: parentId,
            mapping: {}
        };
        const result = conversationToMarkdown(conversation);

        // Extract just the filename (without .md extension)
        const actualFilenameBase = result.filename.replace('.md', '');
        assertEqual(actualFilenameBase, expectedParentLink,
            'Parent link and actual filename should be identical');
    });

    // Feature #17: Parent property shows empty list item when no parent exists
    await test('parent property shows empty list item when no parent exists', () => {
        const conversation = {
            title: 'Unusual Adjective',
            create_time: 1770126827.760625,
            update_time: 1770126833.018922,
            conversation_id: '6981fddd-2834-8394-9b08-a9b19891753c',
            mapping: {}  // No branching info
        };

        const result = conversationToMarkdown(conversation);
        const content = result.content;

        // Should have parent property with empty list item
        assert(content.includes('parent:\n  - '), 'Should have parent property with empty list item');
        // Should NOT have any internal link
        assert(!content.includes('parent:\n  - "[['), 'Should NOT have a parent link when no parent exists');
    });

    await test('parent property format matches expected: parent: newline followed by space-space-hyphen-space', () => {
        const conversation = {
            title: 'Test',
            create_time: 1770126827,
            update_time: 1770126827,
            conversation_id: '6981fddd-2834-8394-9b08-a9b19891753c',
            mapping: {}
        };

        const result = conversationToMarkdown(conversation);
        const content = result.content;

        // Verify the exact format: 'parent:' followed by newline, then '  - ' (two spaces, hyphen, space)
        const parentMatch = content.match(/parent:\n {2}- /);
        assert(parentMatch, 'Parent property should have exact YAML list format');
    });

    await test('parent property appears after aliases in frontmatter', () => {
        const conversation = {
            title: 'Test',
            create_time: 1770126827,
            update_time: 1770126827,
            conversation_id: '6981fddd-2834-8394-9b08-a9b19891753c',
            mapping: {}
        };

        const result = conversationToMarkdown(conversation);
        const content = result.content;

        const aliasesIndex = content.indexOf('aliases:');
        const parentIndex = content.indexOf('parent:');
        const typeIndex = content.indexOf('type:');

        assert(aliasesIndex > 0, 'aliases should be in frontmatter');
        assert(parentIndex > 0, 'parent should be in frontmatter');
        assert(typeIndex > 0, 'type should be in frontmatter');

        assert(parentIndex > aliasesIndex, 'parent should come after aliases');
        assert(parentIndex < typeIndex, 'parent should come before type');
    });

    // Feature #18: Parent property shows Obsidian internal link when parent exists
    await test('parent property shows Obsidian internal link when parent exists', () => {
        // Load branching conversations from test data
        const testFile = join(projectRoot, 'test-exports-and-logs', '4-branching-conversations_for_mock_API.json');
        const conversations = loadUTF16LEJson(testFile);

        // Find the branch conversation (has parent: "Diacritics and Accents")
        const branchConv = conversations.find(c => c.conversation_id === '6981255a-0c54-8393-9176-98d226ea8c0c');
        assert(branchConv, 'Should find the branch conversation');

        const result = conversationToMarkdown(branchConv);
        const content = result.content;

        // Should have parent property with internal link
        assert(content.includes('parent:\n  - "[[Diacritics_and_Accents_698065a8]]"'),
            'Should have parent property with Obsidian internal link');
    });

    await test('parent internal link format is [[filename_without_extension]]', () => {
        // Create a conversation with mock branching info
        const conversation = {
            title: 'Branch Conversation',
            create_time: 1770071387,
            update_time: 1770071426.426,
            conversation_id: '6981255a-0c54-8393-9176-98d226ea8c0c',
            mapping: {
                'test-node': {
                    message: {
                        metadata: {
                            branching_from_conversation_id: '698065a8-9160-8392-a810-0ae50700979b',
                            branching_from_conversation_title: 'Diacritics and Accents'
                        }
                    }
                }
            }
        };

        const result = conversationToMarkdown(conversation);
        const content = result.content;

        // Parent link should use [[]] format with filename (no .md extension)
        assert(content.includes('"[[Diacritics_and_Accents_698065a8]]"'),
            'Parent link should be in [[filename]] format without .md extension');
        assert(!content.includes('.md]]'), 'Parent link should NOT include .md extension');
    });

    await test('parent property format matches expected output from spec', () => {
        // Load branching conversations from test data
        const testFile = join(projectRoot, 'test-exports-and-logs', '4-branching-conversations_for_mock_API.json');
        const conversations = loadUTF16LEJson(testFile);

        // Find the branch conversation
        const branchConv = conversations.find(c => c.conversation_id === '6981255a-0c54-8393-9176-98d226ea8c0c');
        assert(branchConv, 'Should find the branch conversation');

        const result = conversationToMarkdown(branchConv);
        const content = result.content;

        // Verify the exact YAML format with indentation
        const expectedParentFormat = 'parent:\n  - "[[Diacritics_and_Accents_698065a8]]"';
        assert(content.includes(expectedParentFormat),
            'Parent property should match exact YAML list format with internal link');
    });
}

/**
 * Run integration tests with actual mock data
 */
async function runIntegrationTests() {
    console.log('\n=== Integration Tests ===\n');

    // Test with 1-conversation mock data
    await test('processes single conversation JSON', () => {
        const testFile = join(projectRoot, 'test-exports-and-logs', '1-conversation_for_mock_API.json');
        const conversations = loadUTF16LEJson(testFile);

        assert(conversations.length === 1, 'Should have 1 conversation');

        const conv = conversations[0];
        assert(conv.conversation_id, 'Should have conversation_id');
        assert(conv.mapping, 'Should have mapping');
    });

    // Test with 4-branching mock data
    await test('loads branching conversations JSON', () => {
        const testFile = join(projectRoot, 'test-exports-and-logs', '4-branching-conversations_for_mock_API.json');
        const conversations = loadUTF16LEJson(testFile);

        assert(Array.isArray(conversations), 'Should be an array');
        assert(conversations.length >= 1, 'Should have at least 1 conversation');
    });
}

/**
 * Main test runner
 */
async function main() {
    console.log('GPT Exporter - Markdown Export Tests');
    console.log('====================================');

    const args = process.argv.slice(2);

    if (args.includes('--help')) {
        console.log(`
Usage: node test/runner.mjs [options]

Options:
  --help          Show this help message
  --file <path>   Test a specific JSON file
  --infra         Run only infrastructure tests
  --helpers       Run only helper function tests
  --integration   Run only integration tests
        `);
        process.exit(0);
    }

    // Run test suites based on args
    if (args.includes('--infra') || args.length === 0) {
        await runInfrastructureTests();
    }

    if (args.includes('--helpers') || args.length === 0) {
        await runHelperTests();
    }

    if (args.includes('--integration') || args.length === 0) {
        await runIntegrationTests();
    }

    // Summary
    console.log('\n====================================');
    console.log(`Results: ${results.passed} passed, ${results.failed} failed`);

    if (results.failed > 0) {
        console.log('\nFailed tests:');
        for (const { name, error } of results.errors) {
            console.log(`  - ${name}: ${error}`);
        }
        process.exit(1);
    } else {
        console.log('\nAll tests passed!');
        process.exit(0);
    }
}

// Export for use as module
export {
    loadUTF16LEJson,
    compareMarkdown,
    test,
    assert,
    assertEqual
};

// Run if executed directly
main().catch(console.error);
