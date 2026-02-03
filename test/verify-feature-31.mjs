/**
 * Verify Feature #31: model property is removed from frontmatter
 *
 * The 'model:' property (display name like 'GPT-4') must be removed from frontmatter.
 * Only 'model-name:' (the slug) should remain.
 */

import { conversationToMarkdown } from '../export/markdown.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// Test 1: Verify generated frontmatter does NOT have 'model:' property
console.log('=== Feature #31 Verification ===\n');

const conversation = {
    title: 'Test Conversation',
    create_time: 1770126827.760625,
    update_time: 1770126833.018922,
    conversation_id: '6981fddd-2834-8394-9b08-a9b19891753c',
    mapping: {
        'node1': {
            message: {
                metadata: {
                    model_slug: 'gpt-4'
                }
            }
        }
    }
};

const result = conversationToMarkdown(conversation);
const frontmatter = result.content.split('---')[1];

console.log('Generated frontmatter:');
console.log('---' + frontmatter + '---\n');

// Check for model: (with colon and space, at start of line)
const hasModelProperty = /\nmodel: /.test(frontmatter);
const hasModelNameProperty = frontmatter.includes('model-name:');

console.log('Test 1: model property should NOT exist');
console.log(`  Has 'model:' property: ${hasModelProperty}`);
console.log(`  Result: ${hasModelProperty ? 'FAIL - model property found!' : 'PASS'}`);

console.log('\nTest 2: model-name property should exist');
console.log(`  Has 'model-name:' property: ${hasModelNameProperty}`);
console.log(`  Result: ${hasModelNameProperty ? 'PASS' : 'FAIL - model-name property missing!'}`);

// Test 3: Verify against expected test-vault output
console.log('\nTest 3: Verify expected test-vault files also have no model: property');

const testVaultFiles = [
    join(projectRoot, 'test-vault', 'English_Checking_&_Tutoring', 'Diacritics_and_Accents_698065a8.md'),
    join(projectRoot, 'test-vault', 'English_Checking_&_Tutoring', 'Branch_·_Diacritics_and_Accents_6981255a.md')
];

let allPass = true;
for (const file of testVaultFiles) {
    try {
        const content = readFileSync(file, 'utf8');
        const hasModel = /\nmodel: /.test(content);
        const hasModelName = content.includes('model-name:');

        console.log(`  ${file.split('/').pop()}:`);
        console.log(`    Has 'model:': ${hasModel} ${hasModel ? '(FAIL)' : '(OK)'}`);
        console.log(`    Has 'model-name:': ${hasModelName} ${hasModelName ? '(OK)' : '(FAIL)'}`);

        if (hasModel || !hasModelName) allPass = false;
    } catch (e) {
        console.log(`  ${file.split('/').pop()}: Could not read - ${e.message}`);
    }
}

console.log('\n=== Summary ===');
if (!hasModelProperty && hasModelNameProperty && allPass) {
    console.log('Feature #31 PASSED: model property is correctly removed from frontmatter');
    process.exit(0);
} else {
    console.log('Feature #31 FAILED: Issues found with model property handling');
    process.exit(1);
}
