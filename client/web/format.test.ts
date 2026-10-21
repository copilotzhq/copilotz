import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBucket } from "./format.ts";

test("activity buckets read as calendar days, not moments", () => {
  const now = Date.UTC(2026, 9, 21, 10, 0);
  const options = { now, locale: "en-US" };
  assert.equal(formatBucket("2026-10-21T00:00:00.000Z", options), "Today");
  assert.equal(formatBucket("2026-10-21", options), "Today");
  assert.equal(formatBucket("2026-10-20T00:00:00.000Z", options), "Yesterday");
  assert.equal(
    formatBucket("2026-10-14T00:00:00.000Z", options),
    "Wed, Oct 14",
  );
  assert.equal(
    formatBucket("2025-12-31T00:00:00.000Z", options),
    "Wed, Dec 31, 2025",
  );
  assert.equal(
    formatBucket("2026-10-21T13:00:00.000Z", options),
    "Today 13:00 UTC",
  );
  assert.equal(formatBucket("not a date", options), "not a date");
});
