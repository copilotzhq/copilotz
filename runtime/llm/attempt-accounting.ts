import type {
  ChatMessage,
  LLMDebugSnapshot,
  LLMRecoveryAction,
  LLMUsageAttempt,
  ProviderConfig,
  ProviderErrorDetails,
  ProviderFallbackReason,
  ProviderFinishReason,
  TokenUsage,
  TokenUsageStatusReason,
  ToolInvocation,
} from "./types.ts";
import type { ProviderAttemptCapture } from "./attempt-runner.ts";
import type { StreamResult } from "./stream.ts";
import type { ParsedAssistantResponse } from "./response-interpreter.ts";
import type { PreparedAttemptTranscript } from "./transcript.ts";
import { normalizeProviderUsage } from "./usage.ts";
import { estimateUsageCost } from "./pricing.ts";
import { countTokens, estimateUsage } from "./utils.ts";
import { observeTokenCalibration } from "../tokens/index.ts";

function usageStatusForReason(
  statusReason?: TokenUsageStatusReason,
): TokenUsage["status"] {
  switch (statusReason) {
    case "error":
    case "timeout":
    case "network":
    case "auth_error":
    case "billing_error":
    case "rate_limit":
    case "server_error":
    case "provider_error":
    case "invalid_transcript":
    case "unknown":
    case "content_filter":
      return "aborted";
    default:
      return "completed";
  }
}

export function buildDebugSnapshot(args: {
  inputMessages: ChatMessage[];
  transcript: PreparedAttemptTranscript;
  rawContent: string;
  currentAttemptContent: string;
  reasoning?: string;
  answer: string;
  toolCalls: ToolInvocation[];
  extractedTags: Record<string, string[]>;
  finishReason: ProviderFinishReason | null;
}): LLMDebugSnapshot {
  return {
    inputMessages: args.inputMessages,
    promptFingerprint: args.transcript.promptFingerprint,
    promptPrefixFingerprint: args.transcript.promptPrefixFingerprint,
    promptPrefixMessageCount: args.transcript.promptPrefixMessageCount,
    inputTokenEstimate: args.transcript.inputTokenEstimate,
    rawOutput: {
      content: args.rawContent,
      currentAttemptContent: args.currentAttemptContent,
      ...(args.reasoning ? { reasoning: args.reasoning } : {}),
    },
    parsedOutput: {
      answer: args.answer,
      ...(args.reasoning ? { reasoning: args.reasoning } : {}),
      toolCalls: args.toolCalls,
      extractedTags: args.extractedTags,
      finishReason: args.finishReason,
    },
  };
}

export async function accountCompletedAttempt(args: {
  attemptId: string;
  attemptIndex: number;
  providerConfig: ProviderConfig;
  messages: ChatMessage[];
  transcript: PreparedAttemptTranscript;
  streamResult: StreamResult;
  parsed: ParsedAssistantResponse;
  fullContent: string;
  reasoning?: string;
  capture: ProviderAttemptCapture;
  statusReason?: TokenUsageStatusReason;
  recoveryAction: LLMRecoveryAction;
  startedAt: string;
  finishedAt: string;
}): Promise<LLMUsageAttempt> {
  const usageStatus = args.streamResult.stoppedByLocalStop
    ? "locally_stopped"
    : usageStatusForReason(args.statusReason);
  const usageMetadata = {
    ...(args.streamResult.stoppedByLocalStop || args.statusReason
      ? {
        statusReason: args.statusReason ??
          args.streamResult.localStopReason ?? "local_stop_sequence",
      }
      : {}),
    ...(args.streamResult.localStopSequence
      ? { stopSequence: args.streamResult.localStopSequence }
      : {}),
  } satisfies Pick<TokenUsage, "statusReason" | "stopSequence">;
  const usage = normalizeProviderUsage(
    args.streamResult.usage,
    usageStatus,
    usageMetadata,
  ) ??
    await estimateUsage(
      args.messages,
      args.streamResult.content,
      usageStatus,
      usageMetadata,
      args.providerConfig,
    );
  if (usage.totalTokens === undefined) {
    usage.totalTokens = await countTokens(
      args.messages,
      args.parsed.cleanResponse,
      args.providerConfig,
    );
  }
  const cost = await estimateUsageCost(args.providerConfig, usage);
  const usageFinalized = args.streamResult.usageFinalized
    ? args.streamResult.usageFinalized.then(async (finalized) => {
      const finalUsage = normalizeProviderUsage(
        finalized.usage,
        usageStatus,
        usageMetadata,
      );
      if (!finalUsage) return null;
      if (
        usage.source !== "provider" &&
        typeof finalUsage.inputTokens === "number"
      ) {
        observeTokenCalibration(
          args.transcript.inputTokenEstimate.calibrationKey,
          args.transcript.inputTokenEstimate.rawEstimatedTokens,
          finalUsage.inputTokens,
        );
      }
      const finalCost = await estimateUsageCost(
        args.providerConfig,
        finalUsage,
      );
      return {
        usage: finalUsage,
        ...(finalCost ? { cost: finalCost } : {}),
        tokens: finalUsage.totalTokens ??
          await countTokens(
            args.messages,
            args.streamResult.content,
            args.providerConfig,
          ),
        finishReason: finalized.finishReason,
        finalizedAt: new Date().toISOString(),
      };
    })
    : undefined;

  if (usage.source === "provider" && typeof usage.inputTokens === "number") {
    observeTokenCalibration(
      args.transcript.inputTokenEstimate.calibrationKey,
      args.transcript.inputTokenEstimate.rawEstimatedTokens,
      usage.inputTokens,
    );
  }

  return {
    attemptId: args.attemptId,
    attemptIndex: args.attemptIndex,
    provider: args.providerConfig.provider,
    model: args.providerConfig.model,
    messages: args.messages,
    debug: buildDebugSnapshot({
      inputMessages: args.messages,
      transcript: args.transcript,
      rawContent: args.fullContent,
      currentAttemptContent: args.streamResult.content,
      reasoning: args.reasoning,
      answer: args.parsed.cleanResponse,
      toolCalls: args.parsed.toolCalls,
      extractedTags: args.parsed.extractedTags,
      finishReason: args.streamResult.finishReason,
    }),
    usage,
    ...(cost ? { cost } : {}),
    visibleOutputStarted: args.capture.visibleOutputStarted,
    partialAnswer: args.capture.visibleOutput,
    partialReasoning: args.capture.reasoningOutput,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    status: args.recoveryAction === "retry_same" ||
        args.recoveryAction === "fallback"
      ? "failed"
      : "completed",
    recoveryAction: args.recoveryAction,
    ...(usageFinalized ? { usageFinalized } : {}),
  };
}

export async function accountFailedAttempt(args: {
  attemptId: string;
  attemptIndex: number;
  providerConfig: ProviderConfig;
  messages: ChatMessage[];
  transcript: PreparedAttemptTranscript;
  capture: ProviderAttemptCapture;
  errorReason: ProviderFallbackReason | null;
  errorStatus?: number;
  errorMessage: string;
  errorDetails?: ProviderErrorDetails;
  statusReason: TokenUsageStatusReason;
  recoveryAction: LLMRecoveryAction;
  startedAt: string;
  finishedAt: string;
  status?: "failed" | "superseded";
}): Promise<LLMUsageAttempt> {
  const usage = await estimateUsage(
    args.messages,
    args.capture.visibleOutput,
    usageStatusForReason(args.statusReason),
    { statusReason: args.statusReason },
    args.providerConfig,
  );
  const cost = await estimateUsageCost(args.providerConfig, usage);
  return {
    attemptId: args.attemptId,
    attemptIndex: args.attemptIndex,
    provider: args.providerConfig.provider,
    model: args.providerConfig.model,
    messages: args.messages,
    debug: buildDebugSnapshot({
      inputMessages: args.messages,
      transcript: args.transcript,
      rawContent: args.capture.visibleOutput,
      currentAttemptContent: args.capture.visibleOutput,
      reasoning: args.capture.reasoningOutput,
      answer: args.capture.visibleOutput,
      toolCalls: [],
      extractedTags: {},
      finishReason: "error",
    }),
    error: {
      reason: args.errorReason,
      ...(args.errorStatus !== undefined ? { status: args.errorStatus } : {}),
      message: args.errorMessage,
      ...(args.errorDetails ? { details: args.errorDetails } : {}),
    },
    usage,
    ...(cost ? { cost } : {}),
    visibleOutputStarted: args.capture.visibleOutputStarted,
    partialAnswer: args.capture.visibleOutput,
    partialReasoning: args.capture.reasoningOutput,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    status: args.status ?? "failed",
    recoveryAction: args.recoveryAction,
  };
}
