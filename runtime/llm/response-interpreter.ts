import type {
  ProviderFinishReason,
  ToolInvocation,
} from "@/runtime/llm/types.ts";
import {
  detectDegenerateRepetition,
  parseInternalControlTagsFromResponse,
  parseTaggedBlocksFromResponse,
  parseToolCallsFromResponse,
  responseHasMalformedToolCallIntent,
  responseHasOrphanedToolResult,
  responseHasReasoningMarkup,
  responseHasToolIntent,
  sanitizeUserFacingText,
  stripStructuralLeakTokens,
} from "@/runtime/llm/utils.ts";

export const REASONING_HISTORY_TAGS = [
  "think",
  "thought",
  "thinking",
  "reasoning",
] as const;

const INTENTIONAL_EMPTY_PATTERN =
  /<(no_response|continue_after_tool_results)[\s/>]/;

export type AssistantSemanticIssue =
  | { kind: "orphaned_tool_result" }
  | { kind: "malformed_tool_call" }
  | { kind: "degenerate_repetition"; startIndex: number }
  | { kind: "visible_reasoning_markup" }
  | { kind: "empty_response" };

export interface ParsedAssistantResponse {
  cleanResponse: string;
  toolCalls: ToolInvocation[];
  extractedTags: Record<string, string[]>;
}

export interface AssistantInterpretation {
  parsed: ParsedAssistantResponse;
  currentAttempt: ParsedAssistantResponse;
  issue?: AssistantSemanticIssue;
}

export function parseAssistantResponse(
  response: string,
  extractedBlockTags: string[] = [],
  knownToolNames: string[] = [],
  recoverCompleteUnclosedToolCalls = false,
): ParsedAssistantResponse {
  let cleanResponse = response;
  let toolCalls: ToolInvocation[] = [];
  let extractedTags: Record<string, string[]> = {};

  {
    const parsed = parseToolCallsFromResponse(response, knownToolNames, {
      recoverCompleteUnclosed: recoverCompleteUnclosedToolCalls,
    });
    cleanResponse = parsed.cleanResponse;
    toolCalls = parsed.toolCalls;
  }

  const visibleExtractedBlockTags = extractedBlockTags.filter((tag) =>
    !REASONING_HISTORY_TAGS.includes(
      tag.toLowerCase() as typeof REASONING_HISTORY_TAGS[number],
    )
  );
  if (extractedBlockTags.length > 0) {
    const parsed = parseTaggedBlocksFromResponse(
      cleanResponse,
      visibleExtractedBlockTags,
    );
    cleanResponse = parsed.cleanResponse;
    extractedTags = parsed.extractedTags;
  } else {
    cleanResponse = cleanResponse.trim();
  }

  if (
    cleanResponse.includes("<no_response") ||
    cleanResponse.includes("<tool_results>") ||
    cleanResponse.includes("<continue_after_tool_results")
  ) {
    const parsed = parseInternalControlTagsFromResponse(cleanResponse);
    cleanResponse = parsed.cleanResponse;
  } else {
    cleanResponse = cleanResponse.trim();
  }

  cleanResponse = sanitizeUserFacingText(
    stripStructuralLeakTokens(cleanResponse),
  ).trim();

  return { cleanResponse, toolCalls, extractedTags };
}

/**
 * Parses a completed provider response once and classifies only the normalized,
 * user-visible channel. Extracted `<think>` blocks therefore cannot be mistaken
 * for leaked visible reasoning.
 */
export function interpretAssistantResponse(args: {
  fullContent: string;
  currentAttemptContent: string;
  extractedBlockTags: string[];
  knownToolNames: string[];
  finishReason: ProviderFinishReason | null;
}): AssistantInterpretation {
  const recoverCompleteUnclosedToolCalls = args.finishReason === "stop" ||
    args.finishReason === "tool_calls";
  const parsed = parseAssistantResponse(
    args.fullContent,
    args.extractedBlockTags,
    args.knownToolNames,
    recoverCompleteUnclosedToolCalls,
  );
  const currentAttempt = parseAssistantResponse(
    args.currentAttemptContent,
    args.extractedBlockTags,
    args.knownToolNames,
    recoverCompleteUnclosedToolCalls,
  );

  if (responseHasOrphanedToolResult(args.currentAttemptContent)) {
    return { parsed, currentAttempt, issue: { kind: "orphaned_tool_result" } };
  }

  const hasMalformedToolIntent = responseHasMalformedToolCallIntent(
    args.currentAttemptContent,
    args.knownToolNames,
  ) ||
    (currentAttempt.toolCalls.length === 0 &&
      responseHasToolIntent(args.currentAttemptContent, args.knownToolNames));
  if (hasMalformedToolIntent) {
    return { parsed, currentAttempt, issue: { kind: "malformed_tool_call" } };
  }

  const repetition = detectDegenerateRepetition(args.currentAttemptContent);
  if (repetition) {
    return {
      parsed,
      currentAttempt,
      issue: {
        kind: "degenerate_repetition",
        startIndex: repetition.startIndex,
      },
    };
  }

  // This is intentionally evaluated after extraction/sanitization.
  if (responseHasReasoningMarkup(currentAttempt.cleanResponse)) {
    return {
      parsed,
      currentAttempt,
      issue: { kind: "visible_reasoning_markup" },
    };
  }

  const isUnintentionallyEmpty = parsed.cleanResponse.length === 0 &&
    parsed.toolCalls.length === 0 &&
    Object.keys(parsed.extractedTags).length === 0 &&
    !INTENTIONAL_EMPTY_PATTERN.test(args.fullContent);
  if (isUnintentionallyEmpty) {
    return { parsed, currentAttempt, issue: { kind: "empty_response" } };
  }

  return { parsed, currentAttempt };
}
