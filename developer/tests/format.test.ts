/** lib/format.ts: dates in words, and words (never a dash) when there is no date. Run with `pnpm test`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDate, formatDateTime, formatExpiry, formatRelative, formatTime } from "../lib/format";

test("no date reads as words, never as a dash", () => {
  for (const empty of [null, undefined, "", "not a date"]) {
    assert.equal(formatDate(empty), "Not set");
    assert.equal(formatDateTime(empty), "Not set");
    assert.equal(formatTime(empty), "Not set");
    assert.equal(formatRelative(empty), "Never");
    assert.equal(formatExpiry(empty), "Never");
  }
});

test("dates still read as dates", () => {
  assert.equal(formatDate("2026-10-06"), "Oct 6, 2026");
  assert.equal(formatDateTime("2026-10-06T14:05:00Z", "UTC"), "Oct 6, 2026, 14:05");
  assert.equal(formatTime("2026-10-06T14:05:00Z", "UTC"), "14:05");
  const now = Date.parse("2026-10-06T14:05:00Z");
  assert.equal(formatRelative(now - 2 * 3_600_000, now), "2 hours ago");
  assert.equal(formatExpiry(now - 1_000, now), "expired");
});
