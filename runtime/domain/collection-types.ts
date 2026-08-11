import type { JsonSchema } from "../../dependencies/ominipg.ts";
import type { DatabaseAssetRepository } from "../content/index.ts";
import type {
  CoordinatedMutationResult,
  EventCoordinator,
  EventStore,
  SqlExecutor,
} from "../events/index.ts";
import type { MutationIdentity } from "./types.ts";
import type { PluginRegistry } from "../plugins/index.ts";
import type { CollectionDefinition } from "./definition.ts";

export type CollectionMutationOperation = "create" | "update" | "delete";

export type CollectionResourceDescriptor = Readonly<{
  name: string;
  schema: JsonSchema;
}>;

export type CollectionRecord = Readonly<
  Record<string, unknown> & {
    id: string;
    namespace: string;
    createdAt: string;
    updatedAt: string;
  }
>;

export type EventCollectionValue<TSelect extends object> = Readonly<
  TSelect & CollectionRecord
>;

export type CollectionMutationOptions = Readonly<{
  namespace: string;
  identity?: MutationIdentity;
}>;

export type CollectionListOptions = Readonly<{
  after?: string;
  limit?: number;
  /** Exact JSON-field containment filter evaluated inside the tenant scope. */
  where?: Readonly<Record<string, unknown>>;
}>;

export type ValidateCollectionRecord = (input: {
  definition: Readonly<{ name: string; schema: JsonSchema }>;
  operation: Exclude<CollectionMutationOperation, "delete">;
  record: Readonly<Record<string, unknown>>;
}) => void | Promise<void>;

export type EventCollectionRepository<
  S extends JsonSchema = JsonSchema,
  TSelect extends object = CollectionRecord,
  TInsert extends object = Record<string, unknown>,
> = Readonly<{
  definition: CollectionDefinition<S, TSelect, TInsert>;
  create(
    input: TInsert,
    options: CollectionMutationOptions,
  ): Promise<CoordinatedMutationResult<EventCollectionValue<TSelect>>>;
  update(
    id: string,
    patch: Partial<TInsert>,
    options: CollectionMutationOptions,
  ): Promise<CoordinatedMutationResult<EventCollectionValue<TSelect>>>;
  delete(
    id: string,
    options: CollectionMutationOptions,
  ): Promise<CoordinatedMutationResult<{ id: string; deleted: true }>>;
  get(
    namespace: string,
    id: string,
  ): Promise<EventCollectionValue<TSelect> | null>;
  list(
    namespace: string,
    options?: CollectionListOptions,
  ): Promise<readonly EventCollectionValue<TSelect>[]>;
}>;

export type CreateEventCollectionRepositoryOptions<
  S extends JsonSchema = JsonSchema,
  TSelect extends object = CollectionRecord,
  TInsert extends object = Record<string, unknown>,
> = Readonly<{
  definition: CollectionDefinition<S, TSelect, TInsert>;
  coordinator: EventCoordinator;
  session: SqlExecutor;
  eventStore: Pick<EventStore, "tables">;
  assets?: Pick<
    DatabaseAssetRepository,
    "materialize" | "resolvePrepared" | "linkOwner" | "syncOwner"
  >;
  validate?: ValidateCollectionRecord;
  createId?: () => string;
  now?: () => Date;
}>;

export type ScopedCollectionMutationOptions = Readonly<{
  operationKey?: string;
  identity?: MutationIdentity;
}>;

export type ScopedEventCollection = Readonly<{
  definition: CollectionResourceDescriptor;
  create(
    input: Record<string, unknown>,
    options?: ScopedCollectionMutationOptions,
  ): Promise<CollectionRecord>;
  update(
    id: string,
    patch: Record<string, unknown>,
    options?: ScopedCollectionMutationOptions,
  ): Promise<CollectionRecord>;
  delete(
    id: string,
    options?: ScopedCollectionMutationOptions,
  ): Promise<{ id: string; deleted: true }>;
  get(id: string): Promise<CollectionRecord | null>;
  list(options?: {
    after?: string;
    limit?: number;
    where?: Readonly<Record<string, unknown>>;
  }): Promise<readonly CollectionRecord[]>;
}>;

export type CollectionMutationIdentityFactory = (
  operationKey: string,
  metadata?: Record<string, unknown>,
) => MutationIdentity;

export type EventCollectionsScope = Readonly<{
  namespace: string;
  createMutationIdentity?: CollectionMutationIdentityFactory;
}>;

export type EventCollections = Readonly<{
  names: readonly string[];
  get(name: string): ErasedEventCollectionRepository;
  withScope(scope: EventCollectionsScope): Readonly<
    Record<string, ScopedEventCollection>
  >;
}>;

export type ErasedEventCollectionRepository = Readonly<{
  definition: CollectionResourceDescriptor;
  create(
    input: Record<string, unknown>,
    options: CollectionMutationOptions,
  ): Promise<CoordinatedMutationResult<CollectionRecord>>;
  update(
    id: string,
    patch: Record<string, unknown>,
    options: CollectionMutationOptions,
  ): Promise<CoordinatedMutationResult<CollectionRecord>>;
  delete(
    id: string,
    options: CollectionMutationOptions,
  ): Promise<CoordinatedMutationResult<{ id: string; deleted: true }>>;
  get(namespace: string, id: string): Promise<CollectionRecord | null>;
  list(
    namespace: string,
    options?: CollectionListOptions,
  ): Promise<readonly CollectionRecord[]>;
}>;

export type CreateEventCollectionsOptions = Readonly<{
  registry: PluginRegistry;
  coordinator: EventCoordinator;
  session: SqlExecutor;
  eventStore: Pick<EventStore, "tables">;
  assets?: Pick<
    DatabaseAssetRepository,
    "materialize" | "resolvePrepared" | "linkOwner" | "syncOwner"
  >;
  validate?: ValidateCollectionRecord;
  createId?: () => string;
  now?: () => Date;
}>;
