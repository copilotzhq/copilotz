import type {
  ExtractedPart,
  ProcessStreamOptions,
  ProviderConfig,
  ProviderFinishReason,
  ProviderUsageUpdate,
  StreamCallback,
  ToolCallStreamDelta,
  ToolInvocation,
} from "./types.ts";
import {
  COPILOTZ_CONTROL_TAGS,
  NO_RESPONSE_SELF_CLOSING_TAG,
  normalizeStructuredTagNames,
  STRUCTURAL_LEAK_LITERALS,
  suffixPrefix,
  suffixPrefixAny,
} from "./protocol-tags.ts";
import {
  applyLocalStopSequences,
  getLocalStopSequences,
  isStopDebugEnabled,
  type LocalStopState,
} from "./stop-sequences.ts";

const NO_RESPONSE_EMPTY_BLOCK_TAG = "<no_response></no_response>";

const INTERNAL_LITERAL_CONTROL_TAGS = [
  NO_RESPONSE_SELF_CLOSING_TAG,
  NO_RESPONSE_EMPTY_BLOCK_TAG,
];

/**
 * Protocol tags that must never be visible to users. Canonical `<tool_calls>`
 * blocks are parsed; non-canonical tool-call dialects trigger recovery; result
 * and continuation tags trigger local stops.
 */
const STREAMING_HIDDEN_PROTOCOL_TAGS = [
  "minimax:tool_call",
  "tool_call",
  "invoke",
  "parameter",
  "function_call",
  "function_calls",
  "tool_use",
  "tool",
  "tool_result",
  "result",
  "target_ids",
  "mm:think",
  "think",
  "thought",
  "thinking",
  "reasoning",
  "malformed_tool_call_recovery",
  "visible_reasoning_markup_recovery",
  "recovery_previous_response_context",
  "recovery_required_action",
  "recovery_tool_call_rules",
  "recovery_problem",
  "message_timestamp",
] as const;

function findStructuredStartTag(
  input: string,
  tagName: string,
): { index: number; length: number; selfClosing: boolean } | null {
  const lowerInput = input.toLowerCase();
  const lowerTag = tagName.toLowerCase();
  const needle = `<${lowerTag}`;
  let index = lowerInput.indexOf(needle);

  while (index !== -1) {
    const next = lowerInput[index + needle.length];
    if (
      next === undefined ||
      next === ">" ||
      next === "/" ||
      /\s/.test(next)
    ) {
      const closeIdx = input.indexOf(">", index + needle.length);
      return {
        index,
        length: closeIdx === -1 ? needle.length : closeIdx - index + 1,
        selfClosing: closeIdx !== -1 &&
          /\/\s*>$/.test(input.slice(index, closeIdx + 1)),
      };
    }
    index = lowerInput.indexOf(needle, index + 1);
  }

  return null;
}

function structuredStartTagSuffixOverlap(
  input: string,
  tagName: string,
): number {
  const token = `<${tagName}`.toLowerCase();
  const lower = input.toLowerCase();
  let overlap = 0;
  for (let size = 1; size < token.length; size++) {
    if (lower.endsWith(token.slice(0, size))) overlap = size;
  }
  return overlap;
}

/**
 * Parses Server-Sent Events data
 */
export function parseSSEData(line: string): any | null {
  if (!line.startsWith("data:")) return null;

  const data = line.slice(5).trim();
  if (data === "[DONE]") return null;

  try {
    return JSON.parse(data);
  } catch (error) {
    console.warn("Failed to parse SSE data:", error, "Line:", line);
    return null;
  }
}

interface CanonicalToolCallDraft {
  draftId: string;
  callIndex: number;
  toolName: string;
  sequence: number;
  rawLine: string;
  terminal: boolean;
}

function readCompleteJsonString(
  text: string,
  start: number,
): { value: unknown; end: number } | null {
  if (text[start] !== '"') return null;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char !== '"') continue;
    try {
      return {
        value: JSON.parse(text.slice(start, index + 1)),
        end: index + 1,
      };
    } catch {
      return null;
    }
  }
  return null;
}

function readCanonicalToolName(line: string): string | null {
  let objectDepth = 0;
  let arrayDepth = 0;
  let inString = false;
  let escaped = false;
  let expectingTopLevelKey = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (
      char === '"' && objectDepth === 1 && arrayDepth === 0 &&
      expectingTopLevelKey
    ) {
      const key = readCompleteJsonString(line, index);
      if (!key) return null;
      let colon = key.end;
      while (colon < line.length && /\s/.test(line[colon])) colon += 1;
      if (line[colon] !== ":") return null;
      let valueStart = colon + 1;
      while (valueStart < line.length && /\s/.test(line[valueStart])) {
        valueStart += 1;
      }
      if (key.value === "name") {
        const value = readCompleteJsonString(line, valueStart);
        return value && typeof value.value === "string" &&
            value.value.length > 0
          ? value.value
          : null;
      }
      expectingTopLevelKey = false;
      index = colon;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "{") {
      objectDepth += 1;
      if (objectDepth === 1 && arrayDepth === 0) expectingTopLevelKey = true;
    } else if (char === "}") objectDepth -= 1;
    else if (char === "[") arrayDepth += 1;
    else if (char === "]") arrayDepth -= 1;
    else if (
      char === "," && objectDepth === 1 && arrayDepth === 0
    ) {
      expectingTopLevelKey = true;
    }
  }
  return null;
}

/**
 * Tracks one draft per non-empty canonical JSON line while preserving the
 * exact text produced inside `<tool_calls>`. Unknown tool names stay private.
 */
export interface CanonicalToolCallDraftTracker {
  observe(
    tagName: string,
    chunk: string,
    phase: "start" | "content" | "end",
  ): void;
  complete(toolCalls: ToolInvocation[]): void;
  discardAll(): void;
}

export function createCanonicalToolCallDraftTracker(options: {
  knownToolNames: Iterable<string>;
  providerAttemptId: string;
  emit?: (delta: ToolCallStreamDelta) => void;
}): CanonicalToolCallDraftTracker {
  const knownToolNames = new Set(options.knownToolNames);
  const drafts: CanonicalToolCallDraft[] = [];
  let line = "";
  let activeDraft: CanonicalToolCallDraft | null = null;
  let nextCallIndex = 0;

  const discard = (draft: CanonicalToolCallDraft): void => {
    if (draft.terminal) return;
    draft.sequence += 1;
    draft.terminal = true;
    options.emit?.({
      providerAttemptId: options.providerAttemptId,
      draftId: draft.draftId,
      callIndex: draft.callIndex,
      sequence: draft.sequence,
      toolName: draft.toolName,
      phase: "discarded",
      delta: "",
    });
  };

  const finishLine = (): void => {
    if (!line.trim()) {
      line = "";
      activeDraft = null;
      return;
    }
    if (activeDraft) activeDraft.rawLine = line;
    nextCallIndex += 1;
    line = "";
    activeDraft = null;
  };

  const append = (text: string): void => {
    if (!text) return;
    const previousLength = line.length;
    line += text;

    if (!activeDraft) {
      const toolName = readCanonicalToolName(line);
      if (!toolName || !knownToolNames.has(toolName)) return;
      const draft: CanonicalToolCallDraft = {
        draftId: `${options.providerAttemptId}:${nextCallIndex}`,
        callIndex: nextCallIndex,
        toolName,
        sequence: 0,
        rawLine: line,
        terminal: false,
      };
      activeDraft = draft;
      drafts.push(draft);
      options.emit?.({
        providerAttemptId: options.providerAttemptId,
        draftId: draft.draftId,
        callIndex: draft.callIndex,
        sequence: draft.sequence,
        toolName,
        phase: "start",
        delta: line,
      });
      return;
    }

    const delta = line.slice(previousLength);
    if (!delta) return;
    activeDraft.rawLine = line;
    activeDraft.sequence += 1;
    options.emit?.({
      providerAttemptId: options.providerAttemptId,
      draftId: activeDraft.draftId,
      callIndex: activeDraft.callIndex,
      sequence: activeDraft.sequence,
      toolName: activeDraft.toolName,
      phase: "delta",
      delta,
    });
  };

  const observe: CanonicalToolCallDraftTracker["observe"] = (
    tagName,
    chunk,
    phase,
  ) => {
    if (tagName !== "tool_calls") return;
    if (phase === "start" || phase === "end") {
      finishLine();
      return;
    }

    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== "\n") continue;
      append(chunk.slice(start, index));
      finishLine();
      start = index + 1;
    }
    append(chunk.slice(start));
  };

  const complete = (toolCalls: ToolInvocation[]): void => {
    finishLine();
    const usedCallIds = new Set<string>();

    for (const draft of drafts) {
      if (draft.terminal) continue;
      const toolCall = toolCalls.find((candidate) =>
        candidate.tool.id === draft.toolName && !usedCallIds.has(candidate.id)
      );
      if (!toolCall) {
        discard(draft);
        continue;
      }
      usedCallIds.add(toolCall.id);
      draft.sequence += 1;
      draft.terminal = true;
      options.emit?.({
        providerAttemptId: options.providerAttemptId,
        draftId: draft.draftId,
        callIndex: draft.callIndex,
        sequence: draft.sequence,
        toolName: draft.toolName,
        phase: "complete",
        delta: "",
        toolCallId: toolCall.id,
      });
    }
  };

  const discardAll = (): void => {
    finishLine();
    for (const draft of drafts) discard(draft);
  };

  return ({ observe, complete, discardAll } as const);
}

/**
 * Parses a single line according to the stream format.
 * SSE: expects `data: {...}` prefix.  JSONL: raw JSON per line.
 */
function parseLine(line: string, format: "sse" | "jsonl"): any | null {
  if (format === "jsonl") {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  return parseSSEData(line);
}

/** Splits a provider byte stream into lines. */
function streamLines(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder("utf-8");
  let partial = "";
  let received: string[] = [];
  let ended = false;
  return {
    /** Lines already received but not yet read. Never waits on the network. */
    takeReceived(): string[] {
      const lines = received;
      received = [];
      return lines;
    },
    /** The next line, or `undefined` once the stream has ended. */
    async next(): Promise<string | undefined> {
      while (!received.length) {
        if (ended) return undefined;
        const { done, value } = await reader.read();
        if (done) {
          ended = true;
          if (partial) received = [partial];
          partial = "";
          continue;
        }
        const lines = (partial + decoder.decode(value, { stream: true }))
          .split("\n");
        partial = lines.pop() || "";
        received = lines;
      }
      return received.shift();
    },
  };
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    reader.releaseLock();
  } catch {
    // ignore release errors
  }
}

/**
 * Console tracing of local stop behaviour, enabled by the provider config.
 * It records whether the provider kept generating after a client-side stop.
 */
function createStopDebug(config: ProviderConfig | undefined) {
  if (!isStopDebugEnabled(config)) return undefined;
  const provider = { provider: config?.provider, model: config?.model };
  let contentEvents = 0;
  let visibleChars = 0;
  let reasoningChars = 0;
  let sample = "";
  return {
    init(details: Record<string, unknown>) {
      console.log("[stop-debug] processStream init", {
        ...provider,
        ...details,
      });
    },
    matched(matchedStop: string, visibleCharsBeforeStop: number) {
      console.log("[stop-debug] local stop matched", {
        matchedStop,
        visibleCharsBeforeStop,
      });
    },
    afterStop(parts: ExtractedPart[] | null) {
      for (const part of parts ?? []) {
        if (part.text.length === 0) continue;
        contentEvents += 1;
        if (part.isReasoning) {
          reasoningChars += part.text.length;
        } else {
          visibleChars += part.text.length;
          if (sample.length < 200) sample += part.text;
        }
      }
    },
    summary(finishReason: ProviderFinishReason | null) {
      console.log("[stop-debug] post-stop drain summary", {
        ...provider,
        postStopContentEvents: contentEvents,
        postStopVisibleChars: visibleChars,
        postStopReasoningChars: reasoningChars,
        finishReason,
        postStopVisibleSample: sample,
        interpretation: visibleChars > 0
          ? "provider KEPT GENERATING visible content after the stop sequence (no server-side stop)"
          : "no further visible content after the stop sequence (provider likely stopped server-side)",
      });
    },
  };
}

/**
 * Unified stream processor for all LLM providers.
 *
 * Each provider only needs to implement `extractContent` which maps a parsed
 * event object to an array of `ExtractedPart`s (text + optional isReasoning flag).
 * This function handles SSE/JSONL parsing, `<tool_calls>` filtering,
 * reasoning gating, and buffer management — so providers don't have to.
 */
export async function processStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onChunk: StreamCallback,
  extractContent: (data: any) => ExtractedPart[] | null,
  options?: ProcessStreamOptions,
): Promise<{
  content: string;
  reasoning: string;
  usage?: ProviderUsageUpdate;
  usageFinalized?: Promise<{
    usage?: ProviderUsageUpdate;
    finishReason: ProviderFinishReason | null;
  }>;
  nativeReasoning?: Record<string, unknown>[];
  nativeReasoningFinalized?: Promise<Record<string, unknown>[] | undefined>;
  finishReason: ProviderFinishReason | null;
  stoppedByLocalStop: boolean;
  localStopReason?: "local_stop_sequence";
  localStopSequence?: string;
}> {
  const format = options?.format ?? "sse";
  const config = options?.config;
  const lines = streamLines(reader);
  // fullResponse accumulates RAW content (including <tool_calls> blocks)
  // so parseToolCallsFromResponse can extract them downstream.
  let fullResponse = "";
  let reasoningResponse = "";
  const localStopSequences = options?.localStopSequences ??
    getLocalStopSequences(config);
  const localStopState: LocalStopState = { pending: "" };
  let stoppedByLocalStop = false;
  const stopDebug = createStopDebug(config);
  stopDebug?.init({
    format,
    continueAfterLocalStop: options?.continueAfterLocalStop === true,
    localStopSequences,
  });
  const filterState = {
    activeTag: null as string | null,
    pending: "",
    controlPending: "",
  };
  let usage: ProviderUsageUpdate | undefined;
  let finishReason: ProviderFinishReason | null = null;
  let nativeReasoning: Record<string, unknown>[] | undefined;
  let releaseInBackground = false;

  /** Records usage, finish reason and native reasoning carried by an event. */
  const observeMetadata = (data: any) => {
    const blocks = options?.extractNativeReasoning?.(data);
    if (blocks && blocks.length > 0) {
      nativeReasoning = blocks.map((block) => structuredClone(block));
    }
    const update = options?.extractUsage?.(data);
    if (update) {
      usage = {
        inputTokens: update.inputTokens ?? usage?.inputTokens,
        outputTokens: update.outputTokens ?? usage?.outputTokens,
        reasoningTokens: update.reasoningTokens ?? usage?.reasoningTokens,
        cacheReadInputTokens: update.cacheReadInputTokens ??
          usage?.cacheReadInputTokens,
        cacheCreationInputTokens: update.cacheCreationInputTokens ??
          usage?.cacheCreationInputTokens,
        totalTokens: update.totalTokens ?? usage?.totalTokens,
        rawUsage: update.rawUsage ?? usage?.rawUsage ?? null,
      };
    }
    const reason = options?.extractFinishReason?.(data);
    if (reason) finishReason = reason;
  };

  const appendVisibleContent = (text: string) => {
    if (!text) return;
    fullResponse += text;
    const filtered = filterTaggedControlTokensStreaming(
      text,
      filterState,
      options?.extractedBlockTags ?? [],
      options?.onHiddenBlockChunk,
    );
    if (filtered) onChunk(filtered, { isReasoning: false });
  };

  /** Streams the parts of one event; true when a local stop sequence matched. */
  const handleParts = (parts: ExtractedPart[]): boolean => {
    for (const part of parts) {
      if (part.isReasoning) {
        reasoningResponse += part.text;
        if (config?.outputReasoning !== false) {
          onChunk(part.text, { isReasoning: true });
        }
        continue;
      }
      const { text, matchedStop } = applyLocalStopSequences(
        part.text,
        localStopSequences,
        localStopState,
      );
      appendVisibleContent(text);
      if (matchedStop) {
        stoppedByLocalStop = true;
        stopDebug?.matched(matchedStop, fullResponse.length);
        options?.onLocalStop?.(matchedStop);
        return true;
      }
    }
    return false;
  };

  /** After a stop, events only update metadata; their text is discarded. */
  const observeAfterStop = (line: string) => {
    const data = parseLine(line, format);
    if (!data) return;
    observeMetadata(data);
    if (stopDebug) stopDebug.afterStop(extractContent(data));
  };

  const drainForFinalUsage = async () => {
    try {
      // Lines from the chunk that held the stop are read before this
      // function first yields, so the immediate result already includes them.
      for (const line of lines.takeReceived()) observeAfterStop(line);
      for (let line; (line = await lines.next()) !== undefined;) {
        observeAfterStop(line);
      }
    } catch (error) {
      if ((error as { name?: unknown })?.name !== "AbortError") {
        console.warn("Stream final usage drain failed:", error);
      }
    } finally {
      releaseReader(reader);
    }
    stopDebug?.summary(finishReason);
    return {
      ...(usage ? { usage } : {}),
      finishReason,
      ...(nativeReasoning ? { nativeReasoning } : {}),
    };
  };

  const result = () => ({
    content: options?.postProcess
      ? options.postProcess(fullResponse)
      : fullResponse,
    reasoning: reasoningResponse,
    ...(usage ? { usage } : {}),
    ...(nativeReasoning ? { nativeReasoning } : {}),
    finishReason,
    stoppedByLocalStop,
    ...(stoppedByLocalStop
      ? { localStopReason: "local_stop_sequence" as const }
      : {}),
    ...(localStopState.matchedStop
      ? { localStopSequence: localStopState.matchedStop }
      : {}),
  });

  const localStopResult = () => {
    const finalized = options?.continueAfterLocalStop === true
      ? drainForFinalUsage()
      : undefined;
    if (!finalized) return result();
    releaseInBackground = true;
    return {
      ...result(),
      usageFinalized: finalized.then(({ usage, finishReason }) => ({
        ...(usage ? { usage } : {}),
        finishReason,
      })),
      nativeReasoningFinalized: finalized.then((final) =>
        final.nativeReasoning
      ),
    };
  };

  try {
    for (let line; (line = await lines.next()) !== undefined;) {
      const data = parseLine(line, format);
      if (!data) continue;
      observeMetadata(data);
      const parts = extractContent(data);
      if (parts && handleParts(parts)) return localStopResult();
    }
    if (localStopState.pending) {
      const pending = localStopState.pending;
      localStopState.pending = "";
      appendVisibleContent(pending);
    }
  } catch (error) {
    if (!stoppedByLocalStop) {
      if ((error as { name?: unknown })?.name !== "AbortError") {
        console.error("Stream processing error:", error);
      }
      throw error;
    }
  } finally {
    if (!releaseInBackground) releaseReader(reader);
  }

  return result();
}

export function filterTaggedControlTokensStreaming(
  input: string,
  state: { activeTag: string | null; pending: string; controlPending?: string },
  extractedBlockTags: string[],
  onHiddenBlockChunk?: (
    tagName: string,
    chunk: string,
    phase: "start" | "content" | "end",
  ) => void,
): string {
  const structuredTags = normalizeStructuredTagNames([
    ...COPILOTZ_CONTROL_TAGS,
    ...STREAMING_HIDDEN_PROTOCOL_TAGS,
    ...extractedBlockTags,
  ]).map((name) => ({
    name,
    endTag: `</${name}>`,
  }));

  let s = state.pending + input;
  state.pending = "";
  let output = "";

  while (s.length > 0) {
    if (!state.activeTag) {
      let nextMatch:
        | {
          index: number;
          tagName: string;
          tagLength: number;
          selfClosing: boolean;
        }
        | null = null;

      for (const tag of structuredTags) {
        const match = findStructuredStartTag(s, tag.name);
        const index = match?.index ?? -1;
        if (index === -1) continue;
        if (!nextMatch || index < nextMatch.index) {
          nextMatch = {
            index,
            tagName: tag.name,
            tagLength: match?.length ?? 0,
            selfClosing: match?.selfClosing ?? false,
          };
        }
      }

      if (!nextMatch) {
        let overlap = 0;
        for (const tag of structuredTags) {
          overlap = Math.max(
            overlap,
            structuredStartTagSuffixOverlap(s, tag.name),
          );
        }
        if (overlap > 0) {
          output += s.slice(0, s.length - overlap);
          state.pending = s.slice(s.length - overlap);
        } else {
          output += s;
        }
        s = "";
      } else {
        output += s.slice(0, nextMatch.index);
        s = s.slice(nextMatch.index + nextMatch.tagLength);
        onHiddenBlockChunk?.(nextMatch.tagName, "", "start");
        if (nextMatch.selfClosing) {
          onHiddenBlockChunk?.(nextMatch.tagName, "", "end");
        } else {
          state.activeTag = nextMatch.tagName;
        }
      }
    } else {
      const activeTag = structuredTags.find((tag) =>
        tag.name === state.activeTag
      );
      if (!activeTag) {
        state.activeTag = null;
        continue;
      }
      const endIdx = s.indexOf(activeTag.endTag);
      if (endIdx === -1) {
        const overlap = suffixPrefix(s, activeTag.endTag);
        const hiddenContent = s.slice(0, s.length - overlap);
        if (hiddenContent) {
          onHiddenBlockChunk?.(activeTag.name, hiddenContent, "content");
        }
        state.pending = s.slice(s.length - overlap);
        s = "";
      } else {
        const hiddenContent = s.slice(0, endIdx);
        if (hiddenContent) {
          onHiddenBlockChunk?.(activeTag.name, hiddenContent, "content");
        }
        s = s.slice(endIdx + activeTag.endTag.length);
        onHiddenBlockChunk?.(activeTag.name, "", "end");
        state.activeTag = null;
      }
    }
  }

  const literalState = { pending: state.controlPending ?? "" };
  const filteredOutput = stripLiteralControlTagsStreaming(
    output,
    literalState,
    [...INTERNAL_LITERAL_CONTROL_TAGS, ...STRUCTURAL_LEAK_LITERALS],
  );
  state.controlPending = literalState.pending;

  return filteredOutput;
}

function stripLiteralControlTagsStreaming(
  input: string,
  state: { pending: string },
  tags: string[],
): string {
  let s = state.pending + input;
  state.pending = "";
  let output = "";

  while (s.length > 0) {
    let earliestIdx = -1;
    let matchedTag = "";

    for (const tag of tags) {
      const idx = s.indexOf(tag);
      if (
        idx !== -1 &&
        (earliestIdx === -1 || idx < earliestIdx ||
          (idx === earliestIdx && tag.length > matchedTag.length))
      ) {
        earliestIdx = idx;
        matchedTag = tag;
      }
    }

    if (earliestIdx === -1) {
      const overlap = suffixPrefixAny(s, tags);
      if (overlap > 0) {
        output += s.slice(0, s.length - overlap);
        state.pending = s.slice(s.length - overlap);
      } else {
        output += s;
      }
      break;
    }

    output += s.slice(0, earliestIdx);
    s = s.slice(earliestIdx + matchedTag.length);
  }

  return output;
}
