import type { CopilotzEvent, EventSendHandle } from "@/events/types.ts";
import type {
  MessagePayload,
  ParticipantRecord,
  ThreadRecord,
} from "@/types/resources.ts";

export interface ConnectOptions {
  thread: string | {
    id?: string;
    externalId?: string;
    name?: string;
    parentThreadId?: string;
    metadata?: Record<string, unknown>;
  };
  participant: string | {
    id?: string;
    externalId: string;
    participantType?: "human" | "agent" | "job";
    name?: string;
    agentId?: string;
    metadata?: Record<string, unknown>;
  };
  namespace?: string;
  schema?: string;
}

export interface DiscreteEventInput {
  type: string;
  payload?: unknown;
  sender?: MessagePayload["sender"];
  target?: string;
  metadata?: Record<string, unknown>;
  correlationId?: string;
  deduplicationId?: string;
}

export interface StreamInput {
  type: string;
  mediaType: string;
  payload: ReadableStream<Uint8Array>;
  target?: string;
  provider?: string;
  metadata?: Record<string, unknown>;
  correlationId?: string;
}

export interface StreamSendHandle {
  readonly streamId: string;
  readonly correlationId: string;
  readonly done: Promise<void>;
  cancel(reason?: string): Promise<void>;
}

export interface AttachmentStreamOutput {
  readonly kind: "stream";
  readonly participant: {
    id: string;
    name?: string;
    type: string;
  };
  readonly mediaType: string;
  readonly streamId: string;
  readonly threadId: string;
  readonly namespace: string;
  readonly causationId?: string;
  readonly correlationId: string;
  readonly payload: ReadableStream<Uint8Array>;
}

export type AttachmentOutput = CopilotzEvent | AttachmentStreamOutput;

export function isAttachmentStreamOutput(
  value: AttachmentOutput,
): value is AttachmentStreamOutput {
  return "kind" in value && value.kind === "stream";
}

export interface Attachment {
  readonly thread: ThreadRecord;
  readonly participant: ParticipantRecord;
  readonly namespace: string;
  readonly outputs: ReadableStream<AttachmentOutput>;
  send(input: MessagePayload): Promise<EventSendHandle>;
  send(input: DiscreteEventInput): Promise<EventSendHandle>;
  send(input: StreamInput): Promise<StreamSendHandle>;
  close(): Promise<void>;
}

export interface RunHandle extends EventSendHandle {
  readonly events: ReadableStream<CopilotzEvent>;
}

export interface RunOptions {
  thread?: ConnectOptions["thread"];
  participant?: ConnectOptions["participant"];
  namespace?: string;
  schema?: string;
  metadata?: Record<string, unknown>;
  correlationId?: string;
}

export function isStreamInput(value: unknown): value is StreamInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  const payload = input.payload as { getReader?: unknown } | undefined;
  return typeof input.type === "string" &&
    typeof input.mediaType === "string" &&
    Boolean(payload && typeof payload.getReader === "function");
}

export function isDiscreteEventInput(
  value: unknown,
): value is DiscreteEventInput {
  return Boolean(
    value && typeof value === "object" &&
      typeof (value as Record<string, unknown>).type === "string",
  );
}
