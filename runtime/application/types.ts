import type { AgentCapabilityResolver } from "../capabilities/index.ts";
import type {
  ConnectAttachmentInput,
  RunHandle,
  RunInput,
  ThreadAttachment,
} from "../attachments/index.ts";
import type {
  CopilotzEngine,
  CreateCopilotzEngineOptions,
} from "../engine/index.ts";
import type {
  CopilotzPlugin,
  PluginResolver,
  PluginResources,
  PluginSource,
} from "../plugins/index.ts";
import type { CreateLongTermMemoryPluginOptions } from "../memory/index.ts";
import type {
  CreateBuiltInToolsPluginOptions,
  CreateFinanceToolsPluginOptions,
  CreateWebToolsPluginOptions,
} from "../tools/index.ts";
import type { CreateUsageWorkflowPluginOptions } from "../usage/index.ts";
import type { CreateScheduledJobsPluginOptions } from "../schedules/index.ts";
import type { CreateKnowledgePluginOptions } from "../knowledge/index.ts";
import type { GoalHandle, GoalInput } from "../goals/index.ts";
import type {
  CreateAgentAskPluginOptions,
  CreateBuiltInLlmProvidersPluginOptions,
  CreateTextWorkflowPluginOptions,
  WorkflowToolCatalog,
} from "../workflows/index.ts";
import type { CopilotzPersistenceOptions } from "./persistence.ts";
import type { AssetStorageOptions } from "../content/index.ts";

export type CorePluginSetting<T> = false | Readonly<T>;

/** Built-in plugins included before application-declared plugins. */
export type CopilotzCorePluginOptions = Readonly<{
  providers?: CorePluginSetting<CreateBuiltInLlmProvidersPluginOptions>;
  tools?: CorePluginSetting<CreateBuiltInToolsPluginOptions>;
  webTools?: CorePluginSetting<CreateWebToolsPluginOptions>;
  finance?: CorePluginSetting<CreateFinanceToolsPluginOptions>;
  memory?: CorePluginSetting<CreateLongTermMemoryPluginOptions>;
  usage?: CorePluginSetting<CreateUsageWorkflowPluginOptions>;
  text?: CorePluginSetting<CreateTextWorkflowPluginOptions>;
  ask?: CorePluginSetting<CreateAgentAskPluginOptions>;
  schedules?: CorePluginSetting<CreateScheduledJobsPluginOptions>;
  /** Opt-in because an embedding provider resource is required. */
  knowledge?: CorePluginSetting<CreateKnowledgePluginOptions>;
}>;

export type CreateCopilotzApplicationOptions =
  & Readonly<{
    /** Default tenant namespace used when run/connect omit one. */
    namespace?: string;
    databaseSchema?: string;
    /** Disable every built-in plugin with false, or configure them individually. */
    core?: false | CopilotzCorePluginOptions;
    plugins?: readonly PluginSource[];
    resources?: PluginResources;
    pluginResolver?: PluginResolver;
    /** Canonical static/generated tool catalog shared by execution and introspection. */
    toolCatalog?: WorkflowToolCatalog;
    /** Canonical asset body policy shared by every database scope. */
    assets?: AssetStorageOptions;
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
  | "resources"
  | "pluginResolver"
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

export type ApplicationConnectInput =
  & Omit<
    ConnectAttachmentInput,
    "namespace"
  >
  & Readonly<{ namespace?: string }>;

export type ApplicationRunInput =
  & Omit<RunInput, "namespace">
  & Readonly<{ namespace?: string }>;

export type CopilotzApplication =
  & Omit<
    CopilotzEngine,
    "connect" | "run" | "shutdown" | "execution"
  >
  & Readonly<{
    config: CopilotzApplicationConfig;
    capabilities: AgentCapabilityResolver;
    connect(input: ApplicationConnectInput): Promise<ThreadAttachment>;
    run(input: ApplicationRunInput): Promise<RunHandle>;
    /** Runs a bounded target/simulator/judge conversation through normal runs. */
    goal(input: GoalInput): Promise<GoalHandle>;
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
