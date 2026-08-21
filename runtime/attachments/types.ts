import type { ContentInput } from "../content/index.ts";
import type {
  ConversationThread,
  Participant,
  ParticipantInput,
} from "../domain/index.ts";
import type {
  CopilotzEvent,
  DurableEvent,
  EventSubject,
  EventVisibility,
} from "../events/index.ts";

export type AttachmentParticipantRef = string | Participant;

export type ConnectAttachmentInput = Readonly<{
  namespace: string;
  thread: string | ConversationThread;
  participant: AttachmentParticipantRef;
  recipientIds?: readonly string[];
  databaseSchema?: string;
  /** Resume after this durable event position. SSE `id:` / Last-Event-ID. */
  afterPosition?: string;
  /** Byte offsets for observed live stream outputs, keyed by stream id. */
  streamOffsets?: Readonly<Record<string, number>>;
}>;

export type AttachmentMessageInput = Readonly<{
  content: ContentInput | readonly ContentInput[];
  sender?: string | Participant | ParticipantInput;
  recipientIds?: readonly string[];
  id?: string;
  correlationId?: string;
  deduplicationId?: string;
  metadata?: Record<string, unknown>;
  visibility?: EventVisibility;
}>;

export type AttachmentEventInput = Readonly<{
  type: string;
  payload: unknown;
  durable?: boolean;
  subject?: EventSubject;
  recipientIds?: readonly string[];
  correlationId?: string;
  causationId?: string;
  deduplicationId?: string;
  metadata?: Record<string, unknown>;
  visibility?: EventVisibility;
}>;

export type AttachmentSendInput =
  | AttachmentMessageInput
  | AttachmentEventInput;

export type AttachmentEventHandle = Readonly<{
  event: CopilotzEvent;
  eventId?: string;
  correlationId: string;
  done: Promise<void>;
  cancel(reason?: string): Promise<void>;
}>;

export type AttachmentMessageHandle =
  & AttachmentEventHandle
  & Readonly<{
    event: DurableEvent;
    eventId: string;
    messageId: string;
  }>;

export type AttachmentSendResult =
  | AttachmentEventHandle
  | AttachmentMessageHandle;

export type AttachmentOutputParticipant = Readonly<{
  id: string;
  externalId: string;
  type: "user" | "agent" | "tool" | "job";
  name?: string;
}>;

export type AttachmentStreamOutput = Readonly<{
  type: "stream.output";
  streamId: string;
  participant: AttachmentOutputParticipant;
  mediaType: string;
  causationId?: string;
  correlationId: string;
  metadata: Readonly<Record<string, unknown>>;
  payload: ReadableStream<Uint8Array>;
}>;

export type AttachmentOutput = CopilotzEvent | AttachmentStreamOutput;

export type ThreadAttachment = Readonly<{
  id: string;
  namespace: string;
  thread: ConversationThread;
  participant: Participant;
  outputs: ReadableStream<AttachmentOutput>;
  send(input: AttachmentMessageInput): Promise<AttachmentMessageHandle>;
  send(input: AttachmentEventInput): Promise<AttachmentEventHandle>;
  close(reason?: string): Promise<void>;
}>;

export type RunInput = Readonly<{
  namespace: string;
  thread: string | ConversationThread;
  participant: AttachmentParticipantRef;
  recipientIds?: readonly string[];
  content: ContentInput | readonly ContentInput[];
  sender?: string | Participant | ParticipantInput;
  messageId?: string;
  correlationId?: string;
  deduplicationId?: string;
  metadata?: Record<string, unknown>;
  visibility?: EventVisibility;
  databaseSchema?: string;
}>;

export type RunHandle = Readonly<{
  eventId: string;
  threadId: string;
  correlationId: string;
  outputs: ReadableStream<AttachmentOutput>;
  done: Promise<void>;
  cancel(reason?: string): Promise<void>;
}>;
