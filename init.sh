#!/bin/bash

# GPT Exporter Test Runner
# Runs the markdown export tests for frontmatter modifications

set -e

echo "=================================="
echo "GPT Exporter - Frontmatter Tests"
echo "=================================="
echo ""

# Check Node.js version
NODE_VERSION=$(node -v 2>/dev/null | cut -d'v' -f2 | cut -d'.' -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 18 ]; then
    echo "Error: Node.js 18+ is required"
    echo "Current version: $(node -v 2>/dev/null || echo 'not installed')"
    exit 1
fi

echo "Node.js version: $(node -v)"
echo ""

# Run tests
echo "Running tests..."
echo ""

node test/runner.mjs "$@"

TEST_EXIT_CODE=$?

echo ""
echo "=================================="
if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo "All tests completed successfully!"
else
    echo "Some tests failed. Exit code: $TEST_EXIT_CODE"
fi
echo "=================================="

exit $TEST_EXIT_CODE
