/**
 * Verify the comparison utility works correctly
 */
import { compareMarkdown } from './runner.mjs';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

console.log('Verifying output comparison utility:\n');

let allPassed = true;

// Test 1: Nonexistent file
const result1 = compareMarkdown('foo\nbar', 'nonexistent.md');
if (!result1.pass && result1.diff.includes('Expected file not found')) {
    console.log('  ✓ Test 1: Correctly detects nonexistent file');
} else {
    console.log('  ✗ Test 1: Failed to detect nonexistent file');
    allPassed = false;
}

// Test 2: Matching content
const expectedPath = join(projectRoot, 'test-vault', 'English_Checking_&_Tutoring', 'Diacritics_and_Accents_698065a8.md');
const expectedContent = readFileSync(expectedPath, 'utf8');
const result2 = compareMarkdown(expectedContent, expectedPath);
if (result2.pass && result2.diff === null) {
    console.log('  ✓ Test 2: Correctly passes when content matches');
} else {
    console.log('  ✗ Test 2: Should pass when content matches');
    console.log('    Diff:', result2.diff);
    allPassed = false;
}

// Test 3: Different content
const modifiedContent = expectedContent.replace('Diacritics', 'MODIFIED_STRING');
const result3 = compareMarkdown(modifiedContent, expectedPath);
if (!result3.pass && result3.diff && result3.diff.includes('Line')) {
    console.log('  ✓ Test 3: Correctly detects differences');
} else {
    console.log('  ✗ Test 3: Failed to detect differences');
    allPassed = false;
}

// Test 4: Line endings normalization
const withCRLF = expectedContent.replace(/\n/g, '\r\n');
const result4 = compareMarkdown(withCRLF, expectedPath);
if (result4.pass) {
    console.log('  ✓ Test 4: Correctly normalizes CRLF line endings');
} else {
    console.log('  ✗ Test 4: Failed to normalize line endings');
    allPassed = false;
}

// Test 5: Reports specific line differences
const result5 = compareMarkdown('line1\nline2\nLINE3', join(projectRoot, 'test-vault', 'English_Checking_&_Tutoring', 'Diacritics_and_Accents_698065a8.md'));
if (!result5.pass && result5.diff && result5.diff.includes('Expected:')) {
    console.log('  ✓ Test 5: Reports detailed line differences');
} else {
    console.log('  ✗ Test 5: Should report detailed differences');
    allPassed = false;
}

console.log('\n' + (allPassed ? 'All comparison utility tests passed!' : 'Some tests failed.'));
process.exit(allPassed ? 0 : 1);
