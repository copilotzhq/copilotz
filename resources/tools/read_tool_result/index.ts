/**
 * Maximum characters returned in a single read (matches default history cap).
 */
const MAX_READ_CHARS = 10_000;
const MAX_REGEX_PATTERN_LEN = 256;

interface ReadToolResultParams {
  /** ULID of the `TOOL_RESULT` queue row (`toolResultQueueEventId` from truncated history). */
  queueEventId: string;
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
    "Fetch the full serialized `output` from a persisted TOOL_RESULT queue event in this thread. " +
    "Use when history showed `_copilotz_history_truncated` and `toolResultQueueEventId`. " +
    "Either pass `offset` + `limit` (limit ≤ 10_000) or `regex` to search the payload.",
  inputSchema: {
    type: "object",
    properties: {
      queueEventId: {
        type: "string",
        description:
          "TOOL_RESULT queue event id (from toolResultQueueEventId in history).",
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
    required: ["queueEventId"],
  },
  execute: async (
    {
      queueEventId,
      offset = 0,
      limit = 4000,
      regex,
    }: ReadToolResultParams,
    context?: {
      threadId?: string;
      db?: { ops: { getQueueItemById: (id: string) => Promise<unknown> } };
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
          toolCallId: payload.toolCallId ?? null,
          tool: payload.tool ?? null,
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
        toolCallId: payload.toolCallId ?? null,
        tool: payload.tool ?? null,
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
      toolCallId: payload.toolCallId ?? null,
      tool: payload.tool ?? null,
      offset: start,
      limit: capLimit,
      slice,
      sliceLength: slice.length,
      totalLength: serialized.length,
      hasMore: start + slice.length < serialized.length,
    };
  },
};
