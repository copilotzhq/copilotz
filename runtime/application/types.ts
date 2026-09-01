import type {
  CopilotzEngine,
  CreateCopilotzEngineOptions,
} from "../engine/index.ts";
import type {
  AnyCopilotzPlugin,
  PluginAdapters,
  PluginResources,
} from "../plugins/index.ts";
import type { CopilotzPersistenceOptions } from "@copilotz/copilotz/persistence";
import type { BodyStorageOptions } from "../content/index.ts";
import type { EventVisibility } from "../events/index.ts";
import type { ApplicationOutput } from "../streams/index.ts";
import type { ActionSchema } from "../actions/index.ts";
import type { CopilotzEngineMaintenanceResult } from "../engine/index.ts";
import type { OperationState } from "../streams/catalog.ts";

export type { ApplicationOutput } from "../streams/index.ts";

export type CreateCopilotzApplicationOptions =
  & Readonly<{
    /** Default tenant namespace used when run/connect omit one. */
    namespace?: string;
    databaseSchema?: string;
    plugins?: readonly AnyCopilotzPlugin[];
    resources?: PluginResources;
    adapters?: PluginAdapters;
    /** Canonical asset body policy shared by every database scope. */
    assets?: BodyStorageOptions;
    engine?: Omit<
      CreateCopilotzEngineOptions,
      | "session"
      | "registry"
      | "defaultDatabaseSchema"
      | "assets"
      | "assetStorage"
      | "publishLocalStream"
    >;
  }>
  & CopilotzPersistenceOptions;

/** Plain application semantics that can be shared by Gateway and Worker roles. */
export type CopilotzComposition = Pick<
  CreateCopilotzApplicationOptions,
  "plugins" | "resources" | "adapters" | "assets"
>;

export type CopilotzApplicationConfig = Readonly<{
  namespace?: string;
  databaseSchema: string;
  pluginIds: readonly string[];
  databaseOwnership: "application" | "injected";
}>;

export type CopilotzInputEnvelope<
  TType extends string = string,
  TPayload = unknown,
> = Readonly<{
  type: TType;
  payload?: TPayload;
  namespace?: string;
  databaseSchema?: string;
  correlationId?: string;
  causationId?: string;
  deduplicationId?: string;
  metadata?: Record<string, unknown>;
  /** Trusted opaque ownership/routing claims for host-side operation policy. */
  operationMetadata?: Record<string, unknown>;
  visibility?: EventVisibility;
}>;

export type ApplicationSendInput = CopilotzInputEnvelope;

export type ApplicationSendHandle = Readonly<{
  operationId: string;
  eventId: string;
  correlationId: string;
  replayCursor: string;
  outputs: ReadableStream<ApplicationOutput>;
  done: Promise<void>;
  /** Stops only this local observer and settlement waiter. */
  detach(reason?: string): Promise<void>;
  /** Explicit durable cancellation retained for direct application callers. */
  cancel(reason?: string): Promise<void>;
}>;

export type ApplicationOperationScope = Readonly<{
  operationId: string;
  namespace?: string;
  databaseSchema?: string;
}>;

export type ApplicationOperationStatus = Readonly<{
  operationId: string;
  namespace: string;
  correlationId: string;
  state: OperationState;
  metadata: Readonly<Record<string, unknown>>;
  acceptedAt: string;
  updatedAt: string;
  completedAt?: string;
}>;

export type ApplicationOperationAttachment = Readonly<{
  operationId: string;
  replayCursor: string;
  outputs: ReadableStream<ApplicationOutput>;
  done: Promise<void>;
  /** Stops this attachment without changing durable operation state. */
  detach(reason?: string): Promise<void>;
}>;

export type ApplicationOperationAttachInput =
  & ApplicationOperationScope
  & Readonly<{ cursor?: string }>;

export type ApplicationOperationListInput = Readonly<{
  namespace?: string;
  databaseSchema?: string;
  operationIds?: readonly string[];
  states?: readonly OperationState[];
  metadata?: Readonly<Record<string, unknown>>;
  limit?: number;
}>;

/** Builds a history-snapshot cursor that skips already sealed stream lanes. */
export type ApplicationOperationCheckpointInput = Readonly<{
  namespace?: string;
  databaseSchema?: string;
  operationIds: readonly string[];
  /** Opaque cursor carrying the Event baseline established by the snapshot. */
  cursor?: string;
}>;

export type ApplicationMaintenanceOptions = Readonly<{
  namespace?: string;
  databaseSchema?: string;
  consumerIds?: readonly string[];
  limit?: number;
  retentionMs?: number | null;
  now?: Date;
  assetOrphanAfterMs?: number;
  operationObservationLimit?: number;
  /** Terminal operation replay grace; null retains operation metadata. */
  operationRetentionMs?: number | null;
}>;

export type CopilotzApplicationObservation = ReadableStream<ApplicationOutput>;

/** The complete runtime-neutral application surface exposed to callers. */
export type CopilotzApplication = Readonly<{
  send(input: ApplicationSendInput): Promise<ApplicationSendHandle>;
  attach(
    input: ApplicationOperationAttachInput,
  ): Promise<ApplicationOperationAttachment>;
  operationStatus(
    input: ApplicationOperationScope,
  ): Promise<ApplicationOperationStatus | null>;
  listOperations(
    input?: ApplicationOperationListInput,
  ): Promise<readonly ApplicationOperationStatus[]>;
  operationCheckpoint(
    input: ApplicationOperationCheckpointInput,
  ): Promise<string>;
  cancelOperation(
    input: ApplicationOperationScope & Readonly<{ reason?: string }>,
  ): Promise<ApplicationOperationStatus | null>;
  maintenance(
    options?: ApplicationMaintenanceOptions,
  ): Promise<CopilotzEngineMaintenanceResult>;
  observe(): CopilotzApplicationObservation;
  close(reason?: string): Promise<void>;
}>;

/** Internal composition result used only while assembling runtime roles. */
export type InternalCopilotzApplication =
  & CopilotzApplication
  & Omit<CopilotzEngine, "connect" | "run">
  & Readonly<{
    config: CopilotzApplicationConfig;
    engine: CopilotzEngine;
    /** Package-owned bridge ingress; never exposed on CopilotzApplication. */
    sendProtected(
      input: ApplicationSendInput,
      schema: ActionSchema,
      ownerId: string,
    ): Promise<ApplicationSendHandle>;
    /** Internal-only transport interruption used by persistence recovery. */
    interruptActiveSends(error: unknown): void;
    /** Gives the Gateway ownership of durable lease recovery for this runtime. */
    startRecovery(): Promise<void>;
  }>;
