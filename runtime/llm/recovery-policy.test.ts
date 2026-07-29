import { assertEquals } from "@std/assert";
import { decideRecovery } from "@/runtime/llm/recovery-policy.ts";

const baseState = {
  visibleOutputStarted: false,
  sameProviderRecoveryUsed: false,
  streamContinuationUsed: false,
  hasFallback: true,
};

Deno.test("hard attempt timeout falls back despite reasoning-only activity", () => {
  assertEquals(
    decideRecovery({
      kind: "provider_failure",
      reason: "timeout",
      hasMeaningfulPartialAnswer: false,
      hasReasoningOnlyPartial: true,
      hardTimeout: true,
    }, baseState),
    { action: "fallback", reason: "timeout" },
  );
});

Deno.test("hard attempt timeout finalizes already-visible output", () => {
  assertEquals(
    decideRecovery({
      kind: "provider_failure",
      reason: "timeout",
      hasMeaningfulPartialAnswer: true,
      hasReasoningOnlyPartial: false,
      hardTimeout: true,
    }, { ...baseState, visibleOutputStarted: true }),
    { action: "finalize_partial", reason: "timeout" },
  );
});

Deno.test("ordinary interrupted visible stream receives one continuation", () => {
  assertEquals(
    decideRecovery({
      kind: "provider_failure",
      reason: "network",
      hasMeaningfulPartialAnswer: true,
      hasReasoningOnlyPartial: false,
      hardTimeout: false,
    }, baseState),
    {
      action: "retry_same",
      mode: "continuation",
      silent: false,
      reason: "network",
    },
  );
});

Deno.test("semantic repair is silent after visible output", () => {
  assertEquals(
    decideRecovery({
      kind: "semantic_issue",
      issue: { kind: "malformed_tool_call" },
    }, { ...baseState, visibleOutputStarted: true }),
    {
      action: "retry_same",
      mode: "repair",
      silent: true,
      reason: "malformed_tool_call",
    },
  );
});

Deno.test("total timeout never starts another provider", () => {
  assertEquals(
    decideRecovery(
      { kind: "total_timeout" },
      baseState,
    ),
    { action: "fail", reason: "timeout" },
  );
});
