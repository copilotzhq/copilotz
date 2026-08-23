import type { CollectionRecord } from "@copilotz/copilotz/collections";
import {
  type AgentResource,
  coreCollectionsPlugin,
} from "@copilotz/copilotz/core";
import {
  assetIdFromRef,
  type ContentRef,
  formatAssetRef,
} from "@copilotz/copilotz/content";
import type { ParticipantInput } from "@copilotz/copilotz/domain";
import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import {
  type ActionContext,
  type ActionSchema,
  type AnyActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import { defineTool as defineToolResource } from "../contracts.ts";
import type { ToolResource } from "../contracts.ts";

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

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function byExternalId(
  ctx: ActionContext,
  externalId: string,
): Promise<CollectionRecord | null> {
  return (await ctx.collections.participant.queries.byExternalId({
    externalId,
  }))[0] ?? null;
}

type NativeToolDefinition = Readonly<{
  action: AnyActionDefinition;
  tool: ToolResource;
}>;

function nativeTool(
  alias: BuiltInCoreToolId,
  presentation: Readonly<{ name: string; description: string }>,
  definition: Readonly<{
    inputSchema?: ActionSchema;
    execute(input: unknown, context: ActionContext): unknown | Promise<unknown>;
  }>,
): NativeToolDefinition {
  const action = defineAction({
    id: `copilotz.tools.builtin.${alias}`,
    ...(definition.inputSchema ? { inputSchema: definition.inputSchema } : {}),
    execute: definition.execute,
  });
  return Object.freeze({
    action,
    tool: defineToolResource(alias, action, presentation),
  });
}

function metadataText(context: ActionContext, key: string): string | undefined {
  const value = context.action.metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function assetKind(
  mediaType: string,
): "image" | "audio" | "video" | "text" | "json" | "file" {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    return "json";
  }
  if (mediaType.startsWith("text/")) return "text";
  return "file";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
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
  ctx: ActionContext,
): Promise<CollectionRecord | null> {
  const participantId = metadataText(ctx, "agentParticipantId") ??
    metadataText(ctx, "participantId");
  if (participantId) {
    return await ctx.collections.participant.get({
      id: participantId,
    });
  }
  const agentId = metadataText(ctx, "agentId");
  if (agentId) {
    return await byExternalId(ctx, agentId);
  }
  return null;
}

function getCurrentTimeTool(now: () => Date): NativeToolDefinition {
  return nativeTool("get_current_time", {
    name: "Get Current Time",
    description: "Get the current date and time in a portable format.",
  }, {
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
): NativeToolDefinition {
  return nativeTool("wait", {
    name: "Wait",
    description: "Wait for up to 60 seconds, respecting cancellation.",
  }, {
    inputSchema: {
      type: "object",
      properties: {
        seconds: { type: "number", minimum: 0.1, maximum: 60, default: 1 },
      },
    },
    async execute(raw, ctx) {
      const seconds = Number(record(raw).seconds ?? 1);
      if (!Number.isFinite(seconds) || seconds < 0.1 || seconds > 60) {
        throw new TypeError("seconds must be between 0.1 and 60.");
      }
      const startedAt = Date.now();
      await sleep(seconds * 1_000, ctx.signal);
      const actual = Date.now() - startedAt;
      return { requested: seconds, actual: actual / 1_000 };
    },
  });
}

function saveAssetTool(): NativeToolDefinition {
  return nativeTool("save_asset", {
    name: "Save Asset",
    description:
      "Validate and return a canonical Copilotz ContentRef for an existing asset.",
  }, {
    inputSchema: {
      type: "object",
      properties: {
        assetId: { type: "string" },
        ref: { type: "string" },
      },
      oneOf: [
        { required: ["assetId"] },
        { required: ["ref"] },
      ],
    },
    async execute(raw, ctx) {
      const input = record(raw);
      const id = assetIdFrom(ctx.namespace, input);
      const asset = await ctx.content.get(id);
      if (!asset) throw new Error(`Asset '${id}' was not found.`);
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

function fetchAssetTool(): NativeToolDefinition {
  return nativeTool("fetch_asset", {
    name: "Fetch Asset",
    description:
      "Return a canonical ContentRef and metadata by asset ID or asset:// reference.",
  }, {
    inputSchema: {
      type: "object",
      properties: {
        assetId: { type: "string" },
        id: { type: "string" },
        ref: { type: "string" },
      },
      anyOf: [{ required: ["assetId"] }, { required: ["id"] }, {
        required: ["ref"],
      }],
    },
    async execute(raw, ctx) {
      const input = record(raw);
      const id = assetIdFrom(ctx.namespace, input);
      const asset = await ctx.content.get(id);
      if (!asset) throw new Error(`Asset '${id}' was not found.`);
      const kind = assetKind(asset.mediaType);
      const content = Object.freeze({
        assetId: id,
        kind,
        role: "attachment",
        mediaType: asset.mediaType,
      });
      return {
        assetId: id,
        assetRef: formatAssetRef(ctx.namespace, id),
        content,
        mimeType: asset.mediaType,
        size: asset.byteLength,
      };
    },
  });
}

function updateMyMemoryTool(): NativeToolDefinition {
  return nativeTool("update_my_memory", {
    name: "Update My Memory",
    description: "Update the calling agent participant's durable metadata.",
  }, {
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
    async execute(raw, ctx) {
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
      await ctx.collections.participant.update({
        id: participant.id,
        set: { metadata },
      }, { operationKey: `update_my_memory:${ctx.action.runId}:${key}` });
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

function updateUserMemoryTool(now: () => Date): NativeToolDefinition {
  return nativeTool("update_user_memory", {
    name: "Update User Memory",
    description:
      "Add or remove a durable memory item on the current human participant.",
  }, {
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
    async execute(raw, ctx) {
      const input = record(raw);
      const operation = input.operation ?? "add";
      if (operation !== "add" && operation !== "remove") {
        throw new TypeError("operation must be add or remove.");
      }
      const initiatorParticipantId = requiredText(
        metadataText(ctx, "initiatorParticipantId"),
        "Initiator participant ID",
      );
      const participant = await ctx.collections.participant.get({
        id: initiatorParticipantId,
      });
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
          id: `memory:${ctx.action.runId}`,
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
      await ctx.collections.participant.update({
        id: participant.id,
        set: { metadata },
      }, {
        operationKey: `update_user_memory:${ctx.action.runId}:${
          String(operation)
        }`,
      });
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
  ctx: ActionContext,
  reference: unknown,
): Promise<ParticipantInput> {
  const id = requiredText(reference, "participant");
  const existing = await ctx.collections.participant.get({ id }) ??
    await byExternalId(ctx, id);
  if (existing) return participantInput(existing);
  const agents = (ctx.resources.agents ?? {}) as Readonly<
    Record<string, AgentResource | undefined>
  >;
  const agent = agents[id] ??
    Object.values(agents).filter((value): value is AgentResource => !!value)
      .find((
        candidate,
      ) => candidate.name === id || candidate.id === id);
  if (!agent) {
    throw new Error(`Thread participant '${id}' was not found.`);
  }
  return Object.freeze({
    externalId: agent.id,
    participantType: "agent",
    agentId: agent.id,
    name: agent.name,
  });
}

function createThreadTool(): NativeToolDefinition {
  return nativeTool("create_thread", {
    name: "Create Thread",
    description:
      "Create an explicitly separate public conversation and start it through normal durable routing.",
  }, {
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
    async execute(raw, ctx) {
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
        : `thread:${ctx.action.runId}`;
      const externalId = optionalText(input.externalId);
      const description = optionalText(input.description);
      const summary = optionalText(input.summary);
      const parentThreadId = metadataText(ctx, "threadId");
      const initialMessageId = `message:${threadId}:initial`;
      const initialMessage = typeof input.initialMessage === "string" &&
          input.initialMessage.trim()
        ? input.initialMessage
        : `Started thread: ${name}`;
      const participantPlans = await Promise.all(
        [...participants.values()].map(async (participant) => {
          const existing = participant.id
            ? await ctx.collections.participant.get({ id: participant.id })
            : await byExternalId(ctx, participant.externalId);
          return { participant, existing };
        }),
      );
      const [existingThread, existingInitialMessage] = await Promise.all([
        ctx.collections.thread.get({ id: threadId }),
        ctx.collections.message.get({ id: initialMessageId }),
      ]);
      if (Boolean(existingThread) !== Boolean(existingInitialMessage)) {
        throw new Error(
          `Thread '${threadId}' has inconsistent initial-message state.`,
        );
      }
      if (existingThread && existingInitialMessage) {
        const expectedParticipantIds = participantPlans.map(({ existing }) => {
          if (!existing) {
            throw new Error(
              `Existing thread '${threadId}' does not match requested participants.`,
            );
          }
          return existing.id;
        }).sort();
        const actualParticipantIds =
          Array.isArray(existingThread.participantIds)
            ? existingThread.participantIds.map(String).sort()
            : [];
        const resolved = await ctx.content.resolveMany(
          Array.isArray(existingInitialMessage.content)
            ? existingInitialMessage.content as unknown as readonly ContentRef[]
            : [],
        );
        const existingText = resolved.map((part) => part.text ?? "").join("");
        const declarationMetadata = {
          ...structuredClone(record(input.metadata)),
          name,
          mode,
          ...(description ? { description } : {}),
          ...(summary ? { summary } : {}),
        };
        const existingMetadata = structuredClone(
          record(existingThread.metadata),
        );
        const createdByActionRunId = optionalText(
          existingMetadata.createdByActionRunId,
        );
        delete existingMetadata.createdByActionRunId;
        const expectedRecipientIds = expectedParticipantIds
          .filter((id) => id !== caller.id)
          .sort();
        const actualRecipientIds = Array.isArray(
            existingInitialMessage.recipientIds,
          )
          ? existingInitialMessage.recipientIds.map(String).sort()
          : [];
        const messageMetadata = record(existingInitialMessage.metadata);
        if (
          existingThread.name !== name ||
          optionalText(existingThread.externalId) !== externalId ||
          optionalText(existingThread.parentThreadId) !== parentThreadId ||
          optionalText(existingThread.description) !== description ||
          existingThread.status !== "active" ||
          stableJson(existingMetadata) !== stableJson(declarationMetadata) ||
          JSON.stringify(actualParticipantIds) !==
            JSON.stringify(expectedParticipantIds) ||
          existingInitialMessage.threadId !== threadId ||
          existingInitialMessage.senderId !== caller.id ||
          JSON.stringify(actualRecipientIds) !==
            JSON.stringify(expectedRecipientIds) ||
          messageMetadata.kind !== "thread_initial_message" ||
          messageMetadata.mode !== mode ||
          !createdByActionRunId ||
          optionalText(messageMetadata.createdByActionRunId) !==
            createdByActionRunId ||
          existingText !== initialMessage
        ) {
          throw new Error(
            `Existing thread '${threadId}' does not match the requested declaration.`,
          );
        }
        return {
          threadId,
          name,
          participantIds: expectedParticipantIds,
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
        ...(description ? { description } : {}),
        ...(summary ? { summary } : {}),
        createdByActionRunId: ctx.action.runId,
      };
      const preparedContent = await ctx.content.prepare(initialMessage, {
        operationKey: `create_thread:${ctx.action.runId}:initial-content`,
      });
      const created = await ctx.transaction(async (transaction) => {
        const ensuredIds: string[] = [];
        for (const { participant, existing } of participantPlans) {
          if (existing) {
            ensuredIds.push(existing.id);
            continue;
          }
          const participantId = participant.id?.trim() ||
            `participant:${encodeURIComponent(participant.externalId)}`;
          const ref = await transaction.collections.participant.create({
            id: participantId,
            externalId: participant.externalId,
            participantType: participant.participantType,
            ...(participant.name ? { name: participant.name } : {}),
            ...(participant.email ? { email: participant.email } : {}),
            ...(participant.agentId ? { agentId: participant.agentId } : {}),
            metadata: structuredClone(participant.metadata ?? {}),
          }, { threadId });
          ensuredIds.push(ref.id);
        }
        const thread = await transaction.collections.thread.create({
          id: threadId,
          ...(externalId ? { externalId } : {}),
          ...(parentThreadId ? { parentThreadId } : {}),
          name,
          ...(description ? { description } : {}),
          participantIds: ensuredIds,
          metadata,
        }, { threadId });
        const recipientIds = ensuredIds.filter((id) => id !== caller.id);
        const messageMetadata = {
          kind: "thread_initial_message",
          mode,
          createdByActionRunId: ctx.action.runId,
        };
        const message = await transaction.collections.message.create({
          id: initialMessageId,
          threadId,
          senderId: caller.id,
          recipientIds,
          content: preparedContent,
          metadata: messageMetadata,
        }, {
          threadId,
          routing: { senderId: caller.id, recipientIds },
          visibility: { kind: "public" },
          identity: { metadata: messageMetadata },
        });
        return { thread, message, participantIds: ensuredIds };
      }, {
        operationKey: `create_thread:${ctx.action.runId}`,
      });
      return {
        threadId,
        name,
        participantIds: created.participantIds,
        mode,
        status: "started",
        eventId: created.thread.id,
        messageEventId: created.message.id,
      };
    },
  });
}

function endThreadTool(): NativeToolDefinition {
  return nativeTool("end_thread", {
    name: "End Thread",
    description: "Archive the active thread with a public durable summary.",
  }, {
    inputSchema: {
      type: "object",
      properties: { summary: { type: "string", minLength: 1 } },
      required: ["summary"],
    },
    async execute(raw, ctx) {
      const summary = requiredText(record(raw).summary, "summary");
      const threadId = requiredText(
        metadataText(ctx, "threadId"),
        "Thread ID",
      );
      const thread = await ctx.collections.thread.get({
        id: threadId,
      });
      if (!thread) throw new Error("The active thread was not found.");
      await ctx.collections.thread.update({
        id: thread.id,
        set: {
          status: "archived",
          metadata: { ...record(thread.metadata), summary },
        },
      }, {
        operationKey: `end_thread:${ctx.action.runId}`,
        threadId: thread.id,
      });
      return { threadId: thread.id, summary, status: "archived" };
    },
  });
}

function toolFactories(options: CreateBuiltInToolsPluginOptions): Readonly<
  Record<BuiltInCoreToolId, (() => NativeToolDefinition) | undefined>
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
  const ids = options.include ?? BUILT_IN_CORE_TOOL_IDS;
  if (new Set(ids).size !== ids.length) {
    throw new TypeError("Built-in tool selection contains duplicate IDs.");
  }
  const factories = toolFactories(options);
  const definitions = Object.freeze(ids.map((id) => {
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
    plugins: [coreCollectionsPlugin],
    actions: Object.fromEntries(
      definitions.map((
        definition,
      ) => [definition.tool.action, definition.action]),
    ),
    resources: {
      tools: Object.fromEntries(
        definitions.map((
          definition,
        ) => [definition.tool.action, definition.tool]),
      ),
    },
  });
}
