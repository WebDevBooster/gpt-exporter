// Test script to verify timestamp formatting
const ts = 1770126827.760625;
const date = new Date(ts * 1000);
console.log("Full ISO:", date.toISOString());
console.log("Truncated (expected):", date.toISOString().slice(0, 16));

// Expected based on test-vault: 2026-02-03T13:53
// Let's verify
const expected = "2026-02-03T13:53";
const actual = date.toISOString().slice(0, 16);
console.log("Matches expected:", actual === expected);
