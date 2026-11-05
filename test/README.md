# GPT Exporter Test Suite

This test suite validates the markdown export functionality for the GPT Exporter Chrome extension, specifically the 8 frontmatter modifications being implemented.

## Quick Start

```bash
# Run all tests (formatting fixtures plus download regressions)
npm test

# Run download regressions without private formatting fixtures
npm run test:downloads

# Or use the init script
./init.sh
```

## Test Approach

The formatting runner uses fixture data and expected files. Download regressions exercise the production background workflows and download manager with controlled Chrome APIs:

1. **Mock API Testing** - Using JSON files that contain real ChatGPT API response structures
2. **Output Comparison** - Comparing generated .md files against expected outputs in `test-vault/`
3. **Unit Testing** - Testing individual helper functions

## Download Completion Tests

`npm run test:downloads` uses synthetic conversations. These cover
Current, All and New/Updated exports; pending, interrupted and completed saves;
incremental retries; multiple formats; ZIPs; cancellation; early completion;
failed starts; query failures and deadlines. Export history must remain unchanged
until every required output has completed. These tests require no ChatGPT login
or private fixture directories.

The automated API fixtures do not replace browser checks. A disposable Chrome
profile can load the extension and exercise the same manager against a local
HTTP server for successful transfers, cancellation and broken connections.

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


## Export recovery (2.3.0)

Run `npm ci` once, then `npm test`. The dependency `fake-indexeddb` exercises the
actual transactional job store without contacting ChatGPT. `npm run test:recovery`
runs the recovery, structured content-error and normal-popup visibility checks.

The regression scenario fetches 216 of 2,515 conversations, injects a 429 at 217,
recreates the worker's runner and store, verifies that an early resume issues no
requests, then completes every conversation without refetching the first 216.
Other cases cover exponential delays, both Retry-After formats, persistent
throttling, isolated successes, cached discovery pages, account changes, output
failures, checkpoint failures, alarm recovery and pause/resume controls.

Popup tests verify visible warnings, saved counts, retry times, persistent errors
and restoration of the event log when reopening. Existing download tests still
verify that Chrome must finish every requested format before history advances.

For a manual browser check, reload the unpacked extension and its ChatGPT tab.
Start an export, close the popup, reopen it and check that status is restored.
Pause and resume to verify the fetched count stays intact. Do not use a live
account to deliberately provoke rate limits; the automated tests simulate them.


## Export All and cancellation (2.3.2)

The Export All regression runs 2,515 conversations through the production
background dispatcher, paginated listing, IndexedDB store and normal 60-second
worker slices. It recreates the worker between slices, injects a 429 at item 217
and completes the entire export through scheduled alarms. It verifies that the
first 216 are not refetched, listing pages are reused and visible listing progress
never moves backwards.

Cancellation checks cover a hanging session lookup, a hanging listing request,
a hanging conversation fetch, cooldown, pause, active downloads and a download
start that returns only after another export has begun. Cancel ends the job and
allows a fresh Export All; Pause retains a resumable job. Completed output history
must not advance because of a cancelled job's late response.
