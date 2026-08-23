import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type { Agent } from "@copilotz/copilotz/resources";
import { assetIdFromRef, formatAssetRef } from "@copilotz/copilotz/content";
import type { ParticipantInput } from "@copilotz/copilotz/domain";
import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import type { ActionCallOptions } from "@copilotz/copilotz/actions";
import type {
  WorkflowTool,
  WorkflowToolExecutionContext,
} from "@copilotz/copilotz/tools";

export const BUILT_IN_CORE_TOOL_IDS = [
  "get_current_time",
  "wait",
  "save_asset",
  "fetch_asset",
  "update_my_memory",
  "update_user_memory",
  "create_thread",
  "end_thread",
] as const;

export type BuiltInCoreToolId = typeof BUILT_IN_CORE_TOOL_IDS[number];

export type CreateBuiltInToolsPluginOptions = Readonly<{
  id?: string;
  version?: string;
  include?: readonly BuiltInCoreToolId[];
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}>;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function context(
  value: WorkflowToolExecutionContext | undefined,
): WorkflowToolExecutionContext {
  if (!value?.processor) {
    throw new Error("This tool requires an event-native Copilotz context.");
  }
  return value;
}

async function byExternalId(
  ctx: WorkflowToolExecutionContext,
  externalId: string,
): Promise<CollectionRecord | null> {
  return (await ctx.processor.collections.participant.queries.byExternalId({
    externalId,
  }))[0] ?? null;
}

async function ensureParticipant(
  ctx: WorkflowToolExecutionContext,
  input: ParticipantInput,
  operationKey: string,
  threadId?: string,
): Promise<CollectionRecord> {
  const existing = input.id
    ? await ctx.processor.collections.participant.get({ id: input.id })
    : await byExternalId(ctx, input.externalId);
  if (existing) return existing;
  return await ctx.processor.collections.participant.create({
    ...input,
    metadata: structuredClone(input.metadata ?? {}),
  }, { operationKey, ...(threadId ? { threadId } : {}) });
}

function defineTool(
  input: Omit<WorkflowTool, "id"> & { id?: string },
): WorkflowTool {
  return Object.freeze({ ...input, id: input.id ?? input.key }) as WorkflowTool;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa !== "function") {
    throw new Error("This runtime does not provide the Web btoa API.");
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof atob !== "function") {
    throw new Error("This runtime does not provide the Web atob API.");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch (cause) {
    throw new TypeError("dataBase64 must contain valid base64 data.", {
      cause,
    });
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function assetKind(mediaType: string): "image" | "audio" | "video" | "file" {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  return "file";
}

function assetIdFrom(
  namespace: string,
  value: Readonly<{ id?: unknown; assetId?: unknown; ref?: unknown }>,
): string {
  const direct = typeof value.assetId === "string"
    ? value.assetId
    : typeof value.id === "string"
    ? value.id
    : undefined;
  return assetIdFromRef(
    namespace,
    direct ?? requiredText(value.ref, "Asset ref"),
  );
}

function defaultSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Wait cancelled."));
      return;
    }
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Wait cancelled."));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function participantInputFromRecord(
  record: CollectionRecord,
): ParticipantInput {
  const metadata = record.metadata && typeof record.metadata === "object" &&
      !Array.isArray(record.metadata)
    ? record.metadata as Record<string, unknown>
    : {};
  return Object.freeze({
    id: record.id,
    externalId: String(record.externalId ?? record.id),
    participantType: record
      .participantType as ParticipantInput["participantType"],
    ...(typeof record.name === "string" && record.name
      ? { name: record.name }
      : {}),
    ...(typeof record.email === "string" && record.email
      ? { email: record.email }
      : {}),
    ...(typeof record.agentId === "string" && record.agentId
      ? { agentId: record.agentId }
      : {}),
    metadata: structuredClone(metadata),
  });
}

async function loadCallerParticipant(
  ctx: WorkflowToolExecutionContext,
): Promise<CollectionRecord | null> {
  if (ctx.execution.participantId) {
    return await ctx.processor.collections.participant.get({
      id: ctx.execution.participantId,
    });
  }
  if (ctx.execution.agentId) {
    return await byExternalId(ctx, ctx.execution.agentId);
  }
  return null;
}

function getCurrentTimeTool(now: () => Date): WorkflowTool {
  return defineTool({
    key: "get_current_time",
    name: "Get Current Time",
    description: "Get the current date and time in a portable format.",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["iso", "readable", "timestamp", "date-only", "time-only"],
          default: "iso",
        },
        timezone: { type: "string", default: "local" },
      },
    },
    execute: (raw) => {
      const input = record(raw);
      const format = typeof input.format === "string" ? input.format : "iso";
      const timezone = typeof input.timezone === "string"
        ? input.timezone
        : "local";
      const value = now();
      const timeZone = timezone === "local" ? undefined : timezone;
      let currentTime: string | number;
      if (format === "timestamp") currentTime = value.getTime();
      else if (format === "date-only") {
        currentTime = value.toISOString().slice(0, 10);
      } else if (format === "time-only") {
        currentTime = new Intl.DateTimeFormat("en-GB", {
          timeZone,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23",
        }).format(value);
      } else if (format === "readable") {
        currentTime = new Intl.DateTimeFormat(undefined, {
          timeZone,
          dateStyle: "medium",
          timeStyle: "long",
        }).format(value);
      } else currentTime = value.toISOString();
      return {
        current_time: currentTime,
        format,
        timezone: timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        timestamp: value.getTime(),
        iso: value.toISOString(),
      };
    },
  });
}

function waitTool(
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>,
): WorkflowTool {
  return defineTool({
    key: "wait",
    name: "Wait",
    description: "Wait for up to 60 seconds, respecting cancellation.",
    inputSchema: {
      type: "object",
      properties: {
        seconds: { type: "number", minimum: 0.1, maximum: 60, default: 1 },
      },
    },
    async execute(raw, value) {
      const ctx = context(value);
      const seconds = Number(record(raw).seconds ?? 1);
      if (!Number.isFinite(seconds) || seconds < 0.1 || seconds > 60) {
        throw new TypeError("seconds must be between 0.1 and 60.");
      }
      const startedAt = Date.now();
      await sleep(seconds * 1_000, ctx.processor.signal);
      const actual = Date.now() - startedAt;
      return { requested: seconds, actual: actual / 1_000 };
    },
  });
}

function saveAssetTool(): WorkflowTool {
  return defineTool({
    key: "save_asset",
    name: "Save Asset",
    description:
      "Publish base64 media as canonical Copilotz content, or inspect an existing asset.",
    inputSchema: {
      type: "object",
      properties: {
        mimeType: { type: "string" },
        dataBase64: { type: "string" },
        assetId: { type: "string" },
        ref: { type: "string" },
      },
      oneOf: [
        { required: ["mimeType", "dataBase64"] },
        { required: ["assetId"] },
        { required: ["ref"] },
      ],
    },
    async execute(raw, value) {
      const ctx = context(value);
      const input = record(raw);
      let asset;
      if (input.assetId !== undefined || input.ref !== undefined) {
        const id = assetIdFrom(ctx.namespace, input);
        asset = await ctx.processor.content.get(id);
        if (!asset) throw new Error(`Asset '${id}' was not found.`);
      } else {
        const mediaType = requiredText(input.mimeType, "mimeType");
        const bytes = base64ToBytes(
          requiredText(input.dataBase64, "dataBase64"),
        );
        asset = await ctx.processor.content.publish(
          { mediaType, body: bytes },
          {
            operationKey: "save_asset",
          },
        );
      }
      const kind = assetKind(asset.mediaType);
      return {
        assetId: asset.id,
        assetRef: formatAssetRef(ctx.namespace, asset.id),
        content: {
          assetId: asset.id,
          kind,
          role: "attachment",
          mediaType: asset.mediaType,
        },
        mimeType: asset.mediaType,
        size: asset.byteLength,
        kind,
      };
    },
  });
}

function fetchAssetTool(): WorkflowTool {
  return defineTool({
    key: "fetch_asset",
    name: "Fetch Asset",
    description: "Read canonical asset content by ID or asset:// reference.",
    inputSchema: {
      type: "object",
      properties: {
        assetId: { type: "string" },
        id: { type: "string" },
        ref: { type: "string" },
        format: {
          type: "string",
          enum: ["dataUrl", "base64"],
          default: "dataUrl",
        },
      },
      anyOf: [{ required: ["assetId"] }, { required: ["id"] }, {
        required: ["ref"],
      }],
    },
    async execute(raw, value) {
      const ctx = context(value);
      const input = record(raw);
      const id = assetIdFrom(ctx.namespace, input);
      const asset = await ctx.processor.content.get(id);
      if (!asset) throw new Error(`Asset '${id}' was not found.`);
      const kind = assetKind(asset.mediaType);
      const resolved = await ctx.processor.content.resolve({
        assetId: id,
        kind,
        role: "attachment",
        mediaType: asset.mediaType,
      });
      const base64 = bytesToBase64(resolved.bytes);
      const common = {
        assetId: id,
        assetRef: formatAssetRef(ctx.namespace, id),
        mimeType: asset.mediaType,
        size: asset.byteLength,
      };
      return input.format === "base64"
        ? { ...common, base64 }
        : { ...common, dataUrl: `data:${asset.mediaType};base64,${base64}` };
    },
  });
}

function updateMyMemoryTool(): WorkflowTool {
  return defineTool({
    key: "update_my_memory",
    name: "Update My Memory",
    description: "Update the calling agent participant's durable metadata.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", minLength: 1 },
        value: { type: "string" },
        operation: {
          type: "string",
          enum: ["set", "append", "remove"],
          default: "set",
        },
      },
      required: ["key"],
    },
    async execute(raw, value) {
      const ctx = context(value);
      const input = record(raw);
      const key = requiredText(input.key, "key");
      const operation = input.operation ?? "set";
      if (
        operation !== "set" && operation !== "append" && operation !== "remove"
      ) {
        throw new TypeError("operation must be set, append, or remove.");
      }
      const participant = await loadCallerParticipant(ctx);
      if (!participant || participant.participantType !== "agent") {
        throw new Error("The calling agent participant was not found.");
      }
      const metadata: JsonRecord = structuredClone(
        record(participant.metadata),
      );
      if (operation === "remove") delete metadata[key];
      else {
        const item = requiredText(input.value, "value");
        if (operation === "append") {
          const previous = metadata[key];
          metadata[key] = Array.isArray(previous)
            ? [...previous, item]
            : previous === undefined
            ? [item]
            : [previous, item];
        } else metadata[key] = item;
      }
      await ctx.processor.collections.participant.update({
        id: participant.id,
        set: { metadata },
      }, { operationKey: `update_my_memory:${key}` });
      return {
        success: true,
        key,
        operation,
        ...(operation === "remove" ? {} : { stored: metadata[key] }),
      };
    },
  });
}

type UserMemoryItem = Readonly<{
  id: string;
  content: string;
  category: string;
  source: "agent";
  createdAt: string;
}>;

function userMemoryItems(metadata: JsonRecord): UserMemoryItem[] {
  const items = record(metadata.memories).items;
  return Array.isArray(items)
    ? items.filter((item): item is UserMemoryItem =>
      Boolean(
        item && typeof item === "object" &&
          typeof (item as UserMemoryItem).id === "string" &&
          typeof (item as UserMemoryItem).content === "string",
      )
    )
    : [];
}

function updateUserMemoryTool(now: () => Date): WorkflowTool {
  return defineTool({
    key: "update_user_memory",
    name: "Update User Memory",
    description:
      "Add or remove a durable memory item on the current human participant.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        category: {
          type: "string",
          enum: ["preference", "fact", "goal", "context", "other"],
          default: "other",
        },
        operation: { type: "string", enum: ["add", "remove"], default: "add" },
        memoryId: { type: "string" },
      },
    },
    async execute(raw, value) {
      const ctx = context(value);
      const input = record(raw);
      const operation = input.operation ?? "add";
      if (operation !== "add" && operation !== "remove") {
        throw new TypeError("operation must be add or remove.");
      }
      const externalId = requiredText(
        ctx.userExternalId,
        "Current user external ID",
      );
      const participant = await byExternalId(ctx, externalId);
      if (!participant || participant.participantType !== "human") {
        throw new Error("The current human participant was not found.");
      }
      const metadata: JsonRecord = structuredClone(
        record(participant.metadata),
      );
      const previous = userMemoryItems(metadata);
      let item: UserMemoryItem | undefined;
      let items: UserMemoryItem[];
      if (operation === "add") {
        const content = requiredText(input.content, "content");
        const category = typeof input.category === "string"
          ? input.category
          : "other";
        item = Object.freeze({
          id: `memory:${ctx.execution.id}`,
          content,
          category,
          source: "agent",
          createdAt: now().toISOString(),
        });
        items = previous.some((candidate) => candidate.id === item!.id)
          ? previous
          : [...previous, item];
      } else {
        const memoryId = requiredText(input.memoryId, "memoryId");
        items = previous.filter((candidate) => candidate.id !== memoryId);
        if (items.length === previous.length) {
          throw new Error(`Memory item '${memoryId}' was not found.`);
        }
      }
      metadata.memories = { ...record(metadata.memories), items };
      metadata.updatedAt = now().toISOString();
      await ctx.processor.collections.participant.update({
        id: participant.id,
        set: { metadata },
      }, { operationKey: `update_user_memory:${String(operation)}` });
      return {
        success: true,
        operation,
        ...(item ? { memory: item } : {}),
        memoryCount: items.length,
      };
    },
  });
}

function participantInput(participant: CollectionRecord): ParticipantInput {
  return participantInputFromRecord(participant);
}

async function resolveThreadParticipant(
  ctx: WorkflowToolExecutionContext,
  reference: unknown,
): Promise<ParticipantInput> {
  const id = requiredText(reference, "participant");
  const existing = await ctx.processor.collections.participant.get({ id }) ??
    await byExternalId(ctx, id);
  if (existing) return participantInput(existing);
  const agents = (ctx.processor.resources.agents ?? {}) as Readonly<
    Record<string, Agent | undefined>
  >;
  const agent = agents[id] ??
    Object.values(agents).filter((value): value is Agent => !!value).find((
      candidate,
    ) => candidate.name === id || candidate.externalId === id);
  if (!agent) {
    throw new Error(`Thread participant '${id}' was not found.`);
  }
  return Object.freeze({
    externalId: agent.externalId?.trim() || agent.id,
    participantType: "agent",
    agentId: agent.id,
    name: agent.name,
  });
}

function createThreadTool(): WorkflowTool {
  return defineTool({
    key: "create_thread",
    name: "Create Thread",
    description:
      "Create an explicitly separate public conversation and start it through normal durable routing.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
        externalId: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1 },
        participants: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        initialMessage: { type: "string" },
        mode: {
          type: "string",
          enum: ["background", "immediate"],
          default: "immediate",
        },
        description: { type: "string" },
        summary: { type: "string" },
        metadata: { type: "object", additionalProperties: true },
      },
      required: ["name", "participants"],
    },
    async execute(raw, value) {
      const ctx = context(value);
      const input = record(raw);
      const name = requiredText(input.name, "name");
      if (!Array.isArray(input.participants)) {
        throw new TypeError("participants must be an array.");
      }
      const mode = input.mode ?? "immediate";
      if (mode !== "background" && mode !== "immediate") {
        throw new TypeError("mode must be background or immediate.");
      }
      const caller = await loadCallerParticipant(ctx);
      if (!caller || caller.participantType !== "agent") {
        throw new Error("The calling agent participant was not found.");
      }
      const requested = await Promise.all(
        input.participants.map((participant) =>
          resolveThreadParticipant(ctx, participant)
        ),
      );
      const participants = new Map<string, ParticipantInput>();
      for (const participant of [participantInput(caller), ...requested]) {
        participants.set(participant.externalId, participant);
      }
      const threadId = typeof input.id === "string" && input.id.trim()
        ? input.id.trim()
        : `thread:${ctx.execution.id}`;
      const initialMessageId = `message:${threadId}:initial`;
      const existingThread = await ctx.processor.collections.thread.get({
        id: threadId,
      });
      const existingInitialMessage = await ctx.processor.collections.message
        ?.get({ id: initialMessageId });
      if (existingThread && existingInitialMessage) {
        return {
          threadId,
          name,
          participantIds: Array.isArray(existingThread.participantIds)
            ? [...existingThread.participantIds]
            : [],
          mode,
          status: "started",
          eventId: existingThread.id,
          messageEventId: existingInitialMessage.id,
        };
      }
      const metadata = {
        ...structuredClone(record(input.metadata)),
        name,
        mode,
        ...(typeof input.description === "string" && input.description.trim()
          ? { description: input.description.trim() }
          : {}),
        ...(typeof input.summary === "string" && input.summary.trim()
          ? { summary: input.summary.trim() }
          : {}),
        createdByToolExecutionId: ctx.execution.id,
      };
      const ensured: CollectionRecord[] = [];
      for (const participant of participants.values()) {
        ensured.push(
          await ensureParticipant(
            ctx,
            {
              ...(participant.id ? { id: participant.id } : {}),
              externalId: participant.externalId,
              participantType: participant.participantType,
              ...(participant.name ? { name: participant.name } : {}),
              ...(participant.email ? { email: participant.email } : {}),
              ...(participant.agentId ? { agentId: participant.agentId } : {}),
              metadata: structuredClone(participant.metadata ?? {}),
            },
            `create_thread:${threadId}:participant:${participant.externalId}`,
            threadId,
          ),
        );
      }
      const created = existingThread ??
        await ctx.processor.collections.thread.create({
          id: threadId,
          ...(typeof input.externalId === "string" && input.externalId.trim()
            ? { externalId: input.externalId.trim() }
            : {}),
          parentThreadId: ctx.execution.threadId,
          name,
          participantIds: ensured.map((item) => item.id),
          metadata,
        }, { operationKey: `create_thread:${threadId}` });

      const initialMessage = typeof input.initialMessage === "string" &&
          input.initialMessage.trim()
        ? input.initialMessage
        : `Started thread: ${name}`;
      const recipientIds = ensured
        .filter((participant) => participant.id !== caller.id)
        .map((participant) => participant.id);
      const createThreadMessage = ctx.processor.actions
        .createThreadMessage as unknown as (
          input: Record<string, unknown>,
          options?: ActionCallOptions,
        ) => Promise<CollectionRecord>;
      const message = await createThreadMessage({
        id: initialMessageId,
        threadId,
        sender: caller,
        recipientIds,
        content: initialMessage,
        visibility: { kind: "public" },
        metadata: {
          kind: "thread_initial_message",
          mode,
          createdByToolExecutionId: ctx.execution.id,
        },
      }, {
        operationKey: `create_thread:${threadId}:initial-message`,
      });
      return {
        threadId,
        name,
        participantIds: ensured.map((item) => item.id),
        mode,
        status: "started",
        eventId: created.id,
        messageEventId: message.id,
      };
    },
  });
}

function endThreadTool(): WorkflowTool {
  return defineTool({
    key: "end_thread",
    name: "End Thread",
    description: "Archive the active thread with a public durable summary.",
    inputSchema: {
      type: "object",
      properties: { summary: { type: "string", minLength: 1 } },
      required: ["summary"],
    },
    async execute(raw, value) {
      const ctx = context(value);
      const summary = requiredText(record(raw).summary, "summary");
      const thread = await ctx.processor.collections.thread.get({
        id: ctx.execution.threadId,
      });
      if (!thread) throw new Error("The active thread was not found.");
      await ctx.processor.collections.thread.update({
        id: thread.id,
        set: {
          status: "archived",
          metadata: { ...record(thread.metadata), summary },
        },
      }, { operationKey: "end_thread", threadId: thread.id });
      return { threadId: thread.id, summary, status: "archived" };
    },
  });
}

function toolFactories(options: CreateBuiltInToolsPluginOptions): Readonly<
  Record<BuiltInCoreToolId, (() => WorkflowTool) | undefined>
> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  return Object.freeze({
    get_current_time: () => getCurrentTimeTool(now),
    wait: () => waitTool(sleep),
    save_asset: saveAssetTool,
    fetch_asset: fetchAssetTool,
    update_my_memory: updateMyMemoryTool,
    update_user_memory: () => updateUserMemoryTool(now),
    create_thread: createThreadTool,
    end_thread: endThreadTool,
  });
}

/** Packages runtime-neutral built-ins; host-specific tools require adapters. */
export function createBuiltInToolsPlugin(
  options: CreateBuiltInToolsPluginOptions = {},
): CopilotzPlugin {
  const ids = [...new Set(options.include ?? BUILT_IN_CORE_TOOL_IDS)];
  const factories = toolFactories(options);
  const tools = Object.freeze(ids.map((id) => {
    const factory = factories[id];
    if (!factory) {
      throw new TypeError(
        `Built-in tool '${id}' requires a host capability adapter.`,
      );
    }
    return factory();
  }));
  return definePlugin({
    id: options.id ?? "@copilotz/built-in-tools",
    version: options.version ?? "3.0.0",
    resources: {
      tools: Object.fromEntries(tools.map((tool) => [tool.key, tool])),
    },
  });
}
