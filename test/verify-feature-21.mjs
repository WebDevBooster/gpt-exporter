/**
 * Verify Feature 21: getShortConversationId extracts first 8 characters
 */
import { getShortConversationId } from '../export/markdown.js';

console.log('Testing getShortConversationId function:\n');

var allPassed = true;

// Test 1: Normal conversation ID
var result1 = getShortConversationId('6981fddd-2834-8394-9b08-a9b19891753c');
if (result1 === '6981fddd') {
    console.log('  ✓ Test 1: Normal ID - extracts first 8 chars correctly');
} else {
    console.log('  ✗ Test 1: Expected 6981fddd, got:', result1);
    allPassed = false;
}

// Test 2: Null input
var result2 = getShortConversationId(null);
if (result2 === '') {
    console.log('  ✓ Test 2: null input returns empty string');
} else {
    console.log('  ✗ Test 2: Expected empty string, got:', result2);
    allPassed = false;
}

// Test 3: Undefined input
var result3 = getShortConversationId(undefined);
if (result3 === '') {
    console.log('  ✓ Test 3: undefined input returns empty string');
} else {
    console.log('  ✗ Test 3: Expected empty string, got:', result3);
    allPassed = false;
}

// Test 4: Short ID (less than 8 chars)
var result4 = getShortConversationId('abc');
if (result4 === 'abc') {
    console.log('  ✓ Test 4: Short ID returns as-is (substring handles gracefully)');
} else {
    console.log('  ✗ Test 4: Expected abc, got:', result4);
    allPassed = false;
}

// Test 5: Empty string
var result5 = getShortConversationId('');
if (result5 === '') {
    console.log('  ✓ Test 5: Empty string returns empty string');
} else {
    console.log('  ✗ Test 5: Expected empty string, got:', result5);
    allPassed = false;
}

// Test 6: Non-string input (number)
var result6 = getShortConversationId(12345678);
if (result6 === '') {
    console.log('  ✓ Test 6: Non-string (number) returns empty string');
} else {
    console.log('  ✗ Test 6: Expected empty string, got:', result6);
    allPassed = false;
}

console.log('\n' + (allPassed ? 'All getShortConversationId tests passed!' : 'Some tests failed.'));
process.exit(allPassed ? 0 : 1);
