/**
 * The demo's stand-in server: an Action transport that edits the fixture
 * tables, and a thread feed that streams scripted agent replies frame by
 * frame in the canonical observation format.
 * @module
 */
import type { ActionTransport } from "@copilotz/copilotz/web";
import type { FeedFrame, ThreadFeedAdapter } from "@copilotz/copilotz/core/web";
import type { FixtureLive } from "../../plugins/ui/tests/fixture-live.test.ts";
import { agents, assets } from "./fixtures.ts";

type Observer = (frame: FeedFrame) => void | Promise<void>;
const encoder = new TextEncoder();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One scripted stream, written in chunks like a real lane. */
class Lane {
  offset = 0;
  constructor(
    readonly feed: DemoFeed,
    readonly threadId: string,
    readonly streamId: string,
  ) {}
  write(text: string) {
    const bytes = encoder.encode(text);
    this.feed.emit(this.threadId, {
      kind: "stream-chunk",
      streamId: this.streamId,
      offset: this.offset,
      bytes,
      checkpoint: this.feed.checkpoint(),
    });
    this.offset += bytes.length;
  }
  end() {
    this.feed.emit(this.threadId, {
      kind: "stream-end",
      streamId: this.streamId,
      offset: this.offset,
      terminal: { outcome: "completed" },
      checkpoint: this.feed.checkpoint(),
    });
  }
}

export class DemoFeed implements ThreadFeedAdapter {
  private observers = new Map<string, Set<Observer>>();
  private position = 0;
  /** Frames already emitted per thread, replayed to late observers. */
  private history = new Map<string, FeedFrame[]>();
  cancelled = new Set<string>();

  constructor(readonly live: FixtureLive) {}

  checkpoint(): string {
    return String(++this.position);
  }

  emit(threadId: string, frame: FeedFrame) {
    const frames = this.history.get(threadId) ?? [];
    frames.push(frame);
    this.history.set(threadId, frames);
    for (const observer of this.observers.get(threadId) ?? []) {
      void observer(frame);
    }
  }

  observe(
    threadId: string,
    options: Parameters<ThreadFeedAdapter["observe"]>[1],
  ): Promise<string | undefined> {
    const set = this.observers.get(threadId) ?? new Set();
    this.observers.set(threadId, set);
    set.add(options.onFrame);
    for (const frame of this.history.get(threadId) ?? []) {
      void options.onFrame(frame);
    }
    return new Promise((resolve) => {
      options.signal.addEventListener("abort", () => {
        set.delete(options.onFrame);
        resolve(undefined);
      }, { once: true });
    });
  }

  cancel(operationId: string): Promise<void> {
    this.cancelled.add(operationId);
    return Promise.resolve();
  }

  asset(
    _threadId: string,
    _messageId: string,
    assetId: string,
  ): Promise<Blob> {
    const asset = assets[assetId];
    return asset
      ? Promise.resolve(new Blob([asset.body], { type: asset.type }))
      : Promise.reject(new Error("Not found"));
  }

  lane(
    threadId: string,
    operationId: string,
    streamId: string,
    metadata: Record<string, unknown>,
    role: string,
  ): Lane {
    this.emit(threadId, {
      kind: "output",
      checkpoint: this.checkpoint(),
      output: {
        type: "stream.output",
        operationId,
        streamId,
        role,
        kind: "text",
        mediaType: "text/plain",
        metadata,
      },
    });
    return new Lane(this, threadId, streamId);
  }

  event(threadId: string, output: Record<string, unknown> & { type: string }) {
    this.emit(threadId, {
      kind: "output",
      checkpoint: this.checkpoint(),
      output,
    });
  }
}

function llm(
  attemptId: string,
  agent: { id: string; name: string },
  lane: string,
) {
  return {
    llmAttemptId: attemptId,
    lane,
    providerAttemptIndex: 0,
    copilotzCore: {
      schema: "copilotz.core.llm-stream.v1",
      agent: { id: agent.id, name: agent.name },
    },
  };
}

/**
 * East's live reply in the launch conversation: reasoning, a terminal call
 * and its stdout, then a sentence still being written. With `freeze` it stops
 * mid-reply (for screenshots); otherwise it finishes and persists.
 */
export async function playLaunchReply(
  feed: DemoFeed,
  options: { freeze: boolean; pace?: number },
): Promise<void> {
  const pace = options.pace ?? 1;
  const thread = "t-plan", op = "op-east", run = "run-east-1";
  const east = { id: "east", name: "East" };
  feed.event(thread, { type: "message.created", operationId: op });
  const reasoning = feed.lane(
    thread,
    op,
    "s-east-r",
    llm(run, east, "reasoning"),
    "reasoning",
  );
  for (
    const part of [
      "Run the tests in the Space's ",
      "default environment and report failures.",
    ]
  ) {
    reasoning.write(part);
    await sleep(120 * pace);
  }
  reasoning.end();
  const tools = feed.lane(
    thread,
    op,
    "s-east-t",
    llm(run, east, "tool-calls"),
    "tool-calls",
  );
  tools.write(
    JSON.stringify({
      draftId: "d1",
      callIndex: 0,
      sequence: 0,
      toolName: "terminal",
      phase: "start",
      delta: "",
    }) + "\n",
  );
  tools.write(
    JSON.stringify({
      draftId: "d1",
      callIndex: 0,
      sequence: 1,
      toolName: "terminal",
      phase: "complete",
      toolCallId: "tc2",
      delta: '{"stdin":"deno task test --filter launch"}',
    }) + "\n",
  );
  tools.end();
  feed.event(thread, {
    type: "action.invoked",
    operationId: op,
    data: {
      actionRunId: "run-terminal-1",
      metadata: {
        copilotzToolAction: { toolCallId: "tc2", planMessageId: "m5" },
      },
    },
  });
  const stdout = feed.lane(
    thread,
    op,
    "s-term-out",
    { sourceActionRunId: "run-terminal-1", channel: "stdout" },
    "stdout",
  );
  const content = feed.lane(
    thread,
    op,
    "s-east-c",
    llm(run, east, "content"),
    "content",
  );
  const lines = [
    "Task test deno test -A --filter launch\n",
    "running 14 tests from ./tests/launch.test.ts\n",
    "pricing defaults ... ok (12ms)\n",
    "funnel math ... ok (3ms)\n",
    "landing page links ... ",
  ];
  for (const [index, line] of lines.entries()) {
    stdout.write(line);
    if (index === 1) content.write("Running the launch suite now. ");
    if (index === 3) content.write("So far 2 of 14 tests pass");
    await sleep(160 * pace);
  }
  if (options.freeze) return;
  stdout.write("ok (41ms)\n…\nok | 14 passed | 0 failed (1s)\n");
  await sleep(300 * pace);
  stdout.end();
  content.write(
    ", and the rest are green now: **14 of 14 passed** in about a second. The plan is safe to share.",
  );
  await sleep(200 * pace);
  content.end();
  const now = new Date().toISOString();
  feed.live.put("message", {
    id: "m5",
    threadId: thread,
    senderId: "p-east",
    recipientIds: [],
    content: [{
      assetId: "text-m5",
      kind: "text",
      role: "body",
      mediaType: "text/markdown",
      value:
        "Running the launch suite now. So far 2 of 14 tests pass, and the rest are green now: **14 of 14 passed** in about a second. The plan is safe to share.",
    }],
    metadata: {
      copilotzWorkflow: { kind: "agent_output", llmAttemptId: run },
      llmToolCalls: [{
        id: "tc2",
        action: "terminal",
        input: { stdin: "deno task test --filter launch" },
      }],
    },
    createdAt: now,
    updatedAt: now,
  }, {
    id: "m5-result",
    threadId: thread,
    senderId: "p-terminal",
    recipientIds: [],
    content: [{
      assetId: "text-m5r",
      kind: "text",
      role: "tool.output",
      mediaType: "text/plain",
      value: "ok | 14 passed | 0 failed (1s)",
    }],
    metadata: { toolInvocation: { id: "tc2" }, toolStatus: "completed" },
    createdAt: now,
    updatedAt: now,
  });
  feed.event(thread, { type: "operation.completed", operationId: op });
}

const replies = [
  "Good question. Here's how I'd approach it:\n\n1. **Clarify the goal** in one sentence.\n2. **List the constraints** we already know.\n3. **Pick one experiment** we can run this week.\n\nWant me to put these on the board?",
  "On it. I'll keep the answer short and link anything I change in this Space.",
];

/** A short streamed answer to whatever the person sent. */
async function reply(feed: DemoFeed, threadId: string, operationId: string) {
  const agent = agents[Math.floor(Math.random() * agents.length)];
  const run = `run-${crypto.randomUUID()}`;
  const meta = (lane: string) =>
    llm(run, { id: agent.agentId, name: agent.name }, lane);
  await sleep(500);
  const thinking = feed.lane(
    threadId,
    operationId,
    `${run}-r`,
    meta("reasoning"),
    "reasoning",
  );
  thinking.write("Answer directly; offer one next step.");
  await sleep(500);
  thinking.end();
  const content = feed.lane(
    threadId,
    operationId,
    `${run}-c`,
    meta("content"),
    "content",
  );
  const text = replies[Math.floor(Math.random() * replies.length)];
  let written = "";
  for (const word of text.split(/(?<= )/)) {
    if (feed.cancelled.has(operationId)) break;
    content.write(word);
    written += word;
    await sleep(45);
  }
  content.end();
  const now = new Date().toISOString();
  feed.live.put("message", {
    id: `reply-${run}`,
    threadId,
    senderId: agent.id,
    recipientIds: [],
    content: [{
      assetId: `text-${run}`,
      kind: "text",
      role: "body",
      mediaType: "text/markdown",
      value: written,
    }],
    metadata: { copilotzWorkflow: { kind: "agent_output", llmAttemptId: run } },
    createdAt: now,
    updatedAt: now,
  });
  feed.live.patch("thread", threadId, { updatedAt: now });
  feed.event(threadId, {
    type: feed.cancelled.has(operationId)
      ? "operation.cancelled"
      : "operation.completed",
    operationId,
  });
}

/** Executes the composed Actions against the fixture tables. */
export function demoActions(
  live: FixtureLive,
  feed: DemoFeed,
): ActionTransport {
  let sequence = 1000;
  const done = (value: unknown = {}) =>
    Promise.resolve({ value, seq: ++sequence });
  return {
    async invoke(alias, input, options) {
      const operationId = `op-${crypto.randomUUID()}`;
      options.accepted(operationId);
      await sleep(120);
      const data = (input ?? {}) as Record<string, unknown>;
      const now = new Date().toISOString();
      switch (alias) {
        case "createThread": {
          const participants =
            (data.participants as Record<string, unknown>[] ?? [])
              .map((participant) =>
                participant.participantType === "agent"
                  ? `p-${participant.agentId}`
                  : "p-ana"
              );
          live.put("thread", {
            id: String(data.id),
            name: String(data.name ?? "New conversation"),
            status: "active",
            ...(data.spaceId ? { spaceId: data.spaceId } : {}),
            participantIds: [...new Set(["p-ana", ...participants])],
            metadata: {},
            createdAt: now,
            updatedAt: now,
          });
          return done({ id: data.id });
        }
        case "createThreadMessage": {
          const threadId = String(data.threadId);
          live.put("message", {
            id: String(data.id),
            threadId,
            senderId: "p-ana",
            recipientIds: data.recipientIds ?? [],
            content: (data.content as Record<string, unknown>[]).map((part) =>
              part.type === "text"
                ? {
                  assetId: `text-${data.id}`,
                  kind: "text",
                  role: "body",
                  mediaType: "text/markdown",
                  value: part.text,
                }
                : {
                  assetId: `asset-${crypto.randomUUID()}`,
                  kind: part.type ?? part.kind,
                  role: "attachment",
                  mediaType: part.mediaType,
                  name: part.name,
                }
            ),
            metadata: {},
            createdAt: now,
            updatedAt: now,
          });
          live.patch("thread", threadId, { updatedAt: now });
          feed.event(threadId, { type: "message.created", operationId });
          void reply(feed, threadId, operationId);
          return done({ id: data.id });
        }
        case "updateConversation":
          live.patch("thread", String(data.threadId), {
            ...(data.patch as object),
            updatedAt: now,
          });
          return done();
        case "deleteConversation":
          live.remove("thread", String(data.threadId));
          return done();
        case "reviseMessage":
          live.patch("message", String(data.messageId), {
            content: [{
              assetId: `text-${data.id}`,
              kind: "text",
              role: "body",
              mediaType: "text/markdown",
              value: (data.content as { text: string }[])[0]?.text ?? "",
            }],
            revision: { previousRevisionMessageId: data.messageId },
          });
          return done();
        case "spaces": {
          const spaceId = String(data.spaceId ?? "");
          if (data.operation === "create") {
            const id = `sp-${crypto.randomUUID().slice(0, 8)}`;
            live.put("space", {
              id,
              name: data.name,
              description: data.description ?? "",
              ownerId: "p-ana",
              memberIds: ["p-ana"],
              status: "active",
              revision: 0,
              createdAt: now,
              updatedAt: now,
            });
            return done({ spaceId: id, operation: "create" });
          }
          if (data.operation === "update") {
            live.patch("space", spaceId, {
              ...(data.name !== undefined ? { name: data.name } : {}),
              ...(data.description !== undefined
                ? { description: data.description }
                : {}),
              updatedAt: now,
            });
          } else if (data.operation === "remove") {
            for (const thread of live.rows("thread")) {
              if (thread.spaceId === spaceId) {
                const { spaceId: _gone, ...rest } = thread;
                live.put("thread", rest);
              }
            }
            live.remove("space", spaceId);
          } else if (data.operation === "attach") {
            live.patch("thread", String(data.recordId), { spaceId });
          } else if (data.operation === "detach") {
            const thread = live.get("thread", String(data.recordId));
            if (thread) {
              const { spaceId: _gone, ...rest } = thread;
              live.put("thread", rest);
            }
          } else if (data.operation === "removeMember") {
            const space = live.get("space", spaceId);
            live.patch("space", spaceId, {
              memberIds: (space?.memberIds as string[] ?? []).filter((id) =>
                id !== data.participantId
              ),
            });
          }
          return done({ spaceId });
        }
        case "addThreadParticipant": {
          const thread = live.get("thread", String(data.threadId));
          const participant = data.participant as Record<string, unknown>;
          live.patch("thread", String(data.threadId), {
            participantIds: [
              ...(thread?.participantIds as string[] ?? []),
              `p-${participant.agentId}`,
            ],
          });
          return done();
        }
        default:
          return done({ ok: true });
      }
    },
    cancel(operationId) {
      feed.cancelled.add(operationId);
      return Promise.resolve();
    },
  };
}
