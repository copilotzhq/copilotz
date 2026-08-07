import type { Agent, Skill } from "../resources/index.ts";
import {
  type Participant,
  type ParticipantInput,
  toolExecutionContent,
} from "../domain/index.ts";
import { type CopilotzPlugin, definePlugin } from "../plugins/index.ts";
import type {
  WorkflowTool,
  WorkflowToolExecutionContext,
} from "../workflows/index.ts";

export const BUILT_IN_CORE_TOOL_IDS = [
  "get_current_time",
  "wait",
  "save_asset",
  "fetch_asset",
  "read_tool_result",
  "update_my_memory",
  "update_user_memory",
  "list_skills",
  "load_skill",
  "create_thread",
  "end_thread",
] as const;

export const ADAPTER_CORE_TOOL_IDS = ["read_skill_resource"] as const;

export type BuiltInCoreToolId =
  | typeof BUILT_IN_CORE_TOOL_IDS[number]
  | typeof ADAPTER_CORE_TOOL_IDS[number];

export type SkillResourceReader = (
  input: Readonly<{
    skill: Skill;
    path: string;
    signal: AbortSignal;
  }>,
) => Promise<string | Uint8Array>;

export type CreateBuiltInToolsPluginOptions = Readonly<{
  id?: string;
  version?: string;
  include?: readonly BuiltInCoreToolId[];
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readSkillResource?: SkillResourceReader;
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

function assetRef(namespace: string, assetId: string): string {
  return `asset://${encodeURIComponent(namespace)}/${
    encodeURIComponent(assetId)
  }`;
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
  if (direct?.trim()) return direct.trim();
  const ref = requiredText(value.ref, "Asset ref");
  if (!ref.startsWith("asset://")) {
    throw new TypeError("Asset ref must use the asset:// scheme.");
  }
  const segments = ref.slice("asset://".length).split("/").filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  if (segments.length === 1) return requiredText(segments[0], "Asset ID");
  if (segments.length !== 2 || segments[0] !== namespace) {
    throw new Error("Asset ref does not belong to the active namespace.");
  }
  return requiredText(segments[1], "Asset ID");
}

function availableSkills(ctx: WorkflowToolExecutionContext): readonly Skill[] {
  const values = ctx.processor.resources.list<Skill>("skills");
  const agent = ctx.agent ??
    (ctx.execution.agentId
      ? ctx.processor.resources.get<Agent>("agents", ctx.execution.agentId)
      : undefined);
  if (!agent) return values;
  if (agent.allowedSkills === null) return Object.freeze([]);
  if (!Array.isArray(agent.allowedSkills)) return values;
  const selected = new Set(agent.allowedSkills);
  return Object.freeze(values.filter((skill) => selected.has(skill.name)));
}

function skillByName(
  ctx: WorkflowToolExecutionContext,
  name: unknown,
): Skill {
  const id = requiredText(name, "Skill name");
  const skill = availableSkills(ctx).find((candidate) => candidate.name === id);
  if (!skill) {
    throw new Error(`Skill '${id}' is not available to this agent.`);
  }
  return skill;
}

function safeSkillPath(value: unknown): string {
  const input = requiredText(value, "Skill resource path").replaceAll(
    "\\",
    "/",
  );
  if (input.startsWith("/") || input.split("/").some((part) => part === "..")) {
    throw new TypeError("Skill resource path must remain inside references/.");
  }
  return input.split("/").filter((part) => part && part !== ".").join("/");
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

function serialize(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function slicedResult(
  serialized: string,
  input: Readonly<{ offset?: unknown; limit?: unknown; regex?: unknown }>,
): JsonRecord {
  const offset = input.offset === undefined ? 0 : Number(input.offset);
  const limit = input.limit === undefined ? 4_000 : Number(input.limit);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError("offset must be a non-negative integer.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new TypeError("limit must be an integer between 1 and 10000.");
  }
  if (input.regex !== undefined) {
    const pattern = requiredText(input.regex, "regex");
    if (pattern.length > 256) throw new TypeError("regex is too long.");
    let expression: RegExp;
    try {
      expression = new RegExp(pattern);
    } catch (cause) {
      throw new TypeError("regex is invalid.", { cause });
    }
    const match = expression.exec(serialized);
    if (!match) return { matchFound: false, totalLength: serialized.length };
    const excerptOffset = Math.max(0, match.index - Math.floor(limit / 2));
    const excerpt = serialized.slice(excerptOffset, excerptOffset + limit);
    return {
      matchFound: true,
      matchIndex: match.index,
      matchLength: match[0].length,
      excerptOffset,
      excerpt,
      excerptLength: excerpt.length,
      totalLength: serialized.length,
    };
  }
  const content = serialized.slice(offset, offset + limit);
  return {
    offset,
    content,
    length: content.length,
    totalLength: serialized.length,
    hasMore: offset + content.length < serialized.length,
    nextOffset: offset + content.length < serialized.length
      ? offset + content.length
      : null,
  };
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
        assetRef: assetRef(ctx.namespace, asset.id),
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
        assetRef: assetRef(ctx.namespace, id),
        mimeType: asset.mediaType,
        size: asset.byteLength,
      };
      return input.format === "base64"
        ? { ...common, base64 }
        : { ...common, dataUrl: `data:${asset.mediaType};base64,${base64}` };
    },
  });
}

function readToolResultTool(): WorkflowTool {
  return defineTool({
    key: "read_tool_result",
    name: "Read Tool Result",
    description:
      "Read a bounded slice of a canonical tool execution result in the active thread.",
    inputSchema: {
      type: "object",
      properties: {
        toolExecutionId: { type: "string" },
        offset: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 10_000, default: 4_000 },
        regex: { type: "string", maxLength: 256 },
      },
      required: ["toolExecutionId"],
    },
    async execute(raw, value) {
      const ctx = context(value);
      const input = record(raw);
      const executionId = requiredText(
        input.toolExecutionId,
        "toolExecutionId",
      );
      const execution = await ctx.processor.toolExecutions.get(executionId);
      if (!execution || execution.threadId !== ctx.execution.threadId) {
        throw new Error(
          `Tool execution '${executionId}' was not found in this thread.`,
        );
      }
      const content = toolExecutionContent(execution);
      const selected = content.projectedOutput ?? content.output ??
        content.errorDetail;
      let serialized = "";
      if (selected) {
        const resolved = await ctx.processor.content.resolve(selected);
        serialized = serialize(
          resolved.value !== undefined
            ? resolved.value
            : resolved.text ?? (selected.kind === "text"
              ? new TextDecoder().decode(resolved.bytes)
              : `data:${selected.mediaType};base64,${
                bytesToBase64(resolved.bytes)
              }`),
        );
      }
      return {
        toolExecutionId: execution.id,
        toolCallId: execution.toolCallId,
        tool: execution.tool,
        status: execution.status,
        ...slicedResult(serialized, input),
      };
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
      const participant = ctx.execution.participantId
        ? await ctx.processor.conversation.getParticipant(
          ctx.execution.participantId,
        )
        : ctx.execution.agentId
        ? await ctx.processor.conversation.getParticipantByExternalId(
          ctx.execution.agentId,
        )
        : null;
      if (!participant || participant.participantType !== "agent") {
        throw new Error("The calling agent participant was not found.");
      }
      const metadata: JsonRecord = structuredClone(participant.metadata);
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
      await ctx.processor.conversation.updateParticipant(
        participant.id,
        { metadata },
        { operationKey: `update_my_memory:${key}` },
      );
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
      const participant = await ctx.processor.conversation
        .getParticipantByExternalId(externalId);
      if (!participant || participant.participantType !== "human") {
        throw new Error("The current human participant was not found.");
      }
      const metadata: JsonRecord = structuredClone(participant.metadata);
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
      await ctx.processor.conversation.updateParticipant(
        participant.id,
        { metadata },
        { operationKey: `update_user_memory:${String(operation)}` },
      );
      return {
        success: true,
        operation,
        ...(item ? { memory: item } : {}),
        memoryCount: items.length,
      };
    },
  });
}

function listSkillsTool(): WorkflowTool {
  return defineTool({
    key: "list_skills",
    name: "List Skills",
    description: "List skills available to the calling agent.",
    inputSchema: { type: "object", properties: {} },
    execute: (_raw, value) => {
      const skills = availableSkills(context(value));
      return {
        skills: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          tags: skill.tags,
          hasReferences: skill.hasReferences,
        })),
        count: skills.length,
      };
    },
  });
}

function loadSkillTool(): WorkflowTool {
  return defineTool({
    key: "load_skill",
    name: "Load Skill",
    description: "Load the complete instructions for an available skill.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", minLength: 1 } },
      required: ["name"],
    },
    execute: (raw, value) => {
      const skill = skillByName(context(value), record(raw).name);
      return {
        name: skill.name,
        description: skill.description,
        content: skill.content,
        allowedTools: skill.allowedTools,
        hasReferences: skill.hasReferences,
      };
    },
  });
}

function readSkillResourceTool(read: SkillResourceReader): WorkflowTool {
  return defineTool({
    key: "read_skill_resource",
    name: "Read Skill Resource",
    description:
      "Read one supporting file through the host's skill capability adapter.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", minLength: 1 },
        path: { type: "string", minLength: 1 },
      },
      required: ["skill", "path"],
    },
    async execute(raw, value) {
      const ctx = context(value);
      const input = record(raw);
      const skill = skillByName(ctx, input.skill);
      const path = safeSkillPath(input.path);
      const content = await read({ skill, path, signal: ctx.processor.signal });
      return {
        skill: skill.name,
        path,
        content: typeof content === "string"
          ? content
          : new TextDecoder().decode(content),
      };
    },
  });
}

function participantInput(participant: Participant): ParticipantInput {
  return Object.freeze({
    id: participant.id,
    externalId: participant.externalId,
    participantType: participant.participantType,
    ...(participant.name ? { name: participant.name } : {}),
    ...(participant.email ? { email: participant.email } : {}),
    ...(participant.agentId ? { agentId: participant.agentId } : {}),
    metadata: structuredClone(participant.metadata),
  });
}

async function resolveThreadParticipant(
  ctx: WorkflowToolExecutionContext,
  reference: unknown,
): Promise<ParticipantInput> {
  const id = requiredText(reference, "participant");
  const existing = await ctx.processor.conversation.getParticipant(id) ??
    await ctx.processor.conversation.getParticipantByExternalId(id);
  if (existing) return participantInput(existing);
  const agent = ctx.processor.resources.get<Agent>("agents", id) ??
    ctx.processor.resources.list<Agent>("agents").find((candidate) =>
      candidate.name === id || candidate.externalId === id
    );
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
      const caller = ctx.execution.participantId
        ? await ctx.processor.conversation.getParticipant(
          ctx.execution.participantId,
        )
        : ctx.execution.agentId
        ? await ctx.processor.conversation.getParticipantByExternalId(
          ctx.execution.agentId,
        )
        : null;
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
      const created = await ctx.processor.conversation.createThread({
        id: threadId,
        ...(typeof input.externalId === "string" && input.externalId.trim()
          ? { externalId: input.externalId.trim() }
          : {}),
        parentThreadId: ctx.execution.threadId,
        participants: [...participants.values()],
        metadata,
      }, { operationKey: `create_thread:${threadId}` });
      if (!created.value) throw new Error("Separate thread was not created.");

      const initialMessage = typeof input.initialMessage === "string" &&
          input.initialMessage.trim()
        ? input.initialMessage
        : `Started thread: ${name}`;
      const content = await ctx.processor.content.prepare(initialMessage, {
        operationKey: `create_thread:${threadId}:initial-content`,
      });
      const message = await ctx.processor.conversation.createMessage({
        id: `message:${threadId}:initial`,
        threadId,
        sender: participantInput(caller),
        recipientIds: created.value.participants
          .filter((participant) => participant.id !== caller.id)
          .map((participant) => participant.id),
        content,
        visibility: { kind: "public" },
        metadata: {
          kind: "thread_initial_message",
          mode,
          createdByToolExecutionId: ctx.execution.id,
        },
      }, { operationKey: `create_thread:${threadId}:initial-message` });
      return {
        threadId,
        name,
        participantIds: created.value.participants.map((item) => item.id),
        mode,
        status: "started",
        eventId: created.event.id,
        messageEventId: message.event.id,
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
      const thread = await ctx.processor.conversation.getThread(
        ctx.execution.threadId,
      );
      if (!thread) throw new Error("The active thread was not found.");
      await ctx.processor.conversation.updateThread(
        thread.id,
        {
          status: "archived",
          metadata: { ...thread.metadata, summary },
        },
        { operationKey: "end_thread" },
      );
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
    read_tool_result: readToolResultTool,
    update_my_memory: updateMyMemoryTool,
    update_user_memory: () => updateUserMemoryTool(now),
    list_skills: listSkillsTool,
    load_skill: loadSkillTool,
    create_thread: createThreadTool,
    read_skill_resource: options.readSkillResource
      ? () => readSkillResourceTool(options.readSkillResource!)
      : undefined,
    end_thread: endThreadTool,
  });
}

/** Packages runtime-neutral built-ins; host-specific tools require adapters. */
export function createBuiltInToolsPlugin(
  options: CreateBuiltInToolsPluginOptions = {},
): CopilotzPlugin {
  const defaultIds: BuiltInCoreToolId[] = [
    ...BUILT_IN_CORE_TOOL_IDS,
    ...(options.readSkillResource ? ADAPTER_CORE_TOOL_IDS : []),
  ];
  const ids = [...new Set(options.include ?? defaultIds)];
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
    manifest: {
      id: options.id ?? "@copilotz/built-in-tools",
      version: options.version ?? "3.0.0",
      provides: { tools: tools.map((tool) => tool.key) },
    },
    resources: { tools },
  });
}
