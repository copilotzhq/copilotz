/**
 * Maximum characters returned in a single read (matches default history cap).
 */
const MAX_READ_CHARS = 10_000;
const MAX_REGEX_PATTERN_LEN = 256;

interface ReadToolResultParams {
  /** ID of the durable tool_execution node. Preferred for new histories. */
  toolExecutionId?: string;
  /** ULID of the `TOOL_RESULT` queue row (`toolResultQueueEventId` from truncated history). */
  queueEventId?: string;
  /** Character offset into the serialized tool `output` (ignored when `regex` is set). */
  offset?: number;
  /** Max characters to return (capped at 10_000). Ignored when `regex` is set. */
  limit?: number;
  /**
   * Optional ECMAScript regex pattern; first match is located and an excerpt
   * around it is returned (up to `MAX_READ_CHARS`). Mutually exclusive with
   * offset/limit slicing for the primary selection (offset still applied to excerpt edge cases).
   */
  regex?: string;
}

interface QueueEventRow {
  threadId?: unknown;
  eventType?: unknown;
  payload?: unknown;
}

function serializeToolOutput(output: unknown): string {
  if (output === null || output === undefined) return "";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

export default {
  key: "read_tool_result",
  name: "Read Tool Result",
  description:
    "Fetch the full serialized `output` from a durable tool_execution node, or a legacy TOOL_RESULT queue event, in this thread. " +
    "Use when history showed `_copilotz_history_truncated` with `toolExecutionId` or `toolResultQueueEventId`. " +
    "Either pass `offset` + `limit` (limit ≤ 10_000) or `regex` to search the payload.",
  inputSchema: {
    type: "object",
    properties: {
      queueEventId: {
        type: "string",
        description:
          "Legacy TOOL_RESULT queue event id (from toolResultQueueEventId in old history).",
      },
      toolExecutionId: {
        type: "string",
        description:
          "Durable tool_execution node id (from toolExecutionId in history).",
      },
      offset: {
        type: "number",
        description: "Start offset in characters into serialized output.",
        default: 0,
        minimum: 0,
      },
      limit: {
        type: "number",
        description: "Max characters to return (max 10_000).",
        default: 4000,
        minimum: 1,
        maximum: MAX_READ_CHARS,
      },
      regex: {
        type: "string",
        description:
          "Optional pattern; returns an excerpt around the first match.",
      },
    },
    required: [],
  },
  execute: async (
    {
      toolExecutionId,
      queueEventId,
      offset = 0,
      limit = 4000,
      regex,
    }: ReadToolResultParams,
    context?: {
      threadId?: string;
      db?: {
        ops: {
          getQueueItemById: (id: string) => Promise<unknown>;
          mutate?: {
            toolExecutions?: {
              getOutput: (
                id: string,
                threadId: string,
              ) => Promise<
                | {
                  node: unknown;
                  output: unknown;
                  projectedOutput?: unknown;
                }
                | null
              >;
            };
          };
        };
      };
    },
  ) => {
    const db = context?.db;
    const threadId = context?.threadId;
    if (!db?.ops?.getQueueItemById) {
      throw new Error(
        "read_tool_result requires a database-enabled Copilotz runtime.",
      );
    }
    if (typeof threadId !== "string" || threadId.length === 0) {
      throw new Error("read_tool_result requires an active thread id.");
    }

    if (typeof toolExecutionId === "string" && toolExecutionId.length > 0) {
      const execution = await db.ops.mutate?.toolExecutions?.getOutput(
        toolExecutionId,
        threadId,
      );
      if (!execution) {
        throw new Error(
          `No tool_execution found for id "${toolExecutionId}" in this thread.`,
        );
      }
      const serialized = serializeToolOutput(
        execution.projectedOutput ?? execution.output,
      );
      return sliceSerializedToolOutput({
        serialized,
        queueEventId: null,
        toolExecutionId,
        toolCallId: null,
        tool: null,
        offset,
        limit,
        regex,
      });
    }

    if (typeof queueEventId !== "string" || queueEventId.length === 0) {
      throw new Error(
        "read_tool_result requires toolExecutionId or legacy queueEventId.",
      );
    }

    const row = await db.ops.getQueueItemById(queueEventId) as QueueEventRow;
    if (!row) {
      throw new Error(`No queue event found for id "${queueEventId}".`);
    }
    if (row.threadId !== threadId) {
      throw new Error("Queue event does not belong to this thread.");
    }
    if (row.eventType !== "TOOL_RESULT") {
      throw new Error(
        `Event ${queueEventId} is "${row.eventType}", not TOOL_RESULT.`,
      );
    }

    const payload = row.payload as {
      output?: unknown;
      toolCallId?: string;
      tool?: { id?: string; name?: string };
    };
    const serialized = serializeToolOutput(payload.output);

    return sliceSerializedToolOutput({
      serialized,
      queueEventId,
      toolExecutionId: null,
      toolCallId: payload.toolCallId ?? null,
      tool: payload.tool ?? null,
      offset,
      limit,
      regex,
    });
  },
};

function sliceSerializedToolOutput(args: {
  serialized: string;
  queueEventId: string | null;
  toolExecutionId: string | null;
  toolCallId: string | null;
  tool: { id?: string; name?: string } | null;
  offset: number;
  limit: number;
  regex?: string;
}) {
  const {
    serialized,
    queueEventId,
    toolExecutionId,
    toolCallId,
    tool,
    offset,
    limit,
    regex,
  } = args;

  const capLimit = Math.min(
    Math.max(1, Math.floor(limit)),
    MAX_READ_CHARS,
  );
  const start = Math.max(0, Math.floor(offset));

  if (typeof regex === "string" && regex.trim().length > 0) {
    const pattern = regex.trim();
    if (pattern.length > MAX_REGEX_PATTERN_LEN) {
      throw new Error(
        `regex pattern exceeds ${MAX_REGEX_PATTERN_LEN} characters.`,
      );
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      throw new Error(
        `Invalid regex: ${(e as Error).message}`,
      );
    }
    const m = re.exec(serialized);
    if (!m || m.index === undefined) {
      return {
        queueEventId,
        toolExecutionId,
        toolCallId,
        tool,
        matchFound: false,
        totalLength: serialized.length,
      };
    }
    const idx = m.index;
    const half = Math.floor(MAX_READ_CHARS / 2);
    const sliceStart = Math.max(0, idx - half);
    let sliceEnd = Math.min(serialized.length, idx + m[0].length + half);
    if (sliceEnd - sliceStart > MAX_READ_CHARS) {
      sliceEnd = sliceStart + MAX_READ_CHARS;
    }
    const excerpt = serialized.slice(sliceStart, sliceEnd);
    return {
      queueEventId,
      toolExecutionId,
      toolCallId,
      tool,
      matchFound: true,
      matchIndex: idx,
      matchLength: m[0].length,
      excerptOffset: sliceStart,
      excerpt,
      excerptLength: excerpt.length,
      totalLength: serialized.length,
      truncatedExcerpt: sliceEnd < serialized.length || sliceStart > 0,
    };
  }

  const slice = serialized.slice(start, start + capLimit);
  return {
    queueEventId,
    toolExecutionId,
    toolCallId,
    tool,
    offset: start,
    limit: capLimit,
    slice,
    sliceLength: slice.length,
    totalLength: serialized.length,
    hasMore: start + slice.length < serialized.length,
  };
}
