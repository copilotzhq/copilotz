import type {
  ActionContext,
  BoundActionCaller,
  RuntimeActionCallers,
  RuntimeContextNamespaces,
} from "@copilotz/copilotz/actions";
import type { ProcessorContext } from "@copilotz/copilotz/plugins";
import type {
  callLlmAction,
  LlmAdapter,
  LlmConnectionResource,
} from "@copilotz/copilotz/llm";
/** Defines the composed runtime contexts used by Core primitives. @module */

import type { AgentResource } from "../authoring/define-agent/index.ts";
import type { PromptInstructionResource } from "../authoring/define-prompt-instructions/index.ts";
import type { ToolResource } from "@copilotz/copilotz/core";
import type { createThreadMessageAction } from "../actions/create-thread-message/index.ts";
import type { compactContextAction } from "../actions/compact-context/index.ts";
import type {
  AgentCapabilitiesResource,
} from "../resources/capabilities/default/types.ts";
import type { SkillCapabilityResource } from "./capabilities/grants.ts";

export type CoreResources =
  & RuntimeContextNamespaces
  & Readonly<{
    agents: Readonly<Record<string, AgentResource | undefined>>;
    tools: Readonly<Record<string, ToolResource | undefined>>;
    skills: Readonly<Record<string, SkillCapabilityResource | undefined>>;
    capabilities: Readonly<
      Record<string, AgentCapabilitiesResource | undefined>
    >;
    llmConnections: Readonly<Record<string, LlmConnectionResource | undefined>>;
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
  createThreadMessage: BoundActionCaller<typeof createThreadMessageAction>;
  callLlm: BoundActionCaller<typeof callLlmAction>;
  compactContext: BoundActionCaller<typeof compactContextAction>;
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
