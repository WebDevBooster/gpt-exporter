# GPT Exporter Test Suite

This test suite validates the markdown export functionality for the GPT Exporter Chrome extension, specifically the 8 frontmatter modifications being implemented.

## Quick Start

```bash
# Run all tests
node test/runner.mjs

# Or use the init script
./init.sh
```

## Test Approach

Since coding agents cannot install or run Chrome extensions directly, testing is done via:

1. **Mock API Testing** - Using JSON files that contain real ChatGPT API response structures
2. **Output Comparison** - Comparing generated .md files against expected outputs in `test-vault/`
3. **Unit Testing** - Testing individual helper functions

## Mock Data Files

Located in `test-exports-and-logs/`:

| File | Description |
|------|-------------|
| `1-conversation_for_mock_API.json` | Single conversation in a project |
| `3-conversations_for_mock_API.json` | Multiple conversations |
| `4-branching-conversations_for_mock_API.json` | Parent-child conversation relationships |
| `12-conversations_for_mock_API.json` | Multiple conversations with various edge cases |
| `333-conversations_for_mock_API.json` | Large dataset (333 conversations) for bulk/performance testing |

**Note:** The test runner auto-detects encoding and supports both UTF-16LE (with BOM) and UTF-8.

## Expected Output Files

Located in `test-vault/`:

| File | Test Purpose |
|------|--------------|
| `Tëster's_Pläýground_.../Unusual_Adjective_6981fddd.md` | Project tag sanitization, no parent |
| `English_Checking_&_Tutoring/Diacritics_and_Accents_698065a8.md` | Parent conversation (no branching link) |
| `English_Checking_&_Tutoring/Branch_·_Diacritics_and_Accents_6981255a.md` | Branching conversation with parent link |

These files represent the "source of truth" for what the export should produce.

## Test Categories

### Infrastructure Tests (`--infra`)
- UTF-16LE JSON file loading
- ES module imports from `export/markdown.js`
- Output comparison utility

### Helper Function Tests (`--helpers`)
- `getShortConversationId()` - Extract 8-char ID from conversation_id
- `getChronum()` - Extract 10-digit integer from create_time
- `formatTruncatedDate()` - Format timestamp to YYYY-MM-DDTHH:MM
- `sanitizeProjectTag()` - Convert project name to valid Obsidian tag
- `generateFilename()` - Generate filename with ID suffix
- `extractBranchingInfo()` - Find parent conversation metadata

### Integration Tests (`--integration`)
- End-to-end tests comparing full generated output against expected files

## Running Specific Tests

```bash
# Infrastructure only
node test/runner.mjs --infra

# Helper functions only
node test/runner.mjs --helpers

# Integration tests only
node test/runner.mjs --integration
```

## Adding New Test Cases

### Unit Tests

Add new tests in `test/runner.mjs` using the test helper:

```javascript
await test('your test description', () => {
    const result = yourFunction(input);
    assertEqual(result, expectedOutput, 'Optional error message');
});
```

### Mock Data

To add a new mock conversation:
1. Export the conversation JSON from ChatGPT API
2. Save to `test-exports-and-logs/` (UTF-16LE encoding with BOM)
3. Add the expected output to `test-vault/` in the appropriate folder

### Expected Output

To add a new expected output:
1. Create the expected .md file manually with correct frontmatter
2. Place in `test-vault/` following the folder structure (project folder / filename_8charid.md)
3. Add a corresponding integration test

## Frontmatter Format

The expected frontmatter format after all modifications:

```yaml
---
title: "Conversation Title"
aliases:
  - "6981fddd"
  - "Conversation Title 6981fddd"
parent:
  - "[[Parent_Filename_abcd1234]]"  # or empty: -
type: gpt-chat
model-name: gpt-5-2-thinking
chronum: 1770126827
created: 2026-02-03T13:53
updated: 2026-02-03T13:53
tags:
  - gpt-chat
  - project-tag-sanitized
project: "Original Project Name"
source: https://chatgpt.com/g/g-p-id/c/conversation-id
---
```

## Property Order

1. title
2. aliases (YAML list)
3. parent (YAML list with Obsidian link or empty)
4. type
5. model-name
6. chronum
7. created
8. updated
9. tags (YAML list)
10. project (if applicable)
11. source

## Notes for Coding Agents

When implementing the modifications:

1. **Primary file to modify:** `export/markdown.js`
2. **Single filename function:** Use ONE function (`generateFilename`) for both actual .md filenames AND internal parent links
3. **Branching info location:** Look in `conversation.mapping[nodeId].message.metadata` for `branching_from_conversation_id` and `branching_from_conversation_title`
4. **Tag sanitization:** NO underscores allowed in tags, only lowercase letters/numbers/hyphens
5. **Test against expected outputs:** The .md files in `test-vault/` are the source of truth
