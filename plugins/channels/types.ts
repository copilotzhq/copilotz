import type { Agent } from "@copilotz/copilotz/resources";
import type {
  ApplicationSendHandle,
  ApplicationSendInput,
  CopilotzApplication,
} from "@copilotz/copilotz/application";
import type { AttachmentOutput } from "@copilotz/copilotz/attachments";
import type {
  ConversationThread,
  Participant,
  ParticipantInput,
} from "@copilotz/copilotz/domain";

export type ChannelRoute = Readonly<{ ingress: string; egress: string }>;

export type ChannelRequest = Readonly<{
  method: string;
  headers: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: unknown;
  rawBody?: Uint8Array;
  callback?: (output: AttachmentOutput) => void | Promise<void>;
  context?: Readonly<Record<string, unknown>>;
  route: ChannelRoute;
}>;

export type ChannelThreadInput = Readonly<{
  id?: string;
  externalId?: string;
  name?: string;
  description?: string;
  status?: string;
  /** Participants belong to the thread independently of message recipients. */
  participants?: readonly ChannelParticipantRef[];
  /** Merged into existing thread metadata and used as initial metadata. */
  metadata?: Record<string, unknown>;
}>;

export type ChannelParticipantRef = string | Participant | ParticipantInput;

export type ChannelIngressEnvelope = Readonly<{
  thread: string | ConversationThread | ChannelThreadInput;
  participant: ChannelParticipantRef;
  recipients?: readonly ChannelParticipantRef[];
  input: ApplicationSendInput;
}>;

export type ChannelIngressResult = Readonly<{
  inputs?: readonly ChannelIngressEnvelope[];
  status?: number;
  response?: unknown;
}>;

export type ChannelIngressContext = Readonly<{
  application: CopilotzApplication;
  namespace: string;
  channel: ChannelResource;
}>;

export type ChannelIngressAdapter = Readonly<{
  handle(
    request: ChannelRequest,
    context: ChannelIngressContext,
  ): ChannelIngressResult | Promise<ChannelIngressResult>;
}>;

export type ChannelExecution = Readonly<{
  handle: ApplicationSendHandle;
  thread: ConversationThread;
  participant: Participant;
  recipientIds: readonly string[];
  outputs: ReadableStream<AttachmentOutput>;
}>;

export type ChannelEgressContext = Readonly<{
  application: CopilotzApplication;
  namespace: string;
  channel: ChannelResource;
  route: ChannelRoute;
  request: ChannelRequest;
  execution: ChannelExecution;
}>;

export type ChannelEgressAdapter = Readonly<{
  /** Request-bound transports (for example SSE) keep dispatch open to completion. */
  requestBound?: boolean;
  deliver(context: ChannelEgressContext): void | Promise<void>;
}>;

export type ChannelResource = Readonly<{
  id: string;
  ingress?: ChannelIngressAdapter;
  egress?: ChannelEgressAdapter;
  /** Agent resource IDs used when an ingress envelope has no recipients. */
  defaultAgentIds?: readonly string[];
}>;

export type ChannelDispatchResult = Readonly<{
  status: number;
  response?: unknown;
  requestBound: boolean;
  executions: readonly ChannelExecution[];
  done: Promise<void>;
  cancel(reason?: string): Promise<void>;
}>;

export type CreateChannelRuntimeOptions = Readonly<{
  onDetachedError?: (error: unknown, request: ChannelRequest) => void;
}>;

export type ChannelRuntime = Readonly<{
  list(): readonly ChannelResource[];
  get(id: string): ChannelResource | undefined;
  dispatch(
    namespace: string,
    request: ChannelRequest,
  ): Promise<ChannelDispatchResult>;
}>;

export type CreateWebChannelOptions = Readonly<{
  id?: string;
  defaultAgentIds?: readonly string[];
}>;

export type CreateWebChannelPluginOptions =
  & CreateWebChannelOptions
  & Readonly<{
    pluginId?: string;
    version?: string;
  }>;

export type ChannelAgent = Pick<Agent, "id" | "name" | "externalId">;
