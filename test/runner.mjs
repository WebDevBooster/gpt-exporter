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
    getChronum
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
