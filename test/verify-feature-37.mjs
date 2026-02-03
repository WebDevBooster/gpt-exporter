/**
 * Feature #37 verification script
 * Tests callout formatting for user questions
 */

import { conversationToMarkdown, formatUserContentAsCallout } from '../export/markdown.js';

// Test 1: Simple text formatting
console.log('=== Test 1: Simple text ===');
const simple = formatUserContentAsCallout('Hello, world!');
console.log('Input: "Hello, world!"');
console.log('Output:', JSON.stringify(simple));
console.log('Expected: "> Hello, world!"');
console.log('Pass:', simple === '> Hello, world!');
console.log();

// Test 2: Multiline formatting
console.log('=== Test 2: Multiline ===');
const multiline = formatUserContentAsCallout('Line 1\nLine 2\nLine 3');
console.log('Output:', JSON.stringify(multiline));
console.log('Expected: "> Line 1\\n> Line 2\\n> Line 3"');
console.log('Pass:', multiline === '> Line 1\n> Line 2\n> Line 3');
console.log();

// Test 3: Code fence handling
console.log('=== Test 3: Code fence ===');
const codeFence = formatUserContentAsCallout('Text\n```\ncode\n```\nMore');
console.log('Output:', JSON.stringify(codeFence));
console.log('Expected: "> Text\\n```\\ncode\\n```\\n> More"');
console.log('Pass:', codeFence === '> Text\n```\ncode\n```\n> More');
console.log();

// Test 4: Full conversation
console.log('=== Test 4: Full conversation ===');
const conv = {
    title: 'Test Callout',
    conversation_id: '12345678-test',
    create_time: 1770126827,
    update_time: 1770126827,
    mapping: {
        'root': { id: 'root', children: ['msg1'] },
        'msg1': {
            id: 'msg1',
            parent: 'root',
            children: ['msg2'],
            message: {
                author: { role: 'user' },
                content: { content_type: 'text', parts: ['This is a test\nwith multiple lines'] }
            }
        },
        'msg2': {
            id: 'msg2',
            parent: 'msg1',
            message: {
                author: { role: 'assistant' },
                content: { content_type: 'text', parts: ['Response here'] }
            }
        }
    },
    current_node: 'msg2'
};

const result = conversationToMarkdown(conv);
console.log('Generated markdown (message section):');
const messageSection = result.content.split('# Test Callout')[1];
console.log(messageSection);
console.log();
console.log('Has > [!me:]:', result.content.includes('> [!me:]'));
console.log('Has > This is a test:', result.content.includes('> This is a test'));
console.log('Has #### ChatGPT:', result.content.includes('#### ChatGPT:'));
