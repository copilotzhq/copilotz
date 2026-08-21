import type { AgentCapabilityResolver } from "../capabilities/index.ts";
import type { AttachmentOutput } from "../attachments/index.ts";
import type {
  CopilotzEngine,
  CreateCopilotzEngineOptions,
} from "../engine/index.ts";
import type {
  CopilotzPlugin,
  PluginContextContribution,
} from "../plugins/index.ts";
import type { CreateLongTermMemoryPluginOptions } from "../memory/index.ts";
import type {
  CreateBuiltInToolsPluginOptions,
  CreateFinanceToolsPluginOptions,
  CreateWebToolsPluginOptions,
} from "../tools/index.ts";
import type { CreateScheduledJobsPluginOptions } from "../schedules/index.ts";
import type { WorkflowToolCatalog } from "../tools/index.ts";
import type { CopilotzPersistenceOptions } from "./persistence.ts";
import type { BodyStorageOptions } from "../content/index.ts";
import type { EventVisibility } from "../events/index.ts";

export type CorePluginSetting<T> = false | Readonly<T>;

/** Built-in plugins included before application-declared plugins. */
export type CopilotzCorePluginOptions = Readonly<{
  tools?: CorePluginSetting<CreateBuiltInToolsPluginOptions>;
  webTools?: CorePluginSetting<CreateWebToolsPluginOptions>;
  finance?: CorePluginSetting<CreateFinanceToolsPluginOptions>;
  memory?: CorePluginSetting<CreateLongTermMemoryPluginOptions>;
  schedules?: CorePluginSetting<CreateScheduledJobsPluginOptions>;
}>;

export type CreateCopilotzApplicationOptions =
  & Readonly<{
    /** Default tenant namespace used when run/connect omit one. */
    namespace?: string;
    databaseSchema?: string;
    /** Disable every built-in plugin with false, or configure them individually. */
    core?: false | CopilotzCorePluginOptions;
    /** Static canonical plugins. Package root defaults this to `[corePlugin]`. */
    canonicalCore?: readonly CopilotzPlugin[];
    plugins?: readonly CopilotzPlugin[];
    context?: PluginContextContribution;
    /** Canonical static/generated tool catalog shared by execution and introspection. */
    toolCatalog?: WorkflowToolCatalog;
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
  | "core"
  | "plugins"
  | "toolCatalog"
  | "assets"
>;

export type CopilotzApplicationConfig = Readonly<{
  namespace?: string;
  databaseSchema: string;
  corePluginIds: readonly string[];
  declaredPluginIds: readonly string[];
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
  outputs: ReadableStream<AttachmentOutput>;
  done: Promise<void>;
  cancel(reason?: string): Promise<void>;
}>;

export type CopilotzApplicationObservation = ReadableStream<AttachmentOutput>;

export type CopilotzApplication =
  & Omit<
    CopilotzEngine,
    "connect" | "events" | "run" | "shutdown" | "execution"
  >
  & Readonly<{
    config: CopilotzApplicationConfig;
    capabilities: AgentCapabilityResolver;
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

export type CreateCopilotzCorePlugins = (
  options?: false | CopilotzCorePluginOptions,
  defaults?: Readonly<{ toolCatalog?: WorkflowToolCatalog }>,
) => readonly CopilotzPlugin[];
