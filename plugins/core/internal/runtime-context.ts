import type {
  ActionCaller,
  ActionContext,
  RuntimeActionCallers,
  RuntimeContextNamespaces,
} from "@copilotz/copilotz/actions";
import type { ProcessorContext } from "@copilotz/copilotz/plugins";
import type {
  callLlmAction,
  LlmAdapter,
  ModelResource,
} from "@copilotz/copilotz/llm";
/** Defines the composed runtime contexts used by Core primitives. @module */

import type { AgentResource } from "../resources/agent/index.ts";
import type { PromptInstructionResource } from "../resources/prompt-instructions/index.ts";
import type { ToolResource } from "@copilotz/copilotz/tools";
import type { Skill } from "@copilotz/copilotz/skills";
import type { createThreadMessageAction } from "../../core-collections/actions/create-thread-message/index.ts";

export type CoreResources =
  & RuntimeContextNamespaces
  & Readonly<{
    agents: Readonly<Record<string, AgentResource | undefined>>;
    tools: Readonly<Record<string, ToolResource | undefined>>;
    skills: Readonly<Record<string, Skill | undefined>>;
    models: Readonly<Record<string, ModelResource | undefined>>;
    promptInstructions: Readonly<
      Record<string, PromptInstructionResource | undefined>
    >;
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
}>;

/** Runtime capabilities plus the composed namespaces used by Core semantics. */
export type CoreActionContext = ActionContext<
  CoreResources,
  CoreAdapters,
  CoreActionCallers
>;

export type CoreProcessorContext = ProcessorContext<
  CoreResources,
  CoreAdapters,
  CoreActionCallers
>;

/** Core orchestration context for dynamically selected Tool Action aliases. */
export type CoreToolProcessorContext = ProcessorContext<
  CoreResources,
  CoreAdapters,
  RuntimeActionCallers
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
