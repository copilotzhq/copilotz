import { assertEquals } from "@std/assert";
import { decideRecovery } from "./recovery-policy.ts";

const baseState = {
  visibleOutputStarted: false,
  sameProviderRecoveryUsed: false,
  streamContinuationUsed: false,
  hasFallback: true,
  hasSameModelFallback: false,
};

Deno.test("attempt timeout continues from reasoning-only activity", () => {
  assertEquals(
    decideRecovery({
      kind: "provider_failure",
      reason: "timeout",
      hasPartialOutput: true,
    }, baseState),
    {
      action: "retry_same",
      mode: "continuation",
      silent: false,
      reason: "timeout",
    },
  );
});

Deno.test("attempt timeout continues from visible output", () => {
  assertEquals(
    decideRecovery({
      kind: "provider_failure",
      reason: "timeout",
      hasPartialOutput: true,
    }, { ...baseState, visibleOutputStarted: true }),
    {
      action: "retry_same",
      mode: "continuation",
      silent: false,
      reason: "timeout",
    },
  );
});

Deno.test("ordinary interrupted visible stream receives one continuation", () => {
  assertEquals(
    decideRecovery({
      kind: "provider_failure",
      reason: "network",
      hasPartialOutput: true,
    }, baseState),
    {
      action: "retry_same",
      mode: "continuation",
      silent: false,
      reason: "network",
    },
  );
});

Deno.test("exhausted continuation can use an equivalent model fallback", () => {
  assertEquals(
    decideRecovery({
      kind: "provider_failure",
      reason: "timeout",
      hasPartialOutput: true,
    }, {
      ...baseState,
      visibleOutputStarted: true,
      streamContinuationUsed: true,
      hasSameModelFallback: true,
    }),
    { action: "fallback", reason: "timeout" },
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
