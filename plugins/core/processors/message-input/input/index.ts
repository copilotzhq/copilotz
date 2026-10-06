import { coreThreadObservationMetadata } from "../../../shared/events/index.ts";
import type { EventVisibility } from "@copilotz/copilotz/core";
/** Defines the typed Core Message input envelope helper. @module */
import type { CopilotzInputEnvelope } from "@copilotz/copilotz/application";
import {
  type ContentInput,
  type ContentWireInput,
  encodeContent,
} from "@copilotz/copilotz/content";
import type {
  Participant,
  ParticipantInput,
} from "../../../shared/contracts.ts";
import type {} from "@copilotz/copilotz/events";
export const CORE_MESSAGE_INPUT_EVENT = "copilotz.core.message.input";
/** Object Thread references opt into create-or-reuse behavior at Core ingress. */
export type CoreThreadInput = Readonly<
  | { id: string; externalId?: string }
  | { id?: string; externalId: string }
>;
export type CoreMessageInput = Readonly<{
  thread: string | CoreThreadInput;
  participant: string | Participant | ParticipantInput;
  recipientIds?: readonly string[];
  content: ContentInput | readonly ContentInput[];
  id?: string;
  correlationId?: string;
  deduplicationId?: string;
  metadata?: Record<string, unknown>;
  visibility?: EventVisibility;
}>;
export type CoreMessageInputEnvelope = CopilotzInputEnvelope<
  typeof CORE_MESSAGE_INPUT_EVENT,
  Omit<CoreMessageInput, "content"> & {
    content: ContentWireInput | readonly ContentWireInput[];
  }
>;
/** Typed Core input helper. Runtime treats the result as an opaque envelope. */
export function message(input: CoreMessageInput): CoreMessageInputEnvelope {
  const {
    correlationId,
    deduplicationId,
    content,
    metadata,
    visibility,
    ...payload
  } = input;
  const threadId = typeof payload.thread === "string"
    ? payload.thread
    : payload.thread.id;
  return ({
    type: CORE_MESSAGE_INPUT_EVENT,
    payload: {
      ...payload,
      content: encodeContent(content),
      ...(metadata ? { metadata: structuredClone(metadata) } : {}),
      ...(visibility ? { visibility } : {}),
    } as const,
    ...(correlationId ? { correlationId } : {}),
    ...(deduplicationId ? { deduplicationId } : {}),
    ...(visibility || threadId
      ? {
        metadata: {
          ...(threadId ? coreThreadObservationMetadata(threadId) : {}),
          core: {
            ...(threadId ? { threadId } : {}),
            ...(visibility ? { visibility } : {}),
          },
        },
      }
      : {}),
  } as const);
}
export type CoreInputHelpers = Readonly<{
  message: typeof message;
}>;
export const core: CoreInputHelpers = {
  message,
} as const;
