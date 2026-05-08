import { assertEquals } from "@std/assert";

import { shapeFetchedText } from "./index.ts";

Deno.test("fetch_text filters matching lines with contains", () => {
  const result = shapeFetchedText("alpha\nbeta\nalphabet", {
    contains: "alp",
  });

  assertEquals(result.content, "alpha\nalphabet");
  assertEquals(result.extraction, {
    type: "contains",
    value: "alp",
    matches: 2,
  });
});

Deno.test("fetch_text extracts regex matches with capture groups", () => {
  const result = shapeFetchedText("Task #123\nTask #456", {
    extractRegex: "Task #(\\d+)",
    extractGroup: 1,
  });

  assertEquals(result.content, "123\n456");
  assertEquals(result.extraction, {
    type: "regex",
    mode: "all_matches",
    returnedMatches: 2,
  });
});

Deno.test("fetch_text supports first match and truncation", () => {
  const result = shapeFetchedText("abc-123 abc-456", {
    extractRegex: "abc-(\\d+)",
    extractGroup: 1,
    mode: "first_match",
    maxChars: 2,
  });

  assertEquals(result.content, "12");
  assertEquals(result.truncated, true);
  assertEquals(result.returnedLength, 2);
});

Deno.test("fetch_text treats full mode with a regex as all matches", () => {
  const result = shapeFetchedText("A: one\nA: two", {
    extractRegex: "A: (\\w+)",
    extractGroup: 1,
    mode: "full",
  });

  assertEquals(result.content, "one\ntwo");
  assertEquals(result.extraction?.mode, "all_matches");
});
