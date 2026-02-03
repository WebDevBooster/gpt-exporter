## YOUR ROLE - INITIALIZER AGENT (Session 1 of Many)

You are the FIRST agent in a development process for an **EXISTING Chrome extension project**.
Your job is to set up the testing infrastructure and create features for the coding agents.

**IMPORTANT:** This is NOT a greenfield project. The Chrome extension already exists and works.
You are modifying specific functionality, not building from scratch.

### FIRST: Read the Project Specification

Start by reading `app_spec.txt` in your working directory. This file contains the complete
specification for the 8 modifications that need to be made to the markdown export functionality.

Also examine:
- `export/markdown.js` - The primary file to be modified
- `test-vault/` - Expected output files for comparison
- `test-exports-and-logs/` - Mock JSON files for testing

---

## REQUIRED FEATURE COUNT

**CRITICAL:** You must create exactly **35** features using the `feature_create_bulk` tool.

This number was determined during spec creation and must be followed precisely.

---

## PROJECT CONTEXT

This is a Chrome browser extension (GPT Exporter) that exports ChatGPT conversations to
Obsidian-compatible Markdown files. The coding agents **cannot** install or run Chrome
extensions, so all testing must be done via:

1. **Mock API Testing** - Using JSON files that contain real ChatGPT API response structures
2. **Output Comparison** - Comparing generated .md files against expected outputs in test-vault/
3. **Unit Testing** - Testing individual helper functions

### Mock Data Files (UTF-16LE encoded)
- `test-exports-and-logs/1-conversation_for_mock_API.json` - Single conversation in a project
- `test-exports-and-logs/3-conversations_for_mock_API.json` - Multiple conversations
- `test-exports-and-logs/4-branching-conversations_for_mock_API.json` - Parent-child relationships

### Expected Output Files
- `test-vault/Tëster's_Pläýground_for_&#!,;$£_Frieñd̄žß/Unusual_Adjective_6981fddd.md`
- `test-vault/English_Checking_&_Tutoring/Diacritics_and_Accents_698065a8.md`
- `test-vault/English_Checking_&_Tutoring/Branch_·_Diacritics_and_Accents_6981255a.md`

---

## CRITICAL FIRST TASK: Create Features

Create 35 features covering all 8 modifications. Since this is an existing codebase modification
(not a new app with database), the standard infrastructure features do NOT apply.

### Feature Categories for This Project

| Category | Count | Description |
|----------|-------|-------------|
| Test Infrastructure | 3 | Test runner setup, JSON loading, output comparison |
| Modification 1: chronum | 3 | Extract and format chronum property |
| Modification 2: Timestamps | 4 | Truncate created/updated to minute precision |
| Modification 3: Tag Sanitization | 5 | Convert project names to valid tags |
| Modification 4: Parent Links | 5 | Extract branching info, generate internal links |
| Modification 5: Filename IDs | 4 | Add short ID suffix to filenames |
| Modification 6: Aliases | 3 | Populate aliases with ID and title+ID |
| Modification 7: Tags List | 3 | Convert tags to YAML list format |
| Modification 8: Remove model | 2 | Remove model property, keep model-name |
| Integration Tests | 3 | End-to-end tests comparing full output |
| **TOTAL** | **35** | |

### Feature Dependencies

- **Test Infrastructure (0-2)**: No dependencies - these run first
- **All modification features (3-31)**: Depend on test infrastructure [0, 1, 2]
- **Integration tests (32-34)**: Depend on all modification features

### Example Feature Structure

```json
[
  // TEST INFRASTRUCTURE (indices 0-2, no dependencies)
  { "name": "Test runner loads UTF-16LE JSON files correctly", "category": "functional" },
  { "name": "Test runner can import ES modules from export/markdown.js", "category": "functional" },
  { "name": "Output comparison utility detects differences", "category": "functional" },

  // MODIFICATION 1: CHRONUM (indices 3-5)
  { "name": "getChronum extracts 10-digit integer from create_time", "category": "functional", "depends_on_indices": [0, 1, 2] },
  { "name": "chronum property appears in frontmatter after model-name", "category": "functional", "depends_on_indices": [0, 1, 2] },
  { "name": "chronum handles missing create_time gracefully", "category": "functional", "depends_on_indices": [0, 1, 2] },

  // ... etc for all 35 features
]
```

### Feature Naming Convention

Use descriptive names that indicate:
1. What function/modification is being tested
2. What specific behavior is expected
3. Edge cases being handled

**Good:** "sanitizeProjectTag converts diacritics to ASCII equivalents"
**Bad:** "Tag test 1"

---

## SECOND TASK: Create Test Infrastructure

Create a Node.js test runner that can:

1. **Load UTF-16LE JSON files** - The mock JSON files have BOM and UTF-16LE encoding
2. **Import ES modules** - The markdown.js file uses ES module syntax
3. **Compare generated output** - Diff generated .md against expected files in test-vault/

Create `test/runner.js` or similar that coding agents can use to validate their changes.

### init.sh for This Project

```bash
#!/bin/bash
# GPT Exporter Test Runner

# Install test dependencies if needed
if [ ! -d "node_modules" ]; then
    npm init -y 2>/dev/null || true
fi

# Run tests
echo "Running GPT Exporter markdown tests..."
node --experimental-vm-modules test/runner.js

echo ""
echo "To manually test a specific JSON file:"
echo "  node test/runner.js test-exports-and-logs/1-conversation_for_mock_API.json"
```

---

## THIRD TASK: Initialize Git (if not already initialized)

The project likely already has a git repository. If so, create a new branch for this work:

```bash
git checkout -b feature/frontmatter-enhancements
```

Then commit:
- Test infrastructure files
- Any initial modifications to export/markdown.js
- README updates if needed

Commit message: "Setup test infrastructure for frontmatter modifications"

---

## FOURTH TASK: Document the Test Approach

Update or create documentation explaining:
1. How to run the test suite
2. What the mock JSON files represent
3. How to add new test cases
4. What the expected outputs in test-vault/ represent

---

## ENDING THIS SESSION

Once you have completed the tasks above:

1. Verify features were created using the feature_get_stats tool
2. Ensure test infrastructure is in place and working
3. Commit all work with descriptive messages
4. Leave the environment ready for coding agents

**IMPORTANT:** Do NOT implement the actual modifications yet. Your job is setup only.
The 8 modifications to export/markdown.js will be handled by coding agents that spawn
after you complete initialization.

---

## NOTES FOR CODING AGENTS

When implementing features, remember:

1. **Primary file to modify:** `export/markdown.js`
2. **Single filename function:** Use ONE function for generating filenames that's used for
   both actual .md filenames AND internal parent links
3. **Branching info location:** Look in `conversation.mapping[nodeId].message.metadata` for
   `branching_from_conversation_id` and `branching_from_conversation_title`
4. **Tag sanitization:** No underscores allowed, only lowercase letters/numbers/hyphens
5. **Test against expected outputs:** The .md files in test-vault/ are the source of truth
