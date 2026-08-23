import type {
  ActionCaller,
  ActionContext,
  ActionContextNamespaces,
} from "@copilotz/copilotz/actions";
import type { CopilotzProcessorContext } from "@copilotz/copilotz/engine";
import type { LlmResource } from "@copilotz/copilotz/llm";
import type {
  Agent,
  API,
  MCPServer,
  Skill,
  Tool,
} from "@copilotz/copilotz/resources";
import type { createThreadMessageAction } from "./resources/actions/thread-message.ts";
import type {
  generateLlmAction,
  runLlmSessionAction,
} from "./resources/actions/llm.ts";
import type { executeToolBatchAction } from "./resources/actions/tool.ts";

export type CoreResources =
  & ActionContextNamespaces
  & Readonly<{
    agents: Readonly<Record<string, Agent | undefined>>;
    tools: Readonly<Record<string, Tool | undefined>>;
    skills: Readonly<Record<string, Skill | undefined>>;
    apis: Readonly<Record<string, API | undefined>>;
    mcp: Readonly<Record<string, MCPServer | undefined>>;
  }>;

export type CoreAdapters =
  & ActionContextNamespaces
  & Readonly<{
    llm: Readonly<Record<string, LlmResource | undefined>>;
  }>;

export type CoreComposedContext = Readonly<{
  resources: CoreResources;
  adapters: CoreAdapters;
}>;

export type CoreWorkflowContext =
  & CopilotzProcessorContext
  & Readonly<{
    agents: CoreResources["agents"];
    tools: CoreResources["tools"];
    skills: CoreResources["skills"];
    apis: CoreResources["apis"];
    mcp: CoreResources["mcp"];
    llm: CoreAdapters["llm"];
    embeddings: ActionContextNamespaces[string];
    promptContext: ActionContextNamespaces[string];
    memoryKinds: ActionContextNamespaces[string];
  }>;

/** Runtime capabilities plus the composed namespaces used by Core semantics. */
export type CoreActionContext =
  & ActionContext
  & CopilotzProcessorContext
  & CoreComposedContext;

export type CoreProcessorContext =
  & Omit<CopilotzProcessorContext, "actions">
  & CoreComposedContext
  & Readonly<{
    actions: Readonly<{
      createThreadMessage: ActionCaller<typeof createThreadMessageAction>;
      generateLlm: ActionCaller<typeof generateLlmAction>;
      runLlmSession: ActionCaller<typeof runLlmSessionAction>;
      executeToolBatch: ActionCaller<typeof executeToolBatchAction>;
    }>;
  }>;

export function coreAgent(
  resources: CoreResources,
  id: string,
): Agent | undefined {
  const normalized = id.trim();
  if (!normalized) return undefined;
  return Object.values(resources.agents ?? {}).find((agent) =>
    agent?.id === normalized || agent?.externalId === normalized
  );
}

export function requireCoreAgent(resources: CoreResources, id: string): Agent {
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
    llm: context.adapters.llm ?? empty,
    embeddings: context.adapters.embedding ?? empty,
    promptContext: context.resources.promptContext ?? empty,
    memoryKinds: context.resources.memoryKinds ?? empty,
  }) as unknown as CoreWorkflowContext;
}
