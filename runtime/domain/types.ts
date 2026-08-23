import type { ContentSequence } from "../content/index.ts";

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
  /** Runtime-owned completion scope propagated across durable descendants. */
  settlementScopeId?: string;
  metadata?: Record<string, unknown>;
}>;
