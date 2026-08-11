import type {
  ContentSequence,
  DatabaseAssetRepository,
  DurableContentInput,
} from "../content/index.ts";
import type {
  CoordinatedMutationResult,
  EventCoordinator,
  EventStore,
  EventVisibility,
  SqlExecutor,
} from "../events/index.ts";

export type ParticipantType = "human" | "agent" | "tool" | "job";

export type Participant = Readonly<{
  id: string;
  namespace: string;
  externalId: string;
  participantType: ParticipantType;
  name?: string;
  email?: string;
  agentId?: string;
  metadata: Readonly<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
}>;

export type ParticipantInput = Readonly<{
  id?: string;
  externalId: string;
  participantType: ParticipantType;
  name?: string;
  email?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}>;

export type ConversationThread = Readonly<{
  id: string;
  namespace: string;
  externalId?: string;
  name?: string;
  description?: string;
  status: "active" | "archived" | "closed" | string;
  parentThreadId?: string;
  metadata: Readonly<Record<string, unknown>>;
  participants: readonly Participant[];
  activeMessageBranch?: MessageBranch;
  lastEventId?: string;
  lastEventPosition?: string;
  lastEventAt?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type MessageBranch = Readonly<{
  rootMessageId: string;
  headMessageId: string;
  previousRevisionMessageId: string;
  revisionIndex: number;
}>;

export type MessageRevision = Readonly<{
  rootMessageId: string;
  previousRevisionMessageId: string;
  revisionIndex: number;
  revisedAt: string;
}>;

export type ConversationMessage = Readonly<{
  id: string;
  namespace: string;
  threadId: string;
  sender: Participant;
  recipientIds: readonly string[];
  content: ContentSequence;
  metadata: Readonly<Record<string, unknown>>;
  revision?: MessageRevision;
  createdAt: string;
  updatedAt: string;
}>;

export type MutationIdentity = Readonly<{
  causationId?: string;
  correlationId?: string;
  deduplicationId?: string;
  metadata?: Record<string, unknown>;
}>;

export type CreateParticipantInput = Readonly<{
  namespace: string;
  participant: ParticipantInput;
  identity?: MutationIdentity;
}>;

export type ParticipantPatch = Readonly<{
  name?: string | null;
  email?: string | null;
  agentId?: string | null;
  metadata?: Record<string, unknown>;
}>;

export type UpdateParticipantInput = Readonly<{
  namespace: string;
  id: string;
  patch: ParticipantPatch;
  identity?: MutationIdentity;
}>;

export type CreateThreadInput = Readonly<{
  namespace: string;
  id?: string;
  externalId?: string;
  name?: string;
  description?: string;
  status?: ConversationThread["status"];
  participants?: readonly ParticipantInput[];
  parentThreadId?: string;
  metadata?: Record<string, unknown>;
  identity?: MutationIdentity;
}>;

export type AddThreadParticipantInput = Readonly<{
  namespace: string;
  threadId: string;
  participant: ParticipantInput;
  identity?: MutationIdentity;
}>;

export type ThreadPatch = Readonly<{
  name?: string | null;
  description?: string | null;
  status?: ConversationThread["status"];
  metadata?: Record<string, unknown>;
}>;

export type UpdateThreadInput = Readonly<{
  namespace: string;
  id: string;
  patch: ThreadPatch;
  identity?: MutationIdentity;
}>;

export type CreateMessageInput = Readonly<{
  namespace: string;
  id?: string;
  threadId: string;
  sender: ParticipantInput;
  recipientIds?: readonly string[];
  content: DurableContentInput;
  visibility?: EventVisibility;
  metadata?: Record<string, unknown>;
  identity?: MutationIdentity;
}>;

export type ReviseMessageInput = Readonly<{
  namespace: string;
  id?: string;
  threadId: string;
  messageId: string;
  content: DurableContentInput;
  visibility?: EventVisibility;
  metadata?: Record<string, unknown>;
  identity?: MutationIdentity;
}>;

export type MessageRevisionResult = Readonly<{
  message: ConversationMessage;
  rootMessageId: string;
  previousRevisionMessageId: string;
  revisionIndex: number;
}>;

export type DeleteThreadMessagesInput = Readonly<{
  namespace: string;
  threadId: string;
  identity?: MutationIdentity;
}>;

export type DeleteThreadMessagesResult = Readonly<{
  threadId: string;
  deleted: true;
}>;

export type DeleteThreadInput = Readonly<{
  namespace: string;
  id: string;
  identity?: MutationIdentity;
}>;

export type DeleteThreadResult = Readonly<{
  id: string;
  deleted: true;
}>;

export type ListMessagesOptions = Readonly<{
  after?: string;
  before?: string;
  limit?: number;
  order?: "asc" | "desc";
  /** Active branch by default; `all` includes superseded messages/revisions. */
  view?: "active" | "all";
}>;

export type ListParticipantsOptions = Readonly<{
  participantType?: ParticipantType;
  after?: string;
  limit?: number;
}>;

export type ListThreadsOptions = Readonly<{
  participantId?: string;
  status?: string | readonly string[];
  after?: string;
  limit?: number;
  order?: "asc" | "desc";
}>;

export type ConversationRepository = Readonly<{
  createParticipant(
    input: CreateParticipantInput,
  ): Promise<CoordinatedMutationResult<Participant>>;
  updateParticipant(
    input: UpdateParticipantInput,
  ): Promise<CoordinatedMutationResult<Participant>>;
  getParticipant(
    namespace: string,
    id: string,
  ): Promise<Participant | null>;
  getParticipantByExternalId(
    namespace: string,
    externalId: string,
  ): Promise<Participant | null>;
  listParticipants(
    namespace: string,
    options?: ListParticipantsOptions,
  ): Promise<readonly Participant[]>;
  createThread(
    input: CreateThreadInput,
  ): Promise<CoordinatedMutationResult<ConversationThread>>;
  addThreadParticipant(
    input: AddThreadParticipantInput,
  ): Promise<CoordinatedMutationResult<ConversationThread>>;
  updateThread(
    input: UpdateThreadInput,
  ): Promise<CoordinatedMutationResult<ConversationThread>>;
  deleteThread(
    input: DeleteThreadInput,
  ): Promise<CoordinatedMutationResult<DeleteThreadResult>>;
  getThread(
    namespace: string,
    id: string,
  ): Promise<ConversationThread | null>;
  getThreadByExternalId(
    namespace: string,
    externalId: string,
  ): Promise<ConversationThread | null>;
  listThreads(
    namespace: string,
    options?: ListThreadsOptions,
  ): Promise<readonly ConversationThread[]>;
  createMessage(
    input: CreateMessageInput,
  ): Promise<CoordinatedMutationResult<ConversationMessage>>;
  reviseMessage(
    input: ReviseMessageInput,
  ): Promise<CoordinatedMutationResult<MessageRevisionResult>>;
  deleteThreadMessages(
    input: DeleteThreadMessagesInput,
  ): Promise<CoordinatedMutationResult<DeleteThreadMessagesResult>>;
  getMessage(
    namespace: string,
    id: string,
  ): Promise<ConversationMessage | null>;
  listMessages(
    namespace: string,
    threadId: string,
    options?: ListMessagesOptions,
  ): Promise<readonly ConversationMessage[]>;
  listMessageRevisions(
    namespace: string,
    rootMessageId: string,
  ): Promise<readonly ConversationMessage[]>;
}>;

export type CreateConversationRepositoryOptions = Readonly<{
  coordinator: EventCoordinator;
  /** Read-only query capability; domain writes still go through the coordinator. */
  session: SqlExecutor;
  /** Supplies the storage-owned table map without exposing raw graph methods. */
  eventStore: Pick<EventStore, "tables">;
  /** Transaction-aware canonical body persistence for aggregate mutations. */
  assets: Pick<
    DatabaseAssetRepository,
    "materialize" | "resolvePrepared" | "linkOwner"
  >;
  createId?: () => string;
}>;
