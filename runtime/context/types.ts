import type { Agent } from "../resources/index.ts";
import type {
  ConversationMessage,
  ConversationThread,
  Participant,
} from "../domain/index.ts";
import type { ScopedCollections } from "../collections/index.ts";
import type { ContentInput, ContentRef } from "../content/index.ts";
import type { MemorySourceRef } from "../memory/ontology.ts";

export type ContextPurpose = "conversation" | "memory_consolidation";

export type ContextContributionInput = Readonly<{
  purpose: ContextPurpose;
  agent: Agent;
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
  source?: MemorySourceRef;
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
  source?: MemorySourceRef;
  capturedAt: string;
  /** Reserved for the built-in long-term-memory context resource. */
  historyAfterMessageId?: string;
}>;
