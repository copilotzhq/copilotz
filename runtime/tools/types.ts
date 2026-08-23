import type { Agent, API, MCPServer, Skill, Tool } from "../resources/index.ts";
import type { ToolPipelineStage, ToolPipelineToolStage } from "../llm/types.ts";
import type { ScopedCollections } from "../collections/index.ts";
import type { CopilotzEvent } from "../events/types.ts";
import type { ContentInput } from "../content/index.ts";
import type { ProcessorContext } from "../plugins/index.ts";

/** Existing custom/native tool shape required by the event-native executor. */
export type WorkflowTool =
  & Omit<Tool, "execute">
  & Readonly<{
    execute(
      args: unknown,
      context?: WorkflowToolExecutionContext,
    ): unknown | Promise<unknown>;
  }>;

export function isWorkflowTool(value: unknown): value is WorkflowTool {
  const candidate = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return typeof candidate.key === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.execute === "function";
}

export type GenerateApiWorkflowTools = (
  apis: readonly API[],
) => readonly WorkflowTool[] | Promise<readonly WorkflowTool[]>;

export type GenerateMcpWorkflowTools = (
  servers: readonly MCPServer[],
) => readonly WorkflowTool[] | Promise<readonly WorkflowTool[]>;

export type CreateWorkflowToolCatalogOptions = Readonly<{
  generateApiTools?: GenerateApiWorkflowTools;
  generateMcpTools?: GenerateMcpWorkflowTools;
}>;

export type WorkflowToolCatalogContext = Readonly<{
  agents: Readonly<Record<string, Agent | undefined>>;
  skills: Readonly<Record<string, Skill | undefined>>;
  tools: Readonly<Record<string, Tool | undefined>>;
  apis: Readonly<Record<string, API | undefined>>;
  mcp: Readonly<Record<string, MCPServer | undefined>>;
}>;

export type WorkflowToolCatalog = Readonly<{
  all(context: WorkflowToolCatalogContext): Promise<readonly WorkflowTool[]>;
  forAgent(
    context: WorkflowToolCatalogContext,
    agent: Agent,
  ): Promise<readonly WorkflowTool[]>;
  get(
    context: WorkflowToolCatalogContext,
    key: string,
  ): Promise<WorkflowTool | undefined>;
  clear(): void;
}>;

export type WorkflowJqEvaluator = (
  input: unknown,
  filter: string,
) => unknown | Promise<unknown>;

export type WorkflowPipelineMetadata = Readonly<{
  id: string;
  stages: readonly ToolPipelineStage[];
  stageIndex: number;
  rootToolCallId: string;
  upstreamToolExecutionId?: string;
  appliedJqStageIndexes?: readonly number[];
}>;

export type WorkflowPipelineAdvance =
  | Readonly<{
    kind: "next_tool";
    stage: ToolPipelineToolStage;
    stageIndex: number;
    arguments: Readonly<Record<string, unknown>>;
    pipeline: WorkflowPipelineMetadata;
  }>
  | Readonly<{
    kind: "settled";
    output: unknown;
    projected?: boolean;
  }>
  | Readonly<{
    kind: "failed";
    stageIndex: number;
    message: string;
  }>;

/** Event-Body-safe input describing one Tool Action. */
export type ToolActionInput = Readonly<{
  id: string;
  namespace: string;
  threadId: string;
  messageId?: string;
  participantId?: string;
  initiatorParticipantId?: string;
  agentId?: string;
  toolCallId: string;
  tool: Readonly<Record<string, unknown>>;
  invocation?: Readonly<Record<string, unknown>>;
  availableToolIds?: readonly string[];
  historyVisibility?: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type WorkflowToolExecutionContext = {
  namespace: string;
  correlationId: string;
  idempotencyKey: string;
  execution: ToolActionInput;
  processor: WorkflowToolHostContext;
  threadId: string;
  toolExecutionId: string;
  toolCallId: string;
  senderId?: string;
  senderType?: "human" | "agent" | "tool" | "system" | "job";
  userExternalId?: string;
  agent?: Agent | null;
  agents: readonly Agent[];
  tools: readonly WorkflowTool[];
  collections: ScopedCollections;
  userMetadata?: Readonly<Record<string, unknown>>;
  threadMetadata?: Readonly<Record<string, unknown>>;
  resolveAsset?: (
    assetId: string,
  ) => Promise<{ bytes: Uint8Array; mime: string }>;
  emitOutput(
    delta: unknown,
    options?: WorkflowToolOutputOptions,
  ): Promise<void>;
  onCancel?: (callback: () => void) => () => void;
  cancelled: boolean;
  cancelReason?: string;
};

/** Runtime-neutral capabilities exposed to a Tool by its invoking Action. */
export type WorkflowToolHostContext = ProcessorContext;

export type WorkflowToolOutputOptions = Readonly<{
  channel?: string;
  mode?: "append" | "replace";
  mediaType?: string;
}>;

export type WorkflowToolResult = Readonly<{
  kind: "copilotz.workflow-tool.result.v1";
  output: unknown;
  attachments?: ContentInput | readonly ContentInput[];
}>;

export type DeferredWorkflowToolResult = Readonly<{
  kind: "copilotz.workflow-tool.deferred.v1";
  metadata: Readonly<Record<string, unknown>>;
}>;

export type DeferWorkflowToolOptions = Readonly<{
  metadata?: Record<string, unknown>;
}>;

/** Application policy applied before a text attempt records its tool grants. */
export type ResolveWorkflowAgentTools = (
  input: Readonly<{
    agent: Agent;
    tools: readonly WorkflowTool[];
    sourceEvent: CopilotzEvent;
    context: ProcessorContext;
  }>,
) => readonly WorkflowTool[] | Promise<readonly WorkflowTool[]>;
