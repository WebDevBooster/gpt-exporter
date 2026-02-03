// Test script to verify formatTruncatedDate helper function
import { formatTruncatedDate } from '../export/markdown.js';

console.log("=== Testing formatTruncatedDate ===\n");

// Test 1: Basic Unix timestamp from spec
const ts1 = 1770126827.760625;
const result1 = formatTruncatedDate(ts1);
const expected1 = "2026-02-03T13:53";
console.log("Test 1: Basic Unix timestamp");
console.log("  Input:", ts1);
console.log("  Expected:", expected1);
console.log("  Got:", result1);
console.log("  Pass:", result1 === expected1 ? "YES" : "NO");
console.log();

// Test 2: Integer timestamp
const ts2 = 1770022467;
const result2 = formatTruncatedDate(ts2);
const expected2 = "2026-02-02T08:54";
console.log("Test 2: Integer timestamp");
console.log("  Input:", ts2);
console.log("  Expected:", expected2);
console.log("  Got:", result2);
console.log("  Pass:", result2 === expected2 ? "YES" : "NO");
console.log();

// Test 3: String timestamp
const ts3 = "1770071387";
const result3 = formatTruncatedDate(ts3);
const expected3 = "2026-02-02T22:29";
console.log("Test 3: String timestamp");
console.log("  Input:", ts3);
console.log("  Expected:", expected3);
console.log("  Got:", result3);
console.log("  Pass:", result3 === expected3 ? "YES" : "NO");
console.log();

// Test 4: Null/undefined handling
const result4 = formatTruncatedDate(null);
console.log("Test 4: Null timestamp");
console.log("  Input: null");
console.log("  Got:", result4);
console.log("  Pass:", result4.length === 16 && result4.includes("T") ? "YES (returns current time)" : "NO");
console.log();

// Test 5: Format check - no seconds, no Z
const ts5 = 1770126827.760625;
const result5 = formatTruncatedDate(ts5);
console.log("Test 5: Format validation");
console.log("  Got:", result5);
console.log("  Has no seconds:", !result5.includes(":47") ? "YES" : "NO");
console.log("  Has no Z suffix:", !result5.endsWith("Z") ? "YES" : "NO");
console.log("  Length is 16:", result5.length === 16 ? "YES" : "NO");
console.log();

// Summary
const allPassed =
    result1 === expected1 &&
    result2 === expected2 &&
    result3 === expected3 &&
    result4.length === 16 &&
    !result5.endsWith("Z") &&
    result5.length === 16;

console.log("=== Summary ===");
console.log("All tests passed:", allPassed ? "YES" : "NO");
