import type {
  CopilotzEngine,
  CreateCopilotzEngineOptions,
} from "../engine/index.ts";
import type { CopilotzEvent } from "../events/index.ts";
import type {
  AnyCopilotzPlugin,
  PluginAdapters,
  PluginResources,
} from "../plugins/index.ts";
import type { CopilotzPersistenceOptions } from "./persistence.ts";
import type { BodyStorageOptions } from "../content/index.ts";
import type { EventVisibility } from "../events/index.ts";

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
  outputs: ReadableStream<CopilotzEvent>;
  done: Promise<void>;
  cancel(reason?: string): Promise<void>;
}>;

export type CopilotzApplicationObservation = ReadableStream<CopilotzEvent>;

export type CopilotzApplication =
  & Omit<
    CopilotzEngine,
    "connect" | "events" | "run" | "shutdown" | "execution"
  >
  & Readonly<{
    config: CopilotzApplicationConfig;
    events: CopilotzEngine["events"];
    send(input: ApplicationSendInput): Promise<ApplicationSendHandle>;
    observe(): CopilotzApplicationObservation;
    close(reason?: string): Promise<void>;
    shutdown(reason?: string): Promise<void>;
  }>;

/** Internal composition result used only while assembling runtime roles. */
export type InternalCopilotzApplication =
  & CopilotzApplication
  & Pick<CopilotzEngine, "execution">
  & Readonly<{ engine: CopilotzEngine }>;
