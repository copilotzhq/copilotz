import { assertEquals } from "@std/assert";
import {
  getLocalStopSequences,
  resolveProviderStopSequences,
} from "./stop-sequences.ts";

Deno.test("getLocalStopSequences stops both tool results tag forms", () => {
  assertEquals(
    getLocalStopSequences(),
    [
      "<tool_results",
      "</tool_results>",
      "<continue_after_tool_results",
      "<result",
      "</result>",
      "<tool_result",
      "</tool_result>",
    ],
  );
});

Deno.test("resolveProviderStopSequences prefers runtime-resolved native list", () => {
  assertEquals(
    resolveProviderStopSequences({
      nativeStopSequences: ["STOP", "<tool_results>"],
      stop: "IGNORED",
    }),
    ["STOP", "<tool_results>"],
  );
});

Deno.test("resolveProviderStopSequences merges and dedupes stop/stopSequences fallback", () => {
  assertEquals(
    resolveProviderStopSequences({
      stopSequences: ["STOP", "HALT"],
      stop: ["HALT", "END"],
    }),
    ["STOP", "HALT", "END"],
  );
});

Deno.test("resolveProviderStopSequences caps to maxCount keeping order", () => {
  assertEquals(
    resolveProviderStopSequences(
      { nativeStopSequences: ["a", "b", "c", "d", "e", "f"] },
      { maxCount: 5 },
    ),
    ["a", "b", "c", "d", "e"],
  );
});

Deno.test("resolveProviderStopSequences returns undefined when empty", () => {
  assertEquals(resolveProviderStopSequences({}), undefined);
});
