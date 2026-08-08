import type {
  ContentInput,
  ContentPreparer,
  ContentSequence,
  DatabaseAssetRepository,
  DurableContentInput,
} from "../content/index.ts";
import type { CollectionRecord, MutationIdentity } from "../domain/index.ts";
import type {
  CoordinatedMutationResult,
  EventCoordinator,
  EventStore,
  SqlExecutor,
} from "../events/index.ts";

export type KnowledgeDocumentStatus =
  | "pending"
  | "processing"
  | "indexed"
  | "duplicate"
  | "failed";

export type KnowledgeDocumentSourceType = "url" | "file" | "text" | "asset";

export type KnowledgeChunkingConfig = Readonly<{
  strategy?: "fixed" | "paragraph" | "sentence";
  chunkSize?: number;
  chunkOverlap?: number;
}>;

export type KnowledgeEmbeddingConfig = Readonly<{
  /** Stable plugin resource ID for an embedding provider. */
  provider: string;
  model?: string;
  dimensions?: number;
  batchSize?: number;
}>;

export type KnowledgeDocumentSourceInput =
  | Readonly<{
    kind: "content";
    content: ContentInput;
    sourceType?: Extract<
      KnowledgeDocumentSourceType,
      "text" | "file" | "asset"
    >;
    sourceUri?: string;
  }>
  | Readonly<{
    kind: "uri";
    uri: string;
    sourceType?: Extract<KnowledgeDocumentSourceType, "url" | "file">;
  }>;

export type KnowledgeDocument =
  & CollectionRecord
  & Readonly<{
    sourceType: KnowledgeDocumentSourceType;
    sourceUri: string | null;
    title: string;
    mediaType: string | null;
    contentHash: `sha256:${string}` | null;
    source: ContentSequence;
    status: KnowledgeDocumentStatus;
    chunkCount: number;
    duplicateOfDocumentId: string | null;
    threadId: string | null;
    requestedByParticipantId: string | null;
    forceReindex: boolean;
    error: Readonly<{ code: string; message: string }> | null;
    externalId: string | null;
    metadata: Readonly<Record<string, unknown>>;
  }>;

export type KnowledgeChunk =
  & CollectionRecord
  & Readonly<{
    documentId: string;
    chunkIndex: number;
    content: string;
    tokenCount: number;
    embedding: readonly number[];
    startPosition: number;
    endPosition: number;
    metadata: Readonly<Record<string, unknown>>;
  }>;

export type CreateKnowledgeDocumentInput = Readonly<{
  namespace: string;
  id?: string;
  title?: string;
  source: KnowledgeDocumentSourceInput;
  threadId?: string;
  requestedByParticipantId?: string;
  forceReindex?: boolean;
  externalId?: string;
  metadata?: Record<string, unknown>;
  identity?: MutationIdentity;
}>;

export type CompleteKnowledgeDocumentInput = Readonly<{
  namespace: string;
  id: string;
  title?: string;
  mediaType: string;
  contentHash: `sha256:${string}`;
  source: DurableContentInput;
  chunks: readonly Readonly<{
    content: string;
    embedding: readonly number[];
    chunkIndex: number;
    tokenCount: number;
    startPosition: number;
    endPosition: number;
    metadata?: Record<string, unknown>;
  }>[];
  identity?: MutationIdentity;
}>;

export type MarkKnowledgeDocumentDuplicateInput = Readonly<{
  namespace: string;
  id: string;
  duplicateOfDocumentId: string;
  source: DurableContentInput;
  mediaType: string;
  contentHash: `sha256:${string}`;
  identity?: MutationIdentity;
}>;

export type FailKnowledgeDocumentInput = Readonly<{
  namespace: string;
  id: string;
  error: Readonly<{ code: string; message: string }>;
  identity?: MutationIdentity;
}>;

export type KnowledgeSearchScope = Readonly<{
  threadId?: string;
  agentId?: string;
  knowledgeSpaceIds?: readonly string[];
  documentIds?: readonly string[];
}>;

export type KnowledgeSearchInput = Readonly<{
  namespace: string;
  embedding: readonly number[];
  scope?: KnowledgeSearchScope;
  limit?: number;
  threshold?: number;
}>;

export type KnowledgeSearchResult = Readonly<{
  chunk: KnowledgeChunk;
  document: KnowledgeDocument;
  similarity: number;
}>;

export type KnowledgeRepository = Readonly<{
  create(
    input: CreateKnowledgeDocumentInput,
  ): Promise<CoordinatedMutationResult<KnowledgeDocument>>;
  begin(
    namespace: string,
    id: string,
    identity?: MutationIdentity,
  ): Promise<CoordinatedMutationResult<KnowledgeDocument>>;
  complete(
    input: CompleteKnowledgeDocumentInput,
  ): Promise<CoordinatedMutationResult<KnowledgeDocument>>;
  markDuplicate(
    input: MarkKnowledgeDocumentDuplicateInput,
  ): Promise<CoordinatedMutationResult<KnowledgeDocument>>;
  fail(
    input: FailKnowledgeDocumentInput,
  ): Promise<CoordinatedMutationResult<KnowledgeDocument>>;
  delete(
    namespace: string,
    id: string,
    identity?: MutationIdentity,
  ): Promise<CoordinatedMutationResult<{ id: string; deleted: true }>>;
  get(namespace: string, id: string): Promise<KnowledgeDocument | null>;
  getByHash(
    namespace: string,
    contentHash: string,
  ): Promise<KnowledgeDocument | null>;
  getBySourceUri(
    namespace: string,
    sourceUri: string,
  ): Promise<KnowledgeDocument | null>;
  list(
    namespace: string,
    options?: Readonly<{
      status?: KnowledgeDocumentStatus;
      after?: string;
      limit?: number;
    }>,
  ): Promise<readonly KnowledgeDocument[]>;
  listChunks(
    namespace: string,
    documentId: string,
  ): Promise<readonly KnowledgeChunk[]>;
  search(
    input: KnowledgeSearchInput,
  ): Promise<readonly KnowledgeSearchResult[]>;
}>;

export type KnowledgeMutationOptions = Readonly<{
  operationKey?: string;
  metadata?: Record<string, unknown>;
}>;

export type ScopedKnowledge = Readonly<{
  create(
    input: Omit<CreateKnowledgeDocumentInput, "namespace" | "identity">,
    options?: KnowledgeMutationOptions,
  ): Promise<CoordinatedMutationResult<KnowledgeDocument>>;
  begin(
    id: string,
    options?: KnowledgeMutationOptions,
  ): Promise<CoordinatedMutationResult<KnowledgeDocument>>;
  complete(
    input: Omit<CompleteKnowledgeDocumentInput, "namespace" | "identity">,
    options?: KnowledgeMutationOptions,
  ): Promise<CoordinatedMutationResult<KnowledgeDocument>>;
  markDuplicate(
    input: Omit<MarkKnowledgeDocumentDuplicateInput, "namespace" | "identity">,
    options?: KnowledgeMutationOptions,
  ): Promise<CoordinatedMutationResult<KnowledgeDocument>>;
  fail(
    input: Omit<FailKnowledgeDocumentInput, "namespace" | "identity">,
    options?: KnowledgeMutationOptions,
  ): Promise<CoordinatedMutationResult<KnowledgeDocument>>;
  delete(
    id: string,
    options?: KnowledgeMutationOptions,
  ): Promise<CoordinatedMutationResult<{ id: string; deleted: true }>>;
  get(id: string): Promise<KnowledgeDocument | null>;
  getByHash(contentHash: string): Promise<KnowledgeDocument | null>;
  getBySourceUri(sourceUri: string): Promise<KnowledgeDocument | null>;
  list(
    options?: Readonly<{
      status?: KnowledgeDocumentStatus;
      after?: string;
      limit?: number;
    }>,
  ): Promise<readonly KnowledgeDocument[]>;
  listChunks(documentId: string): Promise<readonly KnowledgeChunk[]>;
  search(
    input: Omit<KnowledgeSearchInput, "namespace">,
  ): Promise<readonly KnowledgeSearchResult[]>;
}>;

export type KnowledgeEmbeddingRequest = Readonly<{
  texts: readonly string[];
  model?: string;
  dimensions?: number;
  signal: AbortSignal;
  idempotencyKey: string;
}>;

export type KnowledgeEmbeddingResponse = Readonly<{
  embeddings: readonly (readonly number[])[];
  model: string;
  dimensions: number;
  usage?: Readonly<{ promptTokens: number; totalTokens: number }>;
}>;

export type KnowledgeEmbeddingProviderResource = Readonly<{
  id: string;
  type: "embedding";
  embed(input: KnowledgeEmbeddingRequest): Promise<KnowledgeEmbeddingResponse>;
}>;

export type LoadedKnowledgeSource = Readonly<{
  bytes: Uint8Array;
  mediaType: string;
  sourceType: KnowledgeDocumentSourceType;
  sourceUri: string | null;
  title?: string;
}>;

export type KnowledgeSourceLoader = (
  input: Readonly<{
    document: KnowledgeDocument;
    signal: AbortSignal;
    idempotencyKey: string;
  }>,
) => Promise<LoadedKnowledgeSource>;

export type KnowledgeTextExtractor = (
  input: Readonly<{
    bytes: Uint8Array;
    mediaType: string;
    signal: AbortSignal;
  }>,
) => Promise<string>;

export type CreateKnowledgeRepositoryOptions = Readonly<{
  coordinator: EventCoordinator;
  session: SqlExecutor;
  eventStore: Pick<EventStore, "tables">;
  assets: Pick<
    DatabaseAssetRepository,
    "materialize" | "resolvePrepared" | "linkOwner" | "syncOwner"
  >;
  preparer: ContentPreparer;
  createId?: () => string;
  now?: () => Date;
}>;

export type CreateKnowledgePluginOptions = Readonly<{
  id?: string;
  version?: string;
  embedding: KnowledgeEmbeddingConfig;
  chunking?: KnowledgeChunkingConfig;
  sourceLoader?: KnowledgeSourceLoader;
  extractText?: KnowledgeTextExtractor;
  tools?:
    | false
    | Readonly<{
      ingestId?: string;
      searchId?: string;
      deleteId?: string;
    }>;
}>;
