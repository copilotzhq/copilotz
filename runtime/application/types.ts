import type {
  ConnectAttachmentInput,
  EventNativeRunHandle,
  EventNativeRunInput,
  ThreadAttachment,
} from "../attachments/index.ts";
import type {
  CopilotzEngine,
  CreateCopilotzEngineOptions,
} from "../engine/index.ts";
import type { SqlSession } from "../events/index.ts";
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
import type { CreateBundledSkillsPluginOptions } from "../skills/index.ts";
import type { CreateUsageWorkflowPluginOptions } from "../usage/index.ts";
import type { CreateScheduledJobsPluginOptions } from "../schedules/index.ts";
import type { CreateKnowledgePluginOptions } from "../knowledge/index.ts";
import type { GoalHandle, GoalInput } from "../goals/index.ts";
import type {
  CreateAgentAskPluginOptions,
  CreateBuiltInLlmProvidersPluginOptions,
  CreateTextWorkflowPluginOptions,
} from "../workflows/index.ts";

export type CorePluginSetting<T> = false | Readonly<T>;

/** Built-in plugins included before application-declared plugins. */
export type CopilotzCorePluginOptions = Readonly<{
  providers?: CorePluginSetting<CreateBuiltInLlmProvidersPluginOptions>;
  tools?: CorePluginSetting<CreateBuiltInToolsPluginOptions>;
  webTools?: CorePluginSetting<CreateWebToolsPluginOptions>;
  finance?: CorePluginSetting<CreateFinanceToolsPluginOptions>;
  skills?: CorePluginSetting<CreateBundledSkillsPluginOptions>;
  memory?: CorePluginSetting<CreateLongTermMemoryPluginOptions>;
  usage?: CorePluginSetting<CreateUsageWorkflowPluginOptions>;
  text?: CorePluginSetting<CreateTextWorkflowPluginOptions>;
  ask?: CorePluginSetting<CreateAgentAskPluginOptions>;
  schedules?: CorePluginSetting<CreateScheduledJobsPluginOptions>;
  /** Opt-in because an embedding provider resource is required. */
  knowledge?: CorePluginSetting<CreateKnowledgePluginOptions>;
}>;

export type CreateCopilotzApplicationOptions = Readonly<{
  session: SqlSession;
  /** Default tenant namespace used when run/connect omit one. */
  namespace?: string;
  schema?: string;
  /** Disable every built-in plugin with false, or configure them individually. */
  core?: false | CopilotzCorePluginOptions;
  plugins?: readonly PluginSource[];
  resources?: PluginResources;
  pluginResolver?: PluginResolver;
  engine?: Omit<
    CreateCopilotzEngineOptions,
    "session" | "registry" | "schema"
  >;
  /**
   * Grants session ownership to this application. Injected sessions are left
   * open when this callback is omitted.
   */
  closeSession?: (reason?: string) => void | Promise<void>;
}>;

export type CopilotzApplicationConfig = Readonly<{
  namespace?: string;
  schema: string;
  corePluginIds: readonly string[];
  declaredPluginIds: readonly string[];
  sessionOwnership: "application" | "injected";
}>;

export type ApplicationConnectInput =
  & Omit<
    ConnectAttachmentInput,
    "namespace"
  >
  & Readonly<{ namespace?: string }>;

export type ApplicationRunInput =
  & Omit<EventNativeRunInput, "namespace">
  & Readonly<{ namespace?: string }>;

export type CopilotzApplication =
  & Omit<
    CopilotzEngine,
    "connect" | "run" | "shutdown"
  >
  & Readonly<{
    config: CopilotzApplicationConfig;
    /** Lower-level engine for adapters that need the complete explicit scope. */
    engine: CopilotzEngine;
    connect(input: ApplicationConnectInput): Promise<ThreadAttachment>;
    run(input: ApplicationRunInput): Promise<EventNativeRunHandle>;
    /** Runs a bounded target/simulator/judge conversation through normal runs. */
    goal(input: GoalInput): Promise<GoalHandle>;
    shutdown(reason?: string): Promise<void>;
  }>;

export type CreateCopilotzCorePlugins = (
  options?: false | CopilotzCorePluginOptions,
) => readonly CopilotzPlugin[];
