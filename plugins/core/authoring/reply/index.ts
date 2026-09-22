/** Projects one authorized resolved Core Message into a narrow reply. @module */

import type { ApplicationOutput } from "@copilotz/copilotz/application";
import { workflowMetadata } from "../../shared/workflow-metadata.ts";

export type CoreReplyProjectionScope = Readonly<{
  namespace: string;
  correlationId: string;
  threadId: string;
  agentId: string;
  viewerParticipantIds: readonly string[];
}>;

export type CoreReply = Readonly<{
  messageId: string;
  text: string;
}>;

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result ? result : null;
}

function ids(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return [];
  if (Object.getPrototypeOf(value) !== Array.prototype) return null;
  const result: string[] = [];
  for (const item of value) {
    const id = text(item);
    if (!id || result.includes(id)) return null;
    result.push(id);
  }
  return result;
}

function scope(value: unknown): {
  namespace: string;
  correlationId: string;
  threadId: string;
  agentId: string;
  viewerParticipantIds: readonly string[];
} | null {
  const input = plainRecord(value);
  if (!input) return null;
  const namespace = text(input.namespace);
  const correlationId = text(input.correlationId);
  const threadId = text(input.threadId);
  const agentId = text(input.agentId);
  const viewers = ids(input.viewerParticipantIds);
  if (
    !namespace || !correlationId || !threadId || !agentId || !viewers?.length
  ) {
    return null;
  }
  return {
    namespace,
    correlationId,
    threadId,
    agentId,
    viewerParticipantIds: viewers,
  };
}

function visibleTo(
  value: unknown,
  viewers: readonly string[],
): boolean {
  const visibility = plainRecord(value);
  if (!visibility) return false;
  if (visibility.kind === "public") return true;
  if (visibility.kind !== "participants") return false;
  const participants = ids(visibility.participantIds);
  return Boolean(
    participants?.some((participantId) => viewers.includes(participantId)),
  );
}

function sameIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((id) => right.includes(id));
}

function relatedToViewer(
  recipientIds: readonly string[],
  viewers: readonly string[],
): boolean {
  return recipientIds.length === 0 ||
    recipientIds.some((id) => viewers.includes(id));
}

/**
 * Projects one committed, resolved Core agent message for a trusted viewer.
 * The caller supplies the correlation and participant scope explicitly.
 */
export function projectCoreReply(
  output: ApplicationOutput,
  requestedScope: CoreReplyProjectionScope,
): CoreReply | null {
  const selected = scope(requestedScope);
  if (!selected) return null;
  const envelope = plainRecord(output);
  if (
    !envelope || envelope.durable !== true ||
    envelope.type !== "message.created" || !("data" in envelope)
  ) return null;
  if (
    text(envelope.namespace) !== selected.namespace ||
    text(envelope.correlationId) !== selected.correlationId
  ) return null;

  const subject = plainRecord(envelope.subject);
  const messageId = text(subject?.id);
  if (!subject || subject.type !== "message" || !messageId) return null;

  const data = plainRecord(envelope.data);
  const row = plainRecord(data?.record);
  if (!data || data.operation !== "create" || !row) return null;
  if (
    text(row.id) !== messageId || text(row.namespace) !== selected.namespace ||
    text(row.threadId) !== selected.threadId
  ) return null;
  if (
    row.historyScopeId !== undefined &&
    (typeof row.historyScopeId !== "string" || row.historyScopeId.trim())
  ) {
    return null;
  }

  const workflow = workflowMetadata(row.metadata);
  const agentParticipantId = text(workflow?.agentParticipantId);
  const agentId = text(workflow?.agentId);
  const senderId = text(row.senderId);
  if (
    !workflow || workflow.kind !== "agent_output" || !agentParticipantId ||
    !agentId || !senderId || agentParticipantId !== senderId ||
    agentId !== selected.agentId
  ) return null;

  const core = plainRecord(plainRecord(envelope.metadata)?.core);
  const envelopeThreadId = text(core?.threadId);
  if (!core || envelopeThreadId !== selected.threadId) return null;
  const envelopeVisibility = core.visibility === undefined
    ? { kind: "public" }
    : core.visibility;
  if (!visibleTo(envelopeVisibility, selected.viewerParticipantIds)) {
    return null;
  }

  if (
    row.visibility !== undefined &&
    !visibleTo(row.visibility, selected.viewerParticipantIds)
  ) return null;

  let routeSenderId: string | undefined;
  let routeRecipients: readonly string[] | undefined;
  if (core.routing !== undefined) {
    const routing = plainRecord(core.routing);
    if (!routing) return null;
    if (routing.senderId !== undefined) {
      routeSenderId = text(routing.senderId) ?? undefined;
      if (!routeSenderId) return null;
    }
    if (routing.recipientIds !== undefined) {
      routeRecipients = ids(routing.recipientIds) ?? undefined;
      if (!routeRecipients) return null;
    }
  }
  if (routeSenderId && routeSenderId !== senderId) return null;

  let rowRecipients: readonly string[] | undefined;
  if (row.recipientIds !== undefined) {
    rowRecipients = ids(row.recipientIds) ?? undefined;
    if (!rowRecipients) return null;
  }
  if (
    routeRecipients && rowRecipients && !sameIds(routeRecipients, rowRecipients)
  ) {
    return null;
  }
  if (
    (routeRecipients &&
      !relatedToViewer(routeRecipients, selected.viewerParticipantIds)) ||
    (rowRecipients &&
      !relatedToViewer(rowRecipients, selected.viewerParticipantIds))
  ) return null;

  if (!Array.isArray(row.content)) return null;
  const bodyText: string[] = [];
  for (const value of row.content) {
    const part = plainRecord(value);
    if (!part || part.resolve === false) continue;
    const reference = part.ref === undefined ? part : plainRecord(part.ref);
    if (!reference) continue;
    if (reference.resolve === false) continue;
    if (reference.kind !== "text" || reference.role !== "body") continue;
    if (typeof part.text !== "string" || !part.text.trim()) continue;
    bodyText.push(part.text);
  }
  const textValue = bodyText.join("\n").trim();
  return textValue ? { messageId, text: textValue } : null;
}
