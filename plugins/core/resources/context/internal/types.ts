/** Defines Context Resource and contribution contracts. @module */

import type { AgentResource } from "../../agent/index.ts";
import type {
  ConversationMessage,
  ConversationThread,
  Participant,
} from "../../../../core-collections/internal/contracts.ts";
import type { ScopedCollections } from "@copilotz/copilotz/collections";
import type { ContentInput, ContentRef } from "@copilotz/copilotz/content";

export type ContextPurpose = "conversation" | "memory_consolidation";

export type ContextSourceRef =
  | Readonly<{ type: "message"; id: string }>
  | Readonly<{ type: "asset"; id: string }>
  | Readonly<{ type: "external"; id: string }>
  | Readonly<{
    type: "collection_record";
    collection: string;
    id: string;
    version?: string | number;
    updatedAt?: string;
    fragment?: string;
  }>;

export type ContextContributionInput = Readonly<{
  purpose: ContextPurpose;
  agent: AgentResource;
  participant: Participant;
  thread: ConversationThread;
  sourceRange?: Readonly<{
    startMessageId: string;
    endMessageId: string;
    messages: readonly ConversationMessage[];
  }>;
  collections: ScopedCollections;
  signal: AbortSignal;
  idempotencyKey: string;
}>;

export type ContextContribution = Readonly<{
  id: string;
  title: string;
  role: "context" | "evidence";
  content: ContentInput | ContentRef;
  source?: ContextSourceRef;
  capturedAt?: string;
}>;

export type ContextResource = Readonly<{
  id: string;
  type: "context";
  purposes: readonly ContextPurpose[];
  contribute(
    input: ContextContributionInput,
  ):
    | ContextContribution
    | readonly ContextContribution[]
    | null
    | Promise<ContextContribution | readonly ContextContribution[] | null>;
}>;

export type FrozenContextContribution = Readonly<{
  id: string;
  resourceId: string;
  title: string;
  role: "context" | "evidence";
  content: readonly ContentRef[];
  source?: ContextSourceRef;
  capturedAt: string;
  /** Reserved for the built-in long-term-memory context resource. */
  historyAfterMessageId?: string;
}>;
