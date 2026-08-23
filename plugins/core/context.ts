import type {
  ActionCaller,
  ActionContext,
  RuntimeContextNamespaces,
} from "@copilotz/copilotz/actions";
import type { ProcessorContext } from "@copilotz/copilotz/plugins";
import type {
  callLlmAction,
  LlmAdapter,
  ModelResource,
} from "@copilotz/copilotz/llm";
import type { AgentResource } from "./agent.ts";
import type { API, MCPServer, Tool } from "@copilotz/copilotz/tools";
import type { Skill } from "@copilotz/copilotz/skills";
import type { createThreadMessageAction } from "./resources/actions/thread-message.ts";
import type { executeToolBatchAction } from "./resources/actions/tool.ts";

export type CoreResources =
  & RuntimeContextNamespaces
  & Readonly<{
    agents: Readonly<Record<string, AgentResource | undefined>>;
    tools: Readonly<Record<string, Tool | undefined>>;
    skills: Readonly<Record<string, Skill | undefined>>;
    apis: Readonly<Record<string, API | undefined>>;
    mcp: Readonly<Record<string, MCPServer | undefined>>;
    models: Readonly<Record<string, ModelResource | undefined>>;
  }>;

export type CoreAdapters =
  & RuntimeContextNamespaces
  & Readonly<{
    llm: Readonly<Record<string, LlmAdapter | undefined>>;
  }>;

export type CoreComposedContext = Readonly<{
  resources: CoreResources;
  adapters: CoreAdapters;
}>;

export type CoreActionCallers = Readonly<{
  createThreadMessage: ActionCaller<typeof createThreadMessageAction>;
  callLlm: ActionCaller<typeof callLlmAction>;
  executeToolBatch: ActionCaller<typeof executeToolBatchAction>;
}>;

export type CoreWorkflowContext =
  & ProcessorContext<CoreResources, CoreAdapters, CoreActionCallers>
  & Readonly<{
    agents: CoreResources["agents"];
    tools: CoreResources["tools"];
    skills: CoreResources["skills"];
    apis: CoreResources["apis"];
    mcp: CoreResources["mcp"];
  }>;

/** Runtime capabilities plus the composed namespaces used by Core semantics. */
export type CoreActionContext = ActionContext<CoreResources, CoreAdapters>;

export type CoreProcessorContext = ProcessorContext<
  CoreResources,
  CoreAdapters,
  CoreActionCallers
>;

export function coreAgent(
  resources: CoreResources,
  id: string,
): AgentResource | undefined {
  const normalized = id.trim();
  if (!normalized) return undefined;
  return Object.values(resources.agents ?? {}).find((agent) =>
    agent?.id === normalized
  );
}

export function requireCoreAgent(
  resources: CoreResources,
  id: string,
): AgentResource {
  const agent = coreAgent(resources, id);
  if (!agent) throw new Error(`Unknown agent resource '${id}'.`);
  return agent;
}

/** Projects composed namespaces into Core's workflow helper context. */
export function coreWorkflowContext(
  context: CoreActionContext | CoreProcessorContext,
): CoreWorkflowContext {
  const empty = Object.freeze({});
  return Object.freeze({
    ...context,
    agents: context.resources.agents ?? empty,
    tools: context.resources.tools ?? empty,
    skills: context.resources.skills ?? empty,
    apis: context.resources.apis ?? empty,
    mcp: context.resources.mcp ?? empty,
  }) as unknown as CoreWorkflowContext;
}
