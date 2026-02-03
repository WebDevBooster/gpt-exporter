/**
 * Verify ES module imports from export/markdown.js work correctly
 */
import {
    sanitizeFilename,
    conversationToMarkdown,
    extractMessages,
    formatDate
} from '../export/markdown.js';

console.log('Verifying ES module imports from export/markdown.js:\n');

let allPassed = true;

// Test sanitizeFilename
if (typeof sanitizeFilename === 'function') {
    const result = sanitizeFilename('Test File Name');
    if (result === 'Test_File_Name') {
        console.log('  ✓ sanitizeFilename: function imported and works correctly');
    } else {
        console.log('  ✗ sanitizeFilename: unexpected result:', result);
        allPassed = false;
    }
} else {
    console.log('  ✗ sanitizeFilename: not a function');
    allPassed = false;
}

// Test conversationToMarkdown
if (typeof conversationToMarkdown === 'function') {
    console.log('  ✓ conversationToMarkdown: function imported');
} else {
    console.log('  ✗ conversationToMarkdown: not a function');
    allPassed = false;
}

// Test extractMessages
if (typeof extractMessages === 'function') {
    console.log('  ✓ extractMessages: function imported');
} else {
    console.log('  ✗ extractMessages: not a function');
    allPassed = false;
}

// Test formatDate
if (typeof formatDate === 'function') {
    const result = formatDate(1770126827.760625);
    if (result && result.includes('2026')) {
        console.log('  ✓ formatDate: function imported and works correctly');
    } else {
        console.log('  ✗ formatDate: unexpected result:', result);
        allPassed = false;
    }
} else {
    console.log('  ✗ formatDate: not a function');
    allPassed = false;
}

console.log('\n' + (allPassed ? 'All ES module imports verified!' : 'Some imports failed.'));
process.exit(allPassed ? 0 : 1);
