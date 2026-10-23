/**
 * Framework-free projection of a thread's observation feed (`POST
 * /threads/:id/observe`) into display state: live agent replies with their
 * text, reasoning and tool-call drafts, the operations still running, and
 * who they wait on (the participants their messages addressed).
 *
 * Lane identity comes from each stream descriptor's metadata (`llmAttemptId`,
 * `lane`, `providerAttemptIndex`), never from timing. Bytes are applied by
 * offset, so a replayed prefix is never appended twice.
 * @module
 */
import { coreStreamAgent } from "./workflow-metadata.ts";

/** A frame as the SDK decodes it (`ObservationFrame` from `/client`). */
export type FeedFrame =
  | Readonly<{
    kind: "output";
    output: Readonly<Record<string, unknown> & { type: string }>;
    checkpoint: string;
  }>
  | Readonly<{
    kind: "stream-chunk";
    streamId: string;
    offset: number;
    bytes: Uint8Array;
    checkpoint: string;
  }>
  | Readonly<{
    kind: "stream-end" | "stream-error";
    streamId: string;
    offset: number;
    terminal: Readonly<Record<string, unknown>>;
    checkpoint: string;
  }>;

/** A tool call the model is still writing, or has finished writing. */
export type FeedToolDraft = Readonly<{
  id: string;
  name: string;
  /** The raw, possibly partial, JSON arguments. */
  input: string;
  phase: "streaming" | "complete";
  toolCallId?: string;
}>;

/** One live agent reply (an LLM call attempt). */
export type FeedAttempt = Readonly<{
  attemptId: string;
  operationId: string;
  agent?: Readonly<{ id: string; name: string }>;
  text: string;
  reasoning: string;
  tools: readonly FeedToolDraft[];
  status: "streaming" | "complete" | "failed";
  /** The provider fallback index; a later candidate replaces the earlier one. */
  candidate: number;
  startedAt: number;
  updatedAt: number;
}>;

/**
 * A participant a running operation waits on: a message in it addressed them
 * (`recipientIds`) and they have not replied yet.
 */
export type FeedTurn = Readonly<{
  participantId: string;
  operationId: string;
  /** The agent whose question this answers (Core's `ask`), by participant id. */
  askedBy?: string;
  /** When the message addressed them, on the projector's clock. */
  since: number;
}>;

export type FeedState = Readonly<{
  attempts: readonly FeedAttempt[];
  /** Operations that produced output in this thread and have not settled. */
  active: readonly string[];
  /**
   * Progressive output of running tools, by tool call id (or tool Action run
   * id when the call is unknown), then by channel such as `stdout`.
   */
  outputs: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * Who the running operations wait on, oldest first: each participant a
   * message in them addressed, until their reply without tool calls (with
   * tool calls they go on once the tools settle) or the operation settles.
   * Known before any reply streams, so a View can say who is replying.
   */
  turns: readonly FeedTurn[];
  /**
   * Running operations whose messages said who replies: for these, `turns`
   * is complete, and no turn means no one is replying.
   */
  routed: readonly string[];
  /**
   * Messages a reply has begun for: those created in a running operation in
   * which an agent's reply has started to stream.
   */
  replied: readonly string[];
}>;

type Lane = {
  /** A tool's output lane: the tool call (or run) id and its channel. */
  tool?: { id: string; channel: string };
  attemptId: string;
  operationId: string;
  role: string;
  candidate: number;
  offset: number;
  pending: Uint8Array;
  line: string;
  ended: boolean;
  failed: boolean;
};
type MutableAttempt = {
  -readonly [K in keyof FeedAttempt]: FeedAttempt[K] extends
    readonly FeedToolDraft[] ? FeedToolDraft[] : FeedAttempt[K];
};

const TEXT_LIMIT = 512 * 1024;
/** Tool output keeps its newest text, like a terminal's scrollback. */
const OUTPUT_LIMIT = 64 * 1024;
const ATTEMPT_LIMIT = 16;
/** The first messages of an operation are the ones a reply answers. */
const OPERATION_MESSAGE_LIMIT = 16;
const decoder = new TextDecoder("utf-8", { fatal: true });

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/** Decode the longest valid UTF-8 prefix; keep an incomplete tail for later. */
function decode(bytes: Uint8Array): { text: string; pending: Uint8Array } {
  for (let tail = 0; tail <= Math.min(3, bytes.length); tail++) {
    try {
      return {
        text: decoder.decode(bytes.subarray(0, bytes.length - tail)),
        pending: bytes.slice(bytes.length - tail),
      };
    } catch { /* an incomplete multi-byte character at the end */ }
  }
  // Invalid UTF-8 is never surfaced as text.
  return { text: "", pending: new Uint8Array() };
}

/** A stateful projector; `snapshot()` is plain, cloneable display data. */
export function createFeedProjector(
  now: () => number = Date.now,
): {
  apply(frame: FeedFrame): boolean;
  snapshot(): FeedState;
  /** Drop settled attempts the caller has seen persisted, or that timed out. */
  forget(attemptIds: readonly string[]): boolean;
} {
  const lanes = new Map<string, Lane>();
  const attempts = new Map<string, MutableAttempt>();
  const active = new Set<string>();
  const settled = new Set<string>();
  /** Tool Action run id → the tool call it executes. */
  const toolRuns = new Map<string, string>();
  const outputs = new Map<string, Record<string, string>>();
  /** Turns by operation and participant. */
  const turns = new Map<string, FeedTurn>();
  const routed = new Set<string>();
  /** The messages each running operation created, oldest first. */
  const messages = new Map<string, string[]>();
  /** Running operations in which a reply has started to stream. */
  const replying = new Set<string>();

  /**
   * A message in a running operation: an agent's reply without tool calls
   * ends that agent's turn, and its recipients' turns begin. Ask progress and
   * answers, and messages that continue nothing, address no one new.
   */
  const noteMessage = (operationId: string, row: Record<string, unknown>) => {
    let changed = false;
    const id = text(row.id);
    const list = messages.get(operationId) ?? [];
    if (id && list.length < OPERATION_MESSAGE_LIMIT && !list.includes(id)) {
      messages.set(operationId, [...list, id]);
      changed = replying.has(operationId);
    }
    const sender = text(row.senderId);
    const metadata = record(row.metadata);
    const flow = record(metadata.copilotzWorkflow);
    const ask = record(metadata.copilotzAsk);
    const calls = Array.isArray(metadata.llmToolCalls) &&
      metadata.llmToolCalls.length > 0;
    if (
      sender && !calls &&
      (flow.kind === "agent_output" || flow.kind === "agent_failure")
    ) {
      changed = turns.delete(`${operationId}\n${sender}`) || changed;
    }
    if (
      ask.phase === "progress" || ask.phase === "answer" ||
      flow.continuation === "none" || flow.continuation === "realtime"
    ) return changed;
    if (!routed.has(operationId)) {
      routed.add(operationId);
      changed = true;
    }
    const recipients = Array.isArray(row.recipientIds) ? row.recipientIds : [];
    for (const participantId of recipients.map(text)) {
      if (!participantId || participantId === sender) continue;
      const key = `${operationId}\n${participantId}`;
      if (turns.has(key)) continue;
      turns.set(key, {
        participantId,
        operationId,
        ...(ask.phase === "question" && sender ? { askedBy: sender } : {}),
        since: now(),
      });
      changed = true;
    }
    return changed;
  };

  const attemptFor = (
    id: string,
    operationId: string,
    candidate: number,
    agent?: { id: string; name: string },
  ): MutableAttempt => {
    let attempt = attempts.get(id);
    if (!attempt) {
      attempt = {
        attemptId: id,
        operationId,
        ...(agent ? { agent } : {}),
        text: "",
        reasoning: "",
        tools: [],
        status: "streaming",
        candidate,
        startedAt: now(),
        updatedAt: now(),
      };
      attempts.set(id, attempt);
      while (attempts.size > ATTEMPT_LIMIT) {
        const oldest = [...attempts.values()].find((value) =>
          value.status !== "streaming"
        ) ?? attempts.values().next().value!;
        attempts.delete(oldest.attemptId);
      }
    } else if (candidate > attempt.candidate) {
      // A provider fallback replaces the provisional output of the earlier one.
      Object.assign(attempt, {
        text: "",
        reasoning: "",
        tools: [],
        status: "streaming",
        candidate,
      });
    }
    if (agent && !attempt.agent) attempt.agent = agent;
    return attempt;
  };

  const toolLine = (attempt: MutableAttempt, line: string) => {
    let delta: Record<string, unknown>;
    try {
      delta = record(JSON.parse(line));
    } catch {
      return;
    }
    const id = text(delta.draftId);
    if (!id) return;
    const phase = delta.phase;
    const index = attempt.tools.findIndex((tool) => tool.id === id);
    if (phase === "discarded") {
      if (index >= 0) attempt.tools.splice(index, 1);
      return;
    }
    const previous = index >= 0 ? attempt.tools[index] : undefined;
    const next: FeedToolDraft = {
      id,
      name: text(delta.toolName) || previous?.name || "tool",
      input: (previous?.input ?? "") +
        (typeof delta.delta === "string" ? delta.delta : ""),
      phase: phase === "complete" ? "complete" : "streaming",
      ...(text(delta.toolCallId) || previous?.toolCallId
        ? { toolCallId: text(delta.toolCallId) || previous?.toolCallId }
        : {}),
    };
    if (index >= 0) attempt.tools[index] = next;
    else attempt.tools.push(next);
  };

  return {
    apply(frame) {
      if (frame.kind === "output") {
        const output = frame.output;
        const operationId = text(output.operationId);
        const type = output.type;
        if (type === "operation.settled") {
          if (!operationId) return false;
          active.delete(operationId);
          settled.add(operationId);
          for (const [key, turn] of turns) {
            if (turn.operationId === operationId) turns.delete(key);
          }
          routed.delete(operationId);
          messages.delete(operationId);
          replying.delete(operationId);
          for (const attempt of attempts.values()) {
            if (
              attempt.operationId === operationId &&
              attempt.status === "streaming"
            ) {
              attempt.status = output.outcome === "completed"
                ? "complete"
                : "failed";
              attempt.updatedAt = now();
            }
          }
          return true;
        }
        let changed = false;
        if (
          operationId && !settled.has(operationId) && !active.has(operationId)
        ) {
          active.add(operationId);
          changed = true;
        }
        const metadata = record(output.metadata);
        const data = type === "stream.output"
          ? record(metadata.sourceAction)
          : record(output.data);
        const origin = record(record(data.metadata).copilotzToolAction);
        if (text(data.actionRunId) && text(origin.toolCallId)) {
          toolRuns.set(text(data.actionRunId), text(origin.toolCallId));
        }
        if (/^llm\.call\.(completed|failed|cancelled)$/.test(type)) {
          const run = text(record(output.data).actionRunId);
          const attempt = attempts.get(run);
          if (attempt && attempt.status === "streaming") {
            attempt.status = type === "llm.call.completed"
              ? "complete"
              : "failed";
            attempt.updatedAt = now();
            return true;
          }
          return changed;
        }
        if (
          type === "message.created" && operationId &&
          !settled.has(operationId)
        ) {
          return noteMessage(operationId, record(data.record)) || changed;
        }
        if (type !== "stream.output") return changed;
        const streamId = text(output.streamId);
        if (!streamId || lanes.has(streamId)) return changed;
        const role = text(metadata.lane) || text(output.role);
        const llm = text(metadata.llmAttemptId);
        const run = text(metadata.sourceActionRunId);
        if (!llm && run && String(output.kind ?? "text") === "text") {
          // A tool Action's progressive output, such as a terminal's stdout.
          lanes.set(streamId, {
            tool: {
              id: toolRuns.get(run) ?? run,
              channel: text(metadata.channel) || role || "output",
            },
            attemptId: "",
            operationId,
            role,
            candidate: 0,
            offset: 0,
            pending: new Uint8Array(),
            line: "",
            ended: false,
            failed: false,
          });
          return changed;
        }
        const attemptId = llm || run;
        if (
          !attemptId ||
          !["content", "reasoning", "tool-calls", "tool-call-drafts"]
            .includes(role)
        ) return changed;
        const candidate = typeof metadata.providerAttemptIndex === "number"
          ? metadata.providerAttemptIndex
          : 0;
        const current = attempts.get(attemptId);
        if (current && candidate < current.candidate) {
          // An earlier candidate replayed after its replacement: ignore it.
          lanes.set(streamId, {
            attemptId: "",
            operationId,
            role,
            candidate,
            offset: 0,
            pending: new Uint8Array(),
            line: "",
            ended: true,
            failed: false,
          });
          return changed;
        }
        lanes.set(streamId, {
          attemptId,
          operationId,
          role,
          candidate,
          offset: 0,
          pending: new Uint8Array(),
          line: "",
          ended: false,
          failed: false,
        });
        attemptFor(
          attemptId,
          operationId,
          candidate,
          coreStreamAgent({ metadata }),
        );
        if (operationId && !settled.has(operationId)) {
          replying.add(operationId);
        }
        return true;
      }
      const lane = lanes.get(frame.streamId);
      if (lane?.tool && frame.kind === "stream-chunk") {
        if (frame.offset + frame.bytes.length <= lane.offset) return false;
        if (frame.offset > lane.offset) {
          throw new RangeError("Stream replay has an unapplied byte gap.");
        }
        const bytes = frame.bytes.subarray(lane.offset - frame.offset);
        lane.offset = frame.offset + frame.bytes.length;
        const joined = new Uint8Array(lane.pending.length + bytes.length);
        joined.set(lane.pending);
        joined.set(bytes, lane.pending.length);
        const decoded = decode(joined);
        lane.pending = decoded.pending;
        if (!decoded.text) return false;
        const channels = outputs.get(lane.tool.id) ?? {};
        const next = (channels[lane.tool.channel] ?? "") + decoded.text;
        channels[lane.tool.channel] = next.length > OUTPUT_LIMIT
          ? next.slice(next.length - OUTPUT_LIMIT)
          : next;
        outputs.set(lane.tool.id, channels);
        return true;
      }
      if (lane?.tool) {
        lane.ended = true;
        return false;
      }
      if (!lane || !lane.attemptId) return false;
      const attempt = attempts.get(lane.attemptId);
      if (!attempt || attempt.candidate !== lane.candidate) return false;
      if (frame.kind === "stream-chunk") {
        if (frame.offset + frame.bytes.length <= lane.offset) return false;
        if (frame.offset > lane.offset) {
          // A gap means the feed must replay; never splice around it.
          throw new RangeError("Stream replay has an unapplied byte gap.");
        }
        const bytes = frame.bytes.subarray(lane.offset - frame.offset);
        lane.offset = frame.offset + frame.bytes.length;
        const joined = new Uint8Array(lane.pending.length + bytes.length);
        joined.set(lane.pending);
        joined.set(bytes, lane.pending.length);
        const decoded = decode(joined);
        lane.pending = decoded.pending;
        if (!decoded.text) return false;
        if (lane.role === "content") {
          if (attempt.text.length < TEXT_LIMIT) attempt.text += decoded.text;
        } else if (lane.role === "reasoning") {
          if (attempt.reasoning.length < TEXT_LIMIT) {
            attempt.reasoning += decoded.text;
          }
        } else {
          const lines = (lane.line + decoded.text).split("\n");
          lane.line = lines.pop() ?? "";
          for (const line of lines) if (line.trim()) toolLine(attempt, line);
        }
        attempt.updatedAt = now();
        return true;
      }
      lane.ended = true;
      lane.failed = frame.kind === "stream-error";
      if (lane.line.trim()) toolLine(attempt, lane.line);
      lane.line = "";
      // A physical lane can fail while its delivery retries. Only durable
      // Action/operation terminals settle the logical reply above.
      return true;
    },
    snapshot() {
      return {
        attempts: [...attempts.values()].map((attempt) => ({
          ...attempt,
          tools: attempt.tools.map((tool) => ({ ...tool })),
        })),
        active: [...active],
        outputs: Object.fromEntries(
          [...outputs].map(([id, channels]) => [id, { ...channels }]),
        ),
        turns: [...turns.values()].sort((left, right) =>
          left.since - right.since
        ).map((turn) => ({ ...turn })),
        routed: [...routed],
        replied: [...replying].flatMap((id) => messages.get(id) ?? []),
      };
    },
    forget(attemptIds) {
      let changed = false;
      for (const id of attemptIds) {
        const attempt = attempts.get(id);
        if (attempt && attempt.status !== "streaming") {
          attempts.delete(id);
          for (const [streamId, lane] of lanes) {
            if (lane.attemptId === id) lane.attemptId = "";
            if (!lane.attemptId && lane.ended) lanes.delete(streamId);
          }
          changed = true;
        }
      }
      return changed;
    },
  };
}
