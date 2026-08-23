import type {
  LLMRecoveryAction,
  ProviderFallbackReason,
  TokenUsageStatusReason,
} from "./types.ts";
import type { AssistantSemanticIssue } from "./response-interpreter.ts";

export interface RecoveryPolicyState {
  visibleOutputStarted: boolean;
  sameProviderRecoveryUsed: boolean;
  streamContinuationUsed: boolean;
  hasFallback: boolean;
  hasSameModelFallback: boolean;
}

export type AttemptAssessment =
  | { kind: "acceptable" }
  | {
    kind: "finish_issue";
    reason: "length" | "error" | "content_filter";
  }
  | {
    kind: "semantic_issue";
    issue: AssistantSemanticIssue;
  }
  | {
    kind: "provider_failure";
    reason: ProviderFallbackReason | null;
    hasPartialOutput: boolean;
  }
  | { kind: "total_timeout" };

export type RecoveryDecision =
  | { action: "accept" }
  | {
    action: "retry_same";
    mode: "continuation" | "repair";
    silent: boolean;
    reason: TokenUsageStatusReason;
  }
  | {
    action: "fallback";
    reason: TokenUsageStatusReason;
  }
  | {
    action: "finalize_partial";
    reason: TokenUsageStatusReason;
  }
  | {
    action: "fail";
    reason: TokenUsageStatusReason;
  };

function semanticReason(
  issue: AssistantSemanticIssue,
): TokenUsageStatusReason {
  return issue.kind;
}

function recoverSemanticIssue(
  issue: AssistantSemanticIssue,
  state: RecoveryPolicyState,
): RecoveryDecision {
  const reason = semanticReason(issue);

  if (issue.kind === "degenerate_repetition" && state.visibleOutputStarted) {
    return { action: "finalize_partial", reason };
  }

  if (!state.sameProviderRecoveryUsed) {
    return {
      action: "retry_same",
      mode: "repair",
      silent: state.visibleOutputStarted,
      reason,
    };
  }

  if (!state.visibleOutputStarted && state.hasFallback) {
    return { action: "fallback", reason };
  }

  return { action: "finalize_partial", reason };
}

export function decideRecovery(
  assessment: AttemptAssessment,
  state: RecoveryPolicyState,
): RecoveryDecision {
  switch (assessment.kind) {
    case "acceptable":
      return { action: "accept" };

    case "semantic_issue":
      return recoverSemanticIssue(assessment.issue, state);

    case "finish_issue": {
      if (
        assessment.reason === "length" && !state.sameProviderRecoveryUsed
      ) {
        return {
          action: "retry_same",
          mode: "continuation",
          silent: false,
          reason: "length",
        };
      }
      if (!state.visibleOutputStarted && state.hasFallback) {
        return { action: "fallback", reason: assessment.reason };
      }
      return {
        action: "finalize_partial",
        reason: assessment.reason,
      };
    }

    case "provider_failure": {
      const reason = assessment.reason ?? "unknown";

      if (
        assessment.hasPartialOutput &&
        !state.streamContinuationUsed
      ) {
        return {
          action: "retry_same",
          mode: "continuation",
          silent: false,
          reason,
        };
      }
      if (state.hasSameModelFallback) {
        return { action: "fallback", reason };
      }
      if (state.visibleOutputStarted) {
        return { action: "finalize_partial", reason };
      }
      if (state.hasFallback) {
        return { action: "fallback", reason };
      }
      return { action: "fail", reason };
    }

    case "total_timeout":
      return state.visibleOutputStarted
        ? { action: "finalize_partial", reason: "timeout" }
        : { action: "fail", reason: "timeout" };
  }
}

export function recoveryActionOf(
  decision: RecoveryDecision,
): LLMRecoveryAction {
  return decision.action;
}
