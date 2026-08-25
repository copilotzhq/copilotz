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
  visibility?: EventVisibility;
}>;

export type ApplicationSendInput = CopilotzInputEnvelope;

export type ApplicationSendHandle = Readonly<{
  eventId: string;
  correlationId: string;
  outputs: ReadableStream<ApplicationOutput>;
  done: Promise<void>;
  cancel(reason?: string): Promise<void>;
}>;

export type CopilotzApplicationObservation = ReadableStream<ApplicationOutput>;

/** The complete runtime-neutral application surface exposed to callers. */
export type CopilotzApplication = Readonly<{
  send(input: ApplicationSendInput): Promise<ApplicationSendHandle>;
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
  }>;
