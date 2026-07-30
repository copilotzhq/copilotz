import type {
  ChatMessage,
  ProviderAPI,
  ProviderConfig,
  StreamCallback,
  ToolCallStreamDelta,
  ToolInvocation,
} from "@/runtime/llm/types.ts";
import {
  CanonicalToolCallDraftTracker,
  responseHasOrphanedToolResult,
} from "@/runtime/llm/utils.ts";
import { runProviderStream, type StreamResult } from "@/runtime/llm/stream.ts";

const ORPHANED_TOOL_RESULT_PREFIX_PATTERN = /^(?:"[}\],]{2,}"|[}\],]{3,})/;

function classifyLeadingVisibleProtocol(
  text: string,
): "undecided" | "suspect" | "pass" {
  const trimmed = text.trimStart();
  if (ORPHANED_TOOL_RESULT_PREFIX_PATTERN.test(trimmed)) return "suspect";
  if (
    trimmed.length < 16 &&
    (/^"[}\],]*$/.test(trimmed) || /^[}\],]*$/.test(trimmed))
  ) {
    return "undecided";
  }
  return "pass";
}

export interface ProviderAttemptCapture {
  visibleOutputStarted: boolean;
  visibleOutput: string;
  reasoningOutput: string;
}

export type ProviderAttemptExecution =
  | {
    kind: "completed";
    streamResult: StreamResult;
    capture: ProviderAttemptCapture;
    completeToolDrafts: (toolCalls: ToolInvocation[]) => void;
    discardToolDrafts: () => void;
  }
  | {
    kind: "failed";
    error: unknown;
    capture: ProviderAttemptCapture;
  };

/**
 * Executes exactly one provider call. It owns attempt-local stream buffers and
 * tool-call drafts, but makes no retry/fallback decisions.
 */
export async function runProviderAttempt(args: {
  attemptId: string;
  messages: ChatMessage[];
  config: ProviderConfig;
  providerAPI: ProviderAPI;
  extractedBlockTags: string[];
  knownToolNames: string[];
  stream?: StreamCallback;
  silent: boolean;
  signal?: AbortSignal;
  onToolCallDelta?: (delta: ToolCallStreamDelta) => void;
  onMeaningfulVisibleOutput?: () => void;
}): Promise<ProviderAttemptExecution> {
  let visibleOutputStarted = false;
  let visibleOutput = "";
  let reasoningOutput = "";
  let leadingVisibleBuffer = "";
  let leadingVisibleProtocol: "undecided" | "suspect" | "pass" = "undecided";
  let toolDraftsSettled = false;
  const toolDraftTracker = new CanonicalToolCallDraftTracker({
    knownToolNames: args.knownToolNames,
    providerAttemptId: args.attemptId,
    emit: args.silent ? undefined : args.onToolCallDelta,
  });

  const capture = (): ProviderAttemptCapture => ({
    visibleOutputStarted,
    visibleOutput,
    reasoningOutput,
  });
  const emitVisible = (chunk: string) => {
    if (!args.stream || chunk.length === 0) return;
    if (chunk.trim().length > 0) {
      visibleOutputStarted = true;
      args.onMeaningfulVisibleOutput?.();
    }
    args.stream(chunk, { isReasoning: false });
  };
  const trackedStream = (
    chunk: string,
    options?: { isReasoning?: boolean },
  ) => {
    if (chunk.length > 0 && options?.isReasoning) {
      reasoningOutput += chunk;
      if (!args.silent) args.stream?.(chunk, options);
      return;
    }
    if (chunk.length > 0 && !options?.isReasoning) {
      visibleOutput += chunk;
      if (args.silent) return;
      if (leadingVisibleProtocol === "pass") {
        emitVisible(chunk);
        return;
      }
      leadingVisibleBuffer += chunk;
      leadingVisibleProtocol = classifyLeadingVisibleProtocol(
        leadingVisibleBuffer,
      );
      if (leadingVisibleProtocol === "pass") {
        const buffered = leadingVisibleBuffer;
        leadingVisibleBuffer = "";
        emitVisible(buffered);
      }
      return;
    }
    if (!args.silent) args.stream?.(chunk, options);
  };

  try {
    const streamResult = await runProviderStream(
      args.messages,
      trackedStream,
      args.config,
      args.providerAPI,
      args.extractedBlockTags,
      args.signal,
      (tagName, chunk, phase) =>
        toolDraftTracker.observe(tagName, chunk, phase),
    );

    if (
      leadingVisibleBuffer.length > 0 &&
      !responseHasOrphanedToolResult(streamResult.content) &&
      !args.silent
    ) {
      const buffered = leadingVisibleBuffer;
      leadingVisibleBuffer = "";
      leadingVisibleProtocol = "pass";
      emitVisible(buffered);
    }

    return {
      kind: "completed",
      streamResult,
      capture: capture(),
      completeToolDrafts: (toolCalls) => {
        if (toolDraftsSettled) return;
        toolDraftsSettled = true;
        toolDraftTracker.complete(toolCalls);
      },
      discardToolDrafts: () => {
        if (toolDraftsSettled) return;
        toolDraftsSettled = true;
        toolDraftTracker.discardAll();
      },
    };
  } catch (error) {
    toolDraftTracker.discardAll();
    return {
      kind: "failed",
      error,
      capture: capture(),
    };
  }
}
