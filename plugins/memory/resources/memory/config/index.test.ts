import { assert } from "@std/assert";
import { DEFAULT_LONG_TERM_MEMORY_CONFIG } from "./index.ts";
Deno.test("memory defaults are positive", () =>
  assert(DEFAULT_LONG_TERM_MEMORY_CONFIG.triggerEstimatedTokens > 0));
