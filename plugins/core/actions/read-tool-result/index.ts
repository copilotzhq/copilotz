/** Reads a bounded part of one authorized historical Tool result. @module */

import type { ActionDefinition } from "@copilotz/copilotz/actions";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type { ContentRef } from "@copilotz/copilotz/content";
import { defineAction } from "@copilotz/copilotz/actions";
import type { CoreActionContext } from "../../shared/runtime-context.ts";
import {
  coreAgentTurnMetadata,
  coreToolActionMessageMetadata,
  coreToolActionMetadata,
  workflowMetadata,
} from "../../shared/workflow-metadata.ts";
import { coreAgent } from "../../shared/runtime-context.ts";
import {
  optionalText,
  participantAgentId,
  requireCollection,
  stringArray,
} from "../../shared/helpers.ts";

export const READ_TOOL_RESULT_ACTION_ID = "copilotz.core.read-tool-result";
const ACTION_ALIAS = "readToolResult";
const DEFAULT_READ_LIMIT = 8 * 1024;
const DEFAULT_MAX_READ_BYTES = 16 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const MIN_INLINE_BYTES = 2 * 1024;
const TOOL_RESULT_ENVELOPE_RESERVE = 512;

export type ReadToolResultInput = Readonly<{
  messageId: string;
  offset?: number;
  limit?: number;
  search?: string;
}>;

export type ReadToolResultOutput = Readonly<{
  messageId: string;
  /** UTF-8 byte length of the assembled text representation. */
  totalBytes: number;
  /** Sum of canonical source Asset body byte lengths. */
  sourceBytes: number;
  offset: number;
  limit: number;
  nextOffset: number;
  found?: boolean;
  matchOffset?: number;
  content: string;
}>;

const inputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    messageId: {
      type: "string",
      minLength: 1,
      description:
        "The canonical Message ID shown in a truncated result marker.",
    },
    offset: {
      type: "integer",
      minimum: 0,
      description: "UTF-8 byte offset in the assembled result text.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_READ_BYTES,
      description: "Maximum UTF-8 bytes to return (capped by Core policy).",
    },
    search: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      description: "Find the next plain literal match at or after offset.",
    },
  },
  required: ["messageId"],
} as const;

const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    messageId: { type: "string" },
    totalBytes: { type: "integer" },
    sourceBytes: { type: "integer" },
    offset: { type: "integer" },
    limit: { type: "integer" },
    nextOffset: { type: "integer" },
    found: { type: "boolean" },
    matchOffset: { type: "integer" },
    content: { type: "string" },
  },
  required: [
    "messageId",
    "totalBytes",
    "sourceBytes",
    "offset",
    "limit",
    "nextOffset",
    "content",
  ],
} as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function configuredReadLimit(context: CoreActionContext): number {
  const policy = context.resources?.toolResults?.default as
    | { maxReadBytes?: unknown }
    | undefined;
  const configured = policy?.maxReadBytes;
  return typeof configured === "number" && Number.isSafeInteger(configured) &&
      configured > 0
    ? Math.min(configured, MAX_READ_BYTES)
    : DEFAULT_MAX_READ_BYTES;
}

function configuredInlineLimit(context: CoreActionContext): number {
  const policy = context.resources?.toolResults?.default as
    | { maxInlineBytes?: unknown }
    | undefined;
  const configured = policy?.maxInlineBytes;
  if (configured === undefined) return 10 * 1024;
  if (
    typeof configured !== "number" || !Number.isSafeInteger(configured) ||
    configured < MIN_INLINE_BYTES
  ) {
    throw new RangeError(
      `Core toolResults.default.maxInlineBytes must be at least ${MIN_INLINE_BYTES}.`,
    );
  }
  return configured;
}

function configuredSourceLimit(context: CoreActionContext): number {
  const policy = context.resources.toolResults?.default as
    | { maxSourceBytes?: unknown }
    | undefined;
  const configured = policy?.maxSourceBytes;
  return typeof configured === "number" && Number.isSafeInteger(configured) &&
      configured > 0
    ? Math.min(configured, 64 * 1024 * 1024)
    : 16 * 1024 * 1024;
}

function indexOfBytes(
  input: Uint8Array,
  needle: Uint8Array,
  from: number,
): number {
  if (!needle.length) return Math.max(0, from);
  const lastStart = input.length - needle.length;
  for (let index = Math.max(0, from); index <= lastStart; index++) {
    let match = true;
    for (let part = 0; part < needle.length; part++) {
      if (input[index + part] !== needle[part]) {
        match = false;
        break;
      }
    }
    if (match) return index;
  }
  return -1;
}

function isContinuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

function textContent(record: CollectionRecord): ContentRef[] {
  return Array.isArray(record.content)
    ? record.content.filter((entry): entry is ContentRef =>
      Boolean(entry) && typeof entry === "object" &&
      typeof (entry as Record<string, unknown>).assetId === "string" &&
      typeof (entry as Record<string, unknown>).kind === "string"
    )
    : [];
}

function excludedFromTranscript(ref: ContentRef): boolean {
  return ref.disposition === "attachment" ||
    (ref.kind === "file" && ref.disposition == null);
}

function sameAgentResult(
  message: CollectionRecord,
  threadId: string,
  agentId: string,
  participantId: string,
  sender: CollectionRecord | null,
): boolean {
  if (sender?.participantType !== "tool") return false;
  const metadata = record(message.metadata);
  const invocation = record(metadata.toolInvocation);
  const requesterId = optionalText(metadata.requesterId);
  const workflow = workflowMetadata(metadata);
  const action = coreToolActionMessageMetadata(metadata);
  if (
    !optionalText(invocation.id) ||
    !["completed", "failed", "cancelled"].includes(
      String(metadata.toolStatus),
    )
  ) return false;
  if (action) {
    if (
      action.threadId !== threadId ||
      action.agentParticipantId !== requesterId
    ) return false;
  } else if (workflow?.agentParticipantId !== requesterId) {
    return false;
  }
  const visibility = record(message.visibility);
  if (requesterId === participantId) {
    if (action && action.agentId !== agentId) return false;
    if (workflow && workflow.agentParticipantId !== participantId) return false;
  } else if (
    !(visibility.kind === "public" &&
      metadata.historyVisibility === "public") &&
    !(visibility.kind === "participants" &&
      stringArray(visibility.participantIds).includes(participantId))
  ) return false;
  if (visibility.kind === "internal") {
    const turn = coreAgentTurnMetadata(metadata);
    return Boolean(
      turn && turn.ownerParticipantId === participantId &&
        message.historyScopeId === turn.id,
    );
  }
  if (visibility.kind === "participants") {
    return stringArray(visibility.participantIds).includes(participantId);
  }
  if (visibility.kind === "tool") {
    return visibility.requesterId === participantId;
  }
  return visibility.kind === undefined || visibility.kind === "public";
}

async function executeReadToolResult(
  raw: ReadToolResultInput,
  context: CoreActionContext,
): Promise<ReadToolResultOutput> {
  const input = record(raw);
  const messageId = optionalText(input.messageId);
  if (!messageId) throw new TypeError("Tool result Message ID is required.");
  const offset = input.offset ?? 0;
  const requestedLimit = input.limit ?? DEFAULT_READ_LIMIT;
  if (!Number.isSafeInteger(offset) || Number(offset) < 0) {
    throw new TypeError("Tool result offset must be a non-negative integer.");
  }
  if (
    !Number.isSafeInteger(requestedLimit) || Number(requestedLimit) <= 0 ||
    Number(requestedLimit) > MAX_READ_BYTES
  ) {
    throw new TypeError(
      "Tool result limit must be between 1 and 1048576 bytes.",
    );
  }
  const search = input.search;
  if (
    search !== undefined &&
    (typeof search !== "string" || !search.length || search.length > 512)
  ) {
    throw new TypeError(
      "Tool result search must be a non-empty literal string.",
    );
  }

  const origin = coreToolActionMetadata(context.action.metadata);
  if (!origin || origin.action !== ACTION_ALIAS) {
    throw new Error("Tool result retrieval requires Core Action provenance.");
  }
  const thread = await requireCollection(context, "thread").get({
    id: origin.threadId,
  });
  const participant = await requireCollection(context, "participant").get({
    id: origin.agentParticipantId,
  });
  if (
    !thread ||
    !stringArray(thread.participantIds).includes(origin.agentParticipantId) ||
    participant?.participantType !== "agent" ||
    participantAgentId(participant) !== origin.agentId ||
    !coreAgent(context.resources, origin.agentId)
  ) {
    throw new Error("Tool result is unavailable to this Agent in this thread.");
  }

  const messages = requireCollection(context, "message");
  const history = messages.queries.history;
  if (!history) throw new Error("Core Message history query is unavailable.");
  const [visibleMessage] = await history({
    threadId: origin.threadId,
    messageId,
    view: "all",
    viewerParticipantIds: [origin.agentParticipantId],
  });
  // Private Agent turns are deliberately absent from public history. Resolve
  // that case by exact ID only, then require the opaque turn scope below.
  const message = visibleMessage ?? await messages.get({ id: messageId });
  if (!message || message.threadId !== origin.threadId) {
    throw new Error("Tool result is unavailable to this Agent in this thread.");
  }
  const sender = await requireCollection(context, "participant").get({
    id: String(message.senderId),
  });
  if (
    !sameAgentResult(
      message,
      origin.threadId,
      origin.agentId,
      origin.agentParticipantId,
      sender,
    )
  ) {
    throw new Error("Tool result is unavailable to this Agent in this thread.");
  }

  const refs = textContent(message).filter((ref) =>
    !excludedFromTranscript(ref)
  );
  const assets = refs.length
    ? await context.content.getMany([
      ...new Set(refs.map((ref) => ref.assetId)),
    ])
    : [];
  const sizes = new Map(assets.map((asset) => [asset.id, asset.byteLength]));
  const sourceBytes = refs.reduce((total, ref) => {
    const size = sizes.get(ref.assetId);
    if (size === undefined) {
      throw new Error(`Tool result content '${ref.assetId}' is unavailable.`);
    }
    return total + size;
  }, 0);
  const bodyRefs = refs.filter((ref) =>
    ref.kind === "text" || ref.kind === "json"
  );
  const bodyBytes = bodyRefs.reduce(
    (total, ref) => total + (sizes.get(ref.assetId) ?? 0),
    0,
  );
  if (bodyBytes > configuredSourceLimit(context)) {
    throw new RangeError(
      `Tool result text exceeds the ${
        configuredSourceLimit(context)
      } byte retrieval limit.`,
    );
  }
  const resolved = bodyRefs.length
    ? await context.content.resolveMany(bodyRefs)
    : [];
  const resolvedById = new Map(
    resolved.map((item) => [item.ref.assetId, item]),
  );
  const parts = refs.map((ref) => {
    const item = resolvedById.get(ref.assetId);
    if (item) return item.bytes;
    const size = sizes.get(ref.assetId) ?? 0;
    return new TextEncoder().encode(
      `[${ref.kind} content: ${size} bytes]`,
    );
  });
  const totalOutputBytes = parts.reduce(
    (total, part) => total + part.byteLength,
    Math.max(0, parts.length - 1),
  );
  const bytes = new Uint8Array(totalOutputBytes);
  let cursor = 0;
  for (const [index, part] of parts.entries()) {
    if (index > 0) bytes[cursor++] = 10;
    bytes.set(part, cursor);
    cursor += part.byteLength;
  }
  const literal = typeof search === "string"
    ? new TextEncoder().encode(search)
    : undefined;
  const matchOffset = literal
    ? indexOfBytes(bytes, literal, Number(offset))
    : undefined;
  const found = literal ? matchOffset !== -1 : undefined;
  const limit = Math.min(
    Number(requestedLimit),
    configuredReadLimit(context) || DEFAULT_READ_LIMIT,
    Math.max(1, configuredInlineLimit(context) - 1024),
  );
  if (literal && matchOffset === -1) {
    return {
      messageId,
      totalBytes: bytes.byteLength,
      sourceBytes,
      offset: Number(offset),
      limit,
      nextOffset: Number(offset),
      found: false,
      content: "",
    };
  }
  const start = literal ? matchOffset! : Number(offset);
  const available = Math.min(bytes.length, Math.max(0, start));
  let alignedStart = available;
  while (
    alignedStart < bytes.length && isContinuationByte(bytes[alignedStart])
  ) alignedStart++;
  let end = Math.min(bytes.length, alignedStart + limit);
  while (
    end > alignedStart && end < bytes.length &&
    isContinuationByte(bytes[end])
  ) end--;
  if (end === alignedStart && alignedStart < bytes.length) {
    throw new TypeError(
      "Tool result limit is too small for the next UTF-8 character; request at least four bytes.",
    );
  }
  const outputFor = (nextOffset: number): ReadToolResultOutput => ({
    messageId,
    totalBytes: bytes.byteLength,
    sourceBytes,
    offset: alignedStart,
    limit,
    nextOffset,
    ...(literal ? { found, ...(found ? { matchOffset } : {}) } : {}),
    content: new TextDecoder().decode(bytes.subarray(alignedStart, nextOffset)),
  });
  const inlineLimit = configuredInlineLimit(context);
  const fitsInline = (output: ReadToolResultOutput) =>
    new TextEncoder().encode(JSON.stringify(output)).byteLength +
        TOOL_RESULT_ENVELOPE_RESERVE <= inlineLimit;
  let output = outputFor(end);
  if (!fitsInline(output)) {
    let low = 0;
    let high = end - alignedStart;
    let best: ReadToolResultOutput | undefined;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      let candidateEnd = alignedStart + middle;
      while (
        candidateEnd > alignedStart && candidateEnd < bytes.length &&
        isContinuationByte(bytes[candidateEnd])
      ) candidateEnd--;
      const candidate = outputFor(candidateEnd);
      if (fitsInline(candidate)) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (
      !best ||
      (best.nextOffset === alignedStart && alignedStart < bytes.length)
    ) {
      throw new RangeError(
        "Core toolResults.default.maxInlineBytes is too small for a usable Tool result read; raise the inline limit.",
      );
    }
    output = best;
  }
  if (
    literal && found &&
    output.nextOffset - output.offset < literal.byteLength
  ) {
    throw new RangeError(
      "The literal match is longer than one Tool result read can return under Core's inline limit; use a shorter search string or raise the limit.",
    );
  }
  return output;
}

export const readToolResultAction: ActionDefinition<
  ReadToolResultInput,
  ReadToolResultOutput,
  CoreActionContext,
  typeof inputSchema,
  typeof outputSchema
> = defineAction({
  id: READ_TOOL_RESULT_ACTION_ID,
  inputSchema,
  outputSchema,
  execute: executeReadToolResult,
});

export default readToolResultAction;
