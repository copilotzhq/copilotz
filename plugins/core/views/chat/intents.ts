/**
 * Chat intents: what the shell and Views ask for (send, rename, move…), as
 * browser Actions over the app's composed server Actions. An app whose
 * server Actions differ replaces individual intents.
 * @module
 */
import type {
  BrowserActionContext,
  BrowserActionDefinition,
} from "@copilotz/copilotz/web";
import { monotonicUlid } from "../../../../dependencies/ulid.ts";
import { createFeedProjector } from "../../shared/chat-feed.ts";
import type { ThreadFeedAdapter } from "./host.ts";

/** Logical server Actions the default intents call, and their default aliases. */
export const coreActionAliases = {
  createThread: "createThread",
  createThreadMessage: "createThreadMessage",
  reviseMessage: "reviseMessage",
  addThreadParticipant: "addThreadParticipant",
  spaces: "spaces",
  updateConversation: "updateConversation",
  deleteConversation: "deleteConversation",
} as const;
export type CoreActionName = keyof typeof coreActionAliases;

/** Every intent and its input. Each resolves when the change is accepted. */
export interface ChatIntentInputs {
  chatSend: {
    threadId?: string;
    text: string;
    files?: readonly File[];
    /** Participants addressed; omitted lets Core address every agent. */
    recipientIds?: readonly string[];
    /** Agents addressed by external id (`resources.chat.agents` entries). */
    recipientAgents?: readonly Record<string, unknown>[];
    /** A new conversation's Space. */
    spaceId?: string;
    /**
     * Create the conversation `threadId` names first (it does not exist yet):
     * the first message shows at once and a retry continues the same thread.
     */
    create?: { name?: string; spaceId?: string };
    /** Retry this outbox message with its original id. */
    retry?: string;
  };
  chatDiscard: { messageId: string };
  chatRevise: { threadId: string; messageId: string; text: string };
  chatCreateThread: { name?: string; spaceId?: string };
  chatRenameThread: { threadId: string; name: string };
  chatArchiveThread: { threadId: string; archived: boolean };
  chatDeleteThread: { threadId: string };
  chatMoveThread: {
    threadId: string;
    spaceId: string | null;
    fromSpaceId?: string | null;
  };
  chatCreateSpace: { name: string; description?: string };
  chatUpdateSpace: { spaceId: string; name?: string; description?: string };
  chatDeleteSpace: { spaceId: string };
  chatAddMember: { spaceId: string; email?: string; participantId?: string };
  chatRemoveMember: { spaceId: string; participantId: string };
  chatAddAgent: { threadId: string; participant: Record<string, unknown> };
  chatFollow: { threadId: string };
  chatStop: { threadId: string };
}
export type ChatIntentName = keyof ChatIntentInputs;

/**
 * The server Actions each default intent calls. The core plugin declares a
 * server proxy only for Actions a default intent still in use calls, so an
 * app that replaces every Space intent declares no `spaces` proxy.
 */
export const intentServerActions: Readonly<
  Record<ChatIntentName, readonly CoreActionName[]>
> = {
  chatSend: ["createThread", "createThreadMessage"],
  chatDiscard: [],
  chatRevise: ["reviseMessage"],
  chatCreateThread: ["createThread"],
  chatRenameThread: ["updateConversation"],
  chatArchiveThread: ["updateConversation"],
  chatDeleteThread: ["deleteConversation"],
  chatMoveThread: ["spaces"],
  chatCreateSpace: ["spaces"],
  chatUpdateSpace: ["spaces"],
  chatDeleteSpace: ["spaces"],
  chatAddMember: ["spaces"],
  chatRemoveMember: ["spaces"],
  chatAddAgent: ["addThreadParticipant"],
  chatFollow: [],
  chatStop: [],
};
export type ChatIntent<N extends ChatIntentName = ChatIntentName> = (
  input: ChatIntentInputs[N],
  ctx: BrowserActionContext,
) => unknown | Promise<unknown>;
export type ChatIntents = { [N in ChatIntentName]: ChatIntent<N> };

type Aliases = Readonly<Record<CoreActionName, string>>;

/**
 * A create that conflicts with an existing record repeats one that already
 * happened (the same client-chosen id): it is done, not failed.
 */
function alreadyDone(error: unknown): undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === "collection_conflict") return undefined;
  throw error;
}

/** A failed send's message: plain words, never a raw server error. */
function sendFailure(error: unknown): string {
  const failure = error as { status?: unknown; code?: unknown } | undefined;
  const status = typeof failure?.status === "number" ? failure.status : 0;
  if (status === 401 || failure?.code === "unauthorized") {
    return "Sign in again to send this message.";
  }
  if (status === 403 || failure?.code === "forbidden") {
    return "You can't send messages here.";
  }
  return "Not sent. Check your connection and try again.";
}

function call(
  ctx: BrowserActionContext,
  alias: string,
  input: unknown,
): Promise<unknown> {
  const action = ctx.actions[alias];
  if (!action) {
    return Promise.reject(
      new Error(`This app does not offer '${alias}'.`),
    );
  }
  return action(input).result();
}

function sender(ctx: BrowserActionContext): Record<string, unknown> {
  const value = (ctx.resources.chat as Record<string, unknown> | undefined)
    ?.sender;
  if (!value || typeof value !== "object") {
    throw new Error("Sign in to send messages.");
  }
  return value as Record<string, unknown>;
}

/** Agents an app adds to every new conversation (`resources.chat.agents`). */
function defaultAgents(ctx: BrowserActionContext): Record<string, unknown>[] {
  const agents = (ctx.resources.chat as Record<string, unknown> | undefined)
    ?.agents;
  return Array.isArray(agents)
    ? agents.filter((agent) => agent && typeof agent === "object")
    : [];
}

/** A conversation title from its first message: its first words, trimmed. */
export function titleFrom(text: string): string {
  const line = text.trim().split(/\n/)[0].replace(/\s+/g, " ");
  if (line.length <= 48) return line || "New conversation";
  const cut = line.slice(0, 48);
  const space = cut.lastIndexOf(" ");
  return `${(space > 24 ? cut.slice(0, space) : cut).trim()}…`;
}

function kindOf(type: string): "image" | "audio" | "video" | "file" {
  return type.startsWith("image/")
    ? "image"
    : type.startsWith("audio/")
    ? "audio"
    : type.startsWith("video/")
    ? "video"
    : "file";
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** The JSON Action body limit leaves room for this much inline attachment data. */
export const INLINE_ATTACHMENT_BYTES = 512 * 1024;
/** The largest JSON tool result read on demand; larger ones say so. */
export const TOOL_RESULT_BYTES = 256 * 1024;

/**
 * Reads a tool's JSON result that the window read left as a reference, once,
 * through the host's message asset capability, and keeps it in `toolResult`.
 */
export async function loadToolResult(
  input: {
    callId: string;
    threadId: string;
    messageId: string;
    assetId: string;
    /** `text` for a text result the window read deferred; JSON otherwise. */
    kind?: "json" | "text";
  },
  ctx: BrowserActionContext,
): Promise<void> {
  const current = ctx.collections.toolResult?.get(input.callId).value;
  if (current && current.status !== "unavailable") return;
  const set = (row: Record<string, unknown>) =>
    ctx.command("toolResult", input.callId, "set", row);
  const host = feed(ctx);
  if (!host?.asset) return set({ status: "unavailable" });
  set({ status: "loading" });
  try {
    const body = await host.asset(
      input.threadId,
      input.messageId,
      input.assetId,
      ctx.signal,
    );
    if (body.size > TOOL_RESULT_BYTES) return set({ status: "too-large" });
    const text = await body.text();
    set(
      input.kind === "text"
        ? { status: "ready", text }
        : { status: "ready", value: JSON.parse(text) },
    );
  } catch {
    set({ status: "unavailable" });
  }
}

/** The largest message text body read on demand; larger ones say so. */
export const MESSAGE_BODY_BYTES = 1024 * 1024;

/**
 * Reads a message text body the window read deferred (over its budget), once,
 * through the host's message asset capability, and keeps it in `messageBody`
 * by asset id.
 */
export async function loadMessageBody(
  input: { threadId: string; messageId: string; assetId: string },
  ctx: BrowserActionContext,
): Promise<void> {
  const current = ctx.collections.messageBody?.get(input.assetId).value;
  if (current && current.status !== "unavailable") return;
  const set = (row: Record<string, unknown>) =>
    ctx.command("messageBody", input.assetId, "set", row);
  const host = feed(ctx);
  if (!host?.asset) return set({ status: "unavailable" });
  set({ status: "loading" });
  try {
    const body = await host.asset(
      input.threadId,
      input.messageId,
      input.assetId,
      ctx.signal,
    );
    if (body.size > MESSAGE_BODY_BYTES) return set({ status: "too-large" });
    set({ status: "ready", text: await body.text() });
  } catch {
    set({ status: "unavailable" });
  }
}

/** Files kept for an outbox retry, outside Collections (bodies are not state). */
const retained = new WeakMap<object, Map<string, readonly File[]>>();
function retainedFiles(
  ctx: BrowserActionContext,
): Map<string, readonly File[]> {
  let map = retained.get(ctx.collections);
  if (!map) retained.set(ctx.collections, map = new Map());
  return map;
}

function feed(ctx: BrowserActionContext): ThreadFeedAdapter | undefined {
  const adapter = ctx.adapters.core?.feed;
  return adapter && typeof adapter === "object"
    ? adapter as ThreadFeedAdapter
    : undefined;
}

async function content(
  ctx: BrowserActionContext,
  id: string,
  text: string,
  files: readonly File[],
): Promise<unknown[]> {
  const parts: unknown[] = text ? [{ type: "text", text }] : [];
  const adapter = feed(ctx);
  let inline = 0;
  for (const [index, file] of files.entries()) {
    const mediaType = file.type || "application/octet-stream";
    if (adapter?.upload) {
      parts.push(
        await adapter.upload(file, {
          name: file.name,
          mediaType,
          idempotencyKey: `${id}:${index}`,
          signal: ctx.signal,
        }),
      );
      continue;
    }
    inline += file.size;
    if (inline > INLINE_ATTACHMENT_BYTES) {
      throw new Error(
        "These attachments are too large to send here. Remove some and try again.",
      );
    }
    parts.push({
      type: kindOf(mediaType),
      mediaType,
      name: file.name,
      dataBase64: base64(new Uint8Array(await file.arrayBuffer())),
    });
  }
  return parts;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function refused(error: unknown): boolean {
  const value = error as { status?: unknown; code?: unknown } | undefined;
  return value?.status === 401 || value?.status === 403 ||
    value?.status === 404 ||
    ["revoked", "forbidden", "unauthorized", "record_not_found"].includes(
      String(value?.code),
    );
}

async function follow(
  { threadId }: ChatIntentInputs["chatFollow"],
  ctx: BrowserActionContext,
): Promise<void> {
  const adapter = feed(ctx);
  const run = (patch: Record<string, unknown>) => {
    if (!ctx.signal.aborted) ctx.command("threadRun", threadId, "set", patch);
  };
  if (!adapter) {
    run({ status: "unavailable" });
    return;
  }
  // Each mounted thread View follows its own feed; the projection is idempotent.
  const signal = ctx.signal;
  const projector = createFeedProjector();
  let checkpoint: string | undefined;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status = "connecting";
  let last = "";
  let lastOutputs = "{}";
  const flush = () => {
    timer = undefined;
    if (signal.aborted) return;
    const snapshot = projector.snapshot();
    ctx.command("threadFeed", threadId, "set", {
      attempts: snapshot.attempts,
    });
    const outputs = JSON.stringify(snapshot.outputs);
    if (outputs !== lastOutputs) {
      lastOutputs = outputs;
      ctx.command("threadOutputs", threadId, "set", {
        outputs: snapshot.outputs,
      });
    }
    const summary = JSON.stringify([status, snapshot.active]);
    if (summary !== last) {
      last = summary;
      ctx.command("threadRun", threadId, "set", {
        status,
        active: snapshot.active,
        ...(snapshot.active.length ? {} : { stopping: false }),
      });
    }
  };
  const schedule = (now = false) => {
    if (now) {
      if (timer) clearTimeout(timer);
      return flush();
    }
    timer ??= setTimeout(flush, 50);
  };
  try {
    run({ status, active: [] });
    while (!signal.aborted) {
      try {
        status = "live";
        schedule(true);
        const ended = await adapter.observe(threadId, {
          ...(checkpoint ? { checkpoint } : {}),
          signal,
          onFrame(frame) {
            if (projector.apply(frame)) schedule();
            checkpoint = frame.checkpoint;
            failures = 0;
          },
        });
        checkpoint = ended ?? checkpoint;
      } catch (error) {
        if (signal.aborted) break;
        if (refused(error)) {
          status = "unavailable";
          schedule(true);
          break;
        }
        if (error instanceof RangeError) checkpoint = undefined;
        status = "reconnecting";
        schedule(true);
        await sleep(Math.min(30_000, 1000 * 2 ** failures++), signal);
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The default intents over Core's standard composition aliases. */
export function defaultIntents(aliases: Aliases): ChatIntents {
  const updateThread = (
    ctx: BrowserActionContext,
    threadId: string,
    patch: Record<string, unknown>,
  ) => call(ctx, aliases.updateConversation, { threadId, patch });
  return {
    async chatSend(input, ctx) {
      const self = sender(ctx);
      const text = input.text.trim();
      const files = input.retry
        ? retainedFiles(ctx).get(input.retry) ?? []
        : input.files ?? [];
      if (!text && !files.length && !input.retry) return undefined;
      // A new conversation has its id before anything is sent, so the first
      // message shows at once and a retry continues the same thread.
      const threadId = input.threadId ?? monotonicUlid();
      if (input.create || !input.threadId) {
        ctx.command("pendingThread", threadId, "set", {
          name: input.create?.name ?? titleFrom(text || files[0]?.name || ""),
          ...(input.create?.spaceId ?? input.spaceId
            ? { spaceId: input.create?.spaceId ?? input.spaceId }
            : {}),
          created: false,
        });
      }
      const id = input.retry ?? monotonicUlid();
      const previous = input.retry
        ? ctx.collections.outbox.get(id).value
        : undefined;
      const body = input.retry ? String(previous?.text ?? "") : text;
      const recipientIds = input.retry
        ? (previous?.recipientIds as string[] | undefined) ?? []
        : input.recipientIds ?? [];
      const agents = input.retry
        ? (previous?.recipientAgents as
          | Record<string, unknown>[]
          | undefined) ??
          []
        : input.recipientAgents ?? [];
      const addressed = input.retry
        ? previous?.addressed === true
        : input.recipientIds !== undefined || agents.length > 0;
      retainedFiles(ctx).set(id, files);
      ctx.command("outbox", id, "set", {
        threadId,
        text: body,
        recipientIds: [...recipientIds],
        recipientAgents: agents.map((agent) => ({ ...agent })),
        addressed,
        attachments: input.retry ? previous?.attachments ?? [] : files.map((
          file,
        ) => ({
          kind: kindOf(file.type),
          mediaType: file.type || "application/octet-stream",
          name: file.name,
          size: file.size,
        })),
        status: "sending",
        error: null,
        removed: false,
        createdAt: input.retry
          ? previous?.createdAt ?? new Date().toISOString()
          : new Date().toISOString(),
      });
      try {
        const pending = ctx.collections.pendingThread?.get(threadId).value;
        if (pending && pending.created !== true) {
          // An existing thread (an earlier attempt that did create it) is done.
          await call(ctx, aliases.createThread, {
            id: threadId,
            name: String(pending.name ?? "New conversation"),
            ...(typeof pending.spaceId === "string"
              ? { spaceId: pending.spaceId }
              : {}),
            participants: [self, ...defaultAgents(ctx)],
          }).catch(alreadyDone);
          ctx.command("pendingThread", threadId, "set", { created: true });
        }
        await call(ctx, aliases.createThreadMessage, {
          id,
          threadId,
          sender: self,
          content: await content(ctx, id, body, files),
          // Explicit recipients, even none, keep Core's default (every agent
          // in the thread) for apps that choose it by sending nothing.
          ...(addressed ? { recipientIds: [...recipientIds] } : {}),
          ...(agents.length
            ? {
              membership: {
                participants: agents,
                recipients: agents.map((agent) => ({
                  externalId: String(agent.externalId),
                })),
              },
            }
            : {}),
        }).catch(alreadyDone);
        retainedFiles(ctx).delete(id);
        ctx.command("outbox", id, "set", { status: "sent" });
      } catch (error) {
        ctx.command("outbox", id, "set", {
          status: "failed",
          error: sendFailure(error),
        });
        throw error;
      }
      return { threadId, messageId: id };
    },
    chatDiscard({ messageId }, ctx) {
      retainedFiles(ctx).delete(messageId);
      ctx.command("outbox", messageId, "set", { removed: true });
    },
    chatRevise({ threadId, messageId, text }, ctx) {
      return call(ctx, aliases.reviseMessage, {
        id: monotonicUlid(),
        messageId,
        threadId,
        content: [{ type: "text", text }],
      });
    },
    async chatCreateThread({ name, spaceId }, ctx) {
      const id = monotonicUlid();
      await call(ctx, aliases.createThread, {
        id,
        name: name?.trim() || "New conversation",
        ...(spaceId ? { spaceId } : {}),
        participants: [sender(ctx), ...defaultAgents(ctx)],
      });
      return { threadId: id };
    },
    chatRenameThread: ({ threadId, name }, ctx) =>
      updateThread(ctx, threadId, { name }),
    chatArchiveThread: ({ threadId, archived }, ctx) =>
      updateThread(ctx, threadId, {
        status: archived ? "archived" : "active",
      }),
    chatDeleteThread: ({ threadId }, ctx) =>
      call(ctx, aliases.deleteConversation, { threadId }),
    chatMoveThread: ({ threadId, spaceId, fromSpaceId }, ctx) =>
      spaceId
        ? call(ctx, aliases.spaces, {
          operation: "attach",
          spaceId,
          collection: "thread",
          recordId: threadId,
        })
        : call(ctx, aliases.spaces, {
          operation: "detach",
          spaceId: fromSpaceId,
          collection: "thread",
          recordId: threadId,
        }),
    async chatCreateSpace({ name, description }, ctx) {
      const self = sender(ctx);
      const result = await call(ctx, aliases.spaces, {
        operation: "create",
        ownerId: self.participantId ?? self.id,
        name,
        ...(description ? { description } : {}),
      }) as { spaceId?: string } | undefined;
      return { spaceId: result?.spaceId };
    },
    chatUpdateSpace: ({ spaceId, name, description }, ctx) =>
      call(ctx, aliases.spaces, {
        operation: "update",
        spaceId,
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
      }),
    chatDeleteSpace: ({ spaceId }, ctx) =>
      call(ctx, aliases.spaces, { operation: "remove", spaceId }),
    chatAddMember({ spaceId, participantId }, ctx) {
      if (!participantId) {
        return Promise.reject(
          new Error("Choose a person to add to this Space."),
        );
      }
      return call(ctx, aliases.spaces, {
        operation: "addMember",
        spaceId,
        participantId,
      });
    },
    chatRemoveMember: ({ spaceId, participantId }, ctx) =>
      call(ctx, aliases.spaces, {
        operation: "removeMember",
        spaceId,
        participantId,
      }),
    chatAddAgent: ({ threadId, participant }, ctx) =>
      call(ctx, aliases.addThreadParticipant, { threadId, participant }),
    chatFollow: follow,
    async chatStop({ threadId }, ctx) {
      const adapter = feed(ctx);
      const active = ctx.collections.threadRun.get(threadId).value?.active;
      const ids = Array.isArray(active) ? active.map(String) : [];
      if (!adapter || !ids.length) return;
      ctx.command("threadRun", threadId, "set", { stopping: true });
      const results = await Promise.allSettled(
        ids.map((id) => adapter.cancel(id)),
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed) {
        ctx.command("threadRun", threadId, "set", { stopping: false });
        throw (failed as PromiseRejectedResult).reason;
      }
    },
  };
}

/** Browser Action declarations for every intent. */
export function intentActions(
  intents: ChatIntents,
): Record<ChatIntentName, BrowserActionDefinition> {
  return Object.fromEntries(
    (Object.keys(intents) as ChatIntentName[]).map((name) => [name, {
      id: `core.chat.${name.slice(4, 5).toLowerCase()}${name.slice(5)}`,
      placement: "browser" as const,
      execute: (input: unknown, ctx: BrowserActionContext) =>
        (intents[name] as ChatIntent)(input as never, ctx),
    }]),
  ) as Record<ChatIntentName, BrowserActionDefinition>;
}
