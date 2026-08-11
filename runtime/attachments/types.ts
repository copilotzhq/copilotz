import type { Agent } from "../resources/index.ts";
import type { ContentInput } from "../content/index.ts";
import type {
  ConversationMessage,
  ConversationThread,
  Participant,
  ParticipantInput,
  ToolExecution,
} from "../domain/index.ts";
import type {
  CopilotzEvent,
  DurableEvent,
  EventSubject,
  EventVisibility,
} from "../events/index.ts";
import type { CopilotzProcessorCapabilities } from "../engine/types.ts";
import type { CreateDeliveryMutationIdentity } from "../execution/index.ts";
import type { ResolvedContent } from "../content/index.ts";

export const COPILOTZ_STREAM_WORKLOAD = "copilotz.stream.v1";

export type AttachmentParticipantRef = string | Participant;

export type ConnectAttachmentInput = Readonly<{
  namespace: string;
  thread: string | ConversationThread;
  participant: AttachmentParticipantRef;
  recipientIds?: readonly string[];
  schema?: string;
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

export type AttachmentStreamInput = Readonly<{
  type: string;
  mediaType: string;
  payload: ReadableStream<Uint8Array>;
  recipientId?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
  visibility?: EventVisibility;
  outputMediaType?: string;
}>;

export type AttachmentSendInput =
  | AttachmentMessageInput
  | AttachmentEventInput
  | AttachmentStreamInput;

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

export type AttachmentStreamHandle = Readonly<{
  streamId: string;
  eventId: string;
  correlationId: string;
  done: Promise<void>;
  cancel(reason?: string): Promise<void>;
}>;

export type AttachmentSendResult =
  | AttachmentEventHandle
  | AttachmentMessageHandle
  | AttachmentStreamHandle;

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
  send(input: AttachmentStreamInput): Promise<AttachmentStreamHandle>;
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
  schema?: string;
}>;

export type RunHandle = Readonly<{
  eventId: string;
  threadId: string;
  correlationId: string;
  events: ReadableStream<CopilotzEvent>;
  done: Promise<void>;
  cancel(reason?: string): Promise<void>;
}>;

export type RealtimeProviderInput = Readonly<{
  streamId: string;
  namespace: string;
  threadId: string;
  correlationId: string;
  inputType: string;
  mediaType: string;
  participantId: string;
  recipientId: string;
  agentId: string;
  agent: Agent;
  input: ReadableStream<Uint8Array>;
  metadata: Readonly<Record<string, unknown>>;
  /** Typed domain/event capabilities when the hosting worker supplies them. */
  context?: RealtimeProviderContext;
  signal: AbortSignal;
}>;

export type RealtimeContextMessageInput = Readonly<{
  content: ContentInput | readonly ContentInput[];
  sender?: "participant" | "agent" | ParticipantInput;
  recipientIds?: readonly string[];
  id?: string;
  operationKey?: string;
  metadata?: Record<string, unknown>;
  visibility?: EventVisibility;
}>;

export type RealtimeContextMessageResult = Readonly<{
  message: ConversationMessage;
  event: DurableEvent;
}>;

export type RealtimeToolCallInput = Readonly<{
  tool: string;
  arguments?: unknown;
  id?: string;
  toolCallId?: string;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
  historyVisibility?: "requester_only" | "public_status" | "public";
}>;

export type RealtimeToolCallResult = Readonly<{
  execution: ToolExecution;
  event: DurableEvent;
  message: ConversationMessage;
  output?: ResolvedContent;
}>;

export type RealtimeAgentAskInput = Readonly<{
  target: string;
  message: string;
  id?: string;
  toolCallId?: string;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}>;

export type RealtimeAgentAskResult =
  & RealtimeToolCallResult
  & Readonly<{
    answer?: ConversationMessage;
    answerContent?: readonly ResolvedContent[];
  }>;

export type RealtimeProviderContext =
  & CopilotzProcessorCapabilities
  & Readonly<{
    streamId: string;
    threadId: string;
    correlationId: string;
    participantId: string;
    agentParticipantId: string;
    agentId: string;
    signal: AbortSignal;
    send(
      input: RealtimeContextMessageInput,
    ): Promise<RealtimeContextMessageResult>;
    tool(input: RealtimeToolCallInput): Promise<RealtimeToolCallResult>;
    ask(input: RealtimeAgentAskInput): Promise<RealtimeAgentAskResult>;
  }>;

export type RealtimeProviderOutput = Readonly<{
  output?: Uint8Array | ReadableStream<Uint8Array>;
  mediaType?: string;
  metadata?: Record<string, unknown>;
}>;

export type RealtimeProviderResource = Readonly<{
  id: string;
  type: "realtime";
  open(
    input: RealtimeProviderInput,
  ): RealtimeProviderOutput | Promise<RealtimeProviderOutput>;
}>;

export type StreamDispatchMetadata = Readonly<{
  schema: "copilotz.stream.dispatch.v1";
  streamId: string;
  eventId: string;
  namespace: string;
  threadId: string;
  correlationId: string;
  inputType: string;
  mediaType: string;
  participantId: string;
  recipientId: string;
  agentId: string;
  providerId: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type RealtimeProviderContextBase = Readonly<{
  event: DurableEvent;
  metadata: StreamDispatchMetadata;
  signal: AbortSignal;
  createMutationIdentity: CreateDeliveryMutationIdentity;
}>;

export type RealtimeProviderContextFactory = (
  base: RealtimeProviderContextBase,
) =>
  | RealtimeProviderContext
  | void
  | Promise<RealtimeProviderContext | void>;
