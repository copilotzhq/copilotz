import type { ChannelEntry } from "@/server/channels.ts";
import type { Skill } from "@/runtime/loaders/skill-types.ts";
import { parseSkillMarkdown } from "@/runtime/loaders/skill-parser.ts";
import type {
  EventProcessor,
  MemoryResource,
  ProcessorDeps,
} from "@/types/index.ts";
import {
  coerceProcessorProcess,
  coerceProcessorShouldProcess,
} from "@/runtime/processors/coerce.ts";
import type { ProviderFactory } from "@/runtime/llm/types.ts";
import type { Resources } from "@/runtime/loaders/resources.ts";
import type { AgentConfig, CollectionDefinition, ToolConfig } from "@/index.ts";

// ---- Bundled agents (static imports for deno compile) ----------------------
import copilotzAgentConfig from "@/resources/agents/copilotz/config.ts";
import copilotzAgentInstructions from "@/resources/agents/copilotz/instructions.ts";
import eastAgentConfig from "@/resources/agents/east/config.ts";
import eastAgentInstructions from "@/resources/agents/east/instructions.ts";
import northAgentConfig from "@/resources/agents/north/config.ts";
import northAgentInstructions from "@/resources/agents/north/instructions.ts";
import southAgentConfig from "@/resources/agents/south/config.ts";
import southAgentInstructions from "@/resources/agents/south/instructions.ts";
import westAgentConfig from "@/resources/agents/west/config.ts";
import westAgentInstructions from "@/resources/agents/west/instructions.ts";

// ---- Core: channels.web ----------------------------------------------------
import webIngressAdapter from "@/resources/channels/web/ingress.ts";
import webEgressAdapter from "@/resources/channels/web/egress.ts";

// ---- Core: collections -----------------------------------------------------
import participantCollection from "@/resources/collections/participant.ts";
import threadCollection from "@/resources/collections/thread.ts";
import messageCollection from "@/resources/collections/message.ts";
import assetCollection from "@/resources/collections/asset.ts";
import llmAttemptCollection from "@/resources/collections/llm_attempt.ts";
import toolExecutionCollection from "@/resources/collections/tool_execution.ts";
import llmUsageCollection from "@/resources/collections/llm_usage.ts";
import usageCollection from "@/resources/collections/usage.ts";
import scheduledJobCollection from "@/resources/collections/scheduled_job.ts";
import memorySpaceCollection from "@/resources/collections/memory_space.ts";
import brainNodeCollection from "@/resources/collections/brain_node.ts";
import longTermMemoryCollection from "@/resources/collections/long_term_memory.ts";

// ---- Core: memory ----------------------------------------------------------
import participantMemory from "@/resources/memory/participant.ts";
import historyMemory from "@/resources/memory/history.ts";
import longTermMemory from "@/resources/memory/long_term.ts";

// ---- Core: tools -----------------------------------------------------------
import { nativeTools } from "@/resources/tools/_registry.ts";

// ---- Core: processors ------------------------------------------------------
import * as messageRouterMessageCreatedProcessor from "@/resources/processors/message_router/message.created.ts";
import * as llmCallLlmAttemptCreatedProcessor from "@/resources/processors/llm_call/llm_attempt.created.ts";
import * as llmResultLlmAttemptCompletedProcessor from "@/resources/processors/llm_result/llm_attempt.completed.ts";
import * as llmResultLlmAttemptFailedProcessor from "@/resources/processors/llm_result/llm_attempt.failed.ts";
import * as toolCallToolExecutionCreatedProcessor from "@/resources/processors/tool_call/tool_execution.created.ts";
import * as toolResultToolExecutionCompletedProcessor from "@/resources/processors/tool_result/tool_execution.completed.ts";
import * as toolResultToolExecutionFailedProcessor from "@/resources/processors/tool_result/tool_execution.failed.ts";
import * as ragIngestRagIngestionCreatedProcessor from "@/resources/processors/rag_ingest/rag_ingestion.created.ts";
import * as entityExtractionCreatedProcessor from "@/resources/processors/entity_extract/entity_extraction.created.ts";
import * as longTermMemoryTriggerMessageCreatedProcessor from "@/resources/processors/memory_reservation/message.created.ts";
import * as longTermMemoryConsolidationCreatedProcessor from "@/resources/processors/memory_consolidation/long_term_memory.created.ts";

// ---- Core: llm providers + storage adapters --------------------------------
import * as llmProviders from "@/resources/llm/mod.ts";
import * as storageAdapters from "@/resources/storage/mod.ts";

// ---- Core: skills (generated JS modules; stable imports) -------------------
import addApiIntegrationSkillDataUrl from "@/resources/skills/add-api-integration/SKILL.js";
import addProcessorSkillDataUrl from "@/resources/skills/add-processor/SKILL.js";
import advancedChatFeaturesSkillDataUrl from "@/resources/skills/advanced-chat-features/SKILL.js";
import buildCopilotzSystemSkillDataUrl from "@/resources/skills/build-copilotz-system/SKILL.js";
import configureChatUiSkillDataUrl from "@/resources/skills/configure-chat-ui/SKILL.js";
import configureMcpSkillDataUrl from "@/resources/skills/configure-mcp/SKILL.js";
import configureRagSkillDataUrl from "@/resources/skills/configure-rag/SKILL.js";
import createAgentSkillDataUrl from "@/resources/skills/create-agent/SKILL.js";
import createChannelSkillDataUrl from "@/resources/skills/create-channel/SKILL.js";
import createEmbeddingProviderSkillDataUrl from "@/resources/skills/create-embedding-provider/SKILL.js";
import createFeatureSkillDataUrl from "@/resources/skills/create-feature/SKILL.js";
import createLlmProviderSkillDataUrl from "@/resources/skills/create-llm-provider/SKILL.js";
import createMemorySkillDataUrl from "@/resources/skills/create-memory/SKILL.js";
import createStorageAdapterSkillDataUrl from "@/resources/skills/create-storage-adapter/SKILL.js";
import createToolSkillDataUrl from "@/resources/skills/create-tool/SKILL.js";
import debugRuntimeIssueSkillDataUrl from "@/resources/skills/debug-runtime-issue/SKILL.js";
import exploreCodebaseSkillDataUrl from "@/resources/skills/explore-codebase/SKILL.js";
import implementFeatureSkillDataUrl from "@/resources/skills/implement-feature/SKILL.js";
import integrateExternalServiceSkillDataUrl from "@/resources/skills/integrate-external-service/SKILL.js";
import multiAgentSetupSkillDataUrl from "@/resources/skills/multi-agent-setup/SKILL.js";
import refactorResourceArchitectureSkillDataUrl from "@/resources/skills/refactor-resource-architecture/SKILL.js";
import reviewCopilotzProjectSkillDataUrl from "@/resources/skills/review-copilotz-project/SKILL.js";
import shipChatExperienceSkillDataUrl from "@/resources/skills/ship-chat-experience/SKILL.js";
import setupCollectionSkillDataUrl from "@/resources/skills/setup-collection/SKILL.js";

function decodeBase64DataUrl(dataUrl: string): string {
  const idx = dataUrl.indexOf(",");
  const b64 = idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
  return atob(b64);
}

function parseBundledSkill(dirName: string, raw: string): Skill {
  const { frontmatter, body } = parseSkillMarkdown(raw);
  return {
    name: typeof frontmatter.name === "string" ? frontmatter.name : dirName,
    description: typeof frontmatter.description === "string"
      ? frontmatter.description
      : "",
    content: body,
    allowedTools: Array.isArray(frontmatter["allowed-tools"])
      ? (frontmatter["allowed-tools"] as unknown[]).filter((t): t is string =>
        typeof t === "string"
      )
      : undefined,
    tags: Array.isArray(frontmatter.tags)
      ? (frontmatter.tags as unknown[]).filter((t): t is string =>
        typeof t === "string"
      )
      : undefined,
    source: "bundled",
    sourcePath: dirName,
    hasReferences: false,
  };
}

type ProcessorEntry = EventProcessor<unknown, ProcessorDeps> & {
  eventType: string;
  priority?: number;
  id?: string;
};

type ProcessorModule = Record<string, unknown> & {
  eventTypes?: readonly string[];
  eventType?: string;
  processorId?: string;
  id?: string;
};

function toProcessorEntry(
  eventType: string,
  mod: ProcessorModule,
): ProcessorEntry {
  const maybeShouldProcess = mod.shouldProcess;
  const maybeProcess = mod.process || mod.default;
  if (
    typeof maybeShouldProcess !== "function" ||
    typeof maybeProcess !== "function"
  ) {
    throw new Error(`Invalid processor module for ${eventType}`);
  }
  return {
    shouldProcess: coerceProcessorShouldProcess(
      maybeShouldProcess as (
        event: unknown,
        deps?: unknown,
      ) => boolean | Promise<boolean>,
    ),
    process: coerceProcessorProcess(
      maybeProcess as (
        event: unknown,
        deps?: unknown,
      ) => unknown | Promise<unknown>,
    ),
    eventType: eventType.includes(".") ? eventType : eventType.toUpperCase(),
    priority: typeof mod.priority === "number" ? mod.priority : 0,
    id: typeof mod.processorId === "string"
      ? mod.processorId
      : typeof mod.id === "string"
      ? mod.id
      : undefined,
  };
}

function toProcessorEntries(mod: ProcessorModule): ProcessorEntry[] {
  const eventTypes = Array.isArray(mod.eventTypes) && mod.eventTypes.length > 0
    ? mod.eventTypes
    : typeof mod.eventType === "string"
    ? [mod.eventType]
    : [];
  return eventTypes.map((eventType) => toProcessorEntry(eventType, mod));
}

const coreTools = [
  "list_skills",
  "load_skill",
  "read_skill_resource",
  "read_tool_result",
  "web_search",
  "fetch_text",
  "http_request",
  "persistent_terminal",
  "update_my_memory",
  "update_user_memory",
  "scheduled_jobs",
] as const;

const coreSkills: Skill[] = [
  parseBundledSkill(
    "add-api-integration",
    decodeBase64DataUrl(addApiIntegrationSkillDataUrl),
  ),
  parseBundledSkill(
    "add-processor",
    decodeBase64DataUrl(addProcessorSkillDataUrl),
  ),
  parseBundledSkill(
    "advanced-chat-features",
    decodeBase64DataUrl(advancedChatFeaturesSkillDataUrl),
  ),
  parseBundledSkill(
    "build-copilotz-system",
    decodeBase64DataUrl(buildCopilotzSystemSkillDataUrl),
  ),
  parseBundledSkill(
    "configure-chat-ui",
    decodeBase64DataUrl(configureChatUiSkillDataUrl),
  ),
  parseBundledSkill(
    "configure-mcp",
    decodeBase64DataUrl(configureMcpSkillDataUrl),
  ),
  parseBundledSkill(
    "configure-rag",
    decodeBase64DataUrl(configureRagSkillDataUrl),
  ),
  parseBundledSkill(
    "create-channel",
    decodeBase64DataUrl(createChannelSkillDataUrl),
  ),
  parseBundledSkill(
    "create-embedding-provider",
    decodeBase64DataUrl(createEmbeddingProviderSkillDataUrl),
  ),
  parseBundledSkill(
    "create-agent",
    decodeBase64DataUrl(createAgentSkillDataUrl),
  ),
  parseBundledSkill(
    "create-feature",
    decodeBase64DataUrl(createFeatureSkillDataUrl),
  ),
  parseBundledSkill(
    "create-llm-provider",
    decodeBase64DataUrl(createLlmProviderSkillDataUrl),
  ),
  parseBundledSkill(
    "create-memory",
    decodeBase64DataUrl(createMemorySkillDataUrl),
  ),
  parseBundledSkill(
    "create-storage-adapter",
    decodeBase64DataUrl(createStorageAdapterSkillDataUrl),
  ),
  parseBundledSkill(
    "create-tool",
    decodeBase64DataUrl(createToolSkillDataUrl),
  ),
  parseBundledSkill(
    "debug-runtime-issue",
    decodeBase64DataUrl(debugRuntimeIssueSkillDataUrl),
  ),
  parseBundledSkill(
    "explore-codebase",
    decodeBase64DataUrl(exploreCodebaseSkillDataUrl),
  ),
  parseBundledSkill(
    "implement-feature",
    decodeBase64DataUrl(implementFeatureSkillDataUrl),
  ),
  parseBundledSkill(
    "integrate-external-service",
    decodeBase64DataUrl(integrateExternalServiceSkillDataUrl),
  ),
  parseBundledSkill(
    "multi-agent-setup",
    decodeBase64DataUrl(multiAgentSetupSkillDataUrl),
  ),
  parseBundledSkill(
    "refactor-resource-architecture",
    decodeBase64DataUrl(refactorResourceArchitectureSkillDataUrl),
  ),
  parseBundledSkill(
    "review-copilotz-project",
    decodeBase64DataUrl(reviewCopilotzProjectSkillDataUrl),
  ),
  parseBundledSkill(
    "ship-chat-experience",
    decodeBase64DataUrl(shipChatExperienceSkillDataUrl),
  ),
  parseBundledSkill(
    "setup-collection",
    decodeBase64DataUrl(setupCollectionSkillDataUrl),
  ),
];

function buildCoreTools(): ToolConfig[] {
  return coreTools.map((key) => {
    const tool = nativeTools[key];
    if (!tool) throw new Error(`Missing core tool: ${key}`);
    // Match the manifest-loader tool shape (it sets { id: name, name, ... }).
    // `filterResources` relies on `resource.id` being present.
    return {
      id: key,
      ...(tool as object),
    } as unknown as ToolConfig;
  });
}

function buildBundledAgent(
  id: string,
  instructions: string,
  config: Record<string, unknown>,
): AgentConfig {
  return {
    id,
    name: id,
    instructions,
    ...config,
  } as AgentConfig;
}

export const bundledAgents: Record<string, AgentConfig> = {
  copilotz: buildBundledAgent(
    "copilotz",
    copilotzAgentInstructions,
    copilotzAgentConfig,
  ),
  east: buildBundledAgent("east", eastAgentInstructions, eastAgentConfig),
  north: buildBundledAgent("north", northAgentInstructions, northAgentConfig),
  south: buildBundledAgent("south", southAgentInstructions, southAgentConfig),
  west: buildBundledAgent("west", westAgentInstructions, westAgentConfig),
};

function buildCoreChannels(): ChannelEntry[] {
  return [{
    name: "web",
    ingress: webIngressAdapter,
    egress: webEgressAdapter,
  }];
}

function buildCoreCollections(): CollectionDefinition[] {
  return [
    participantCollection as unknown as CollectionDefinition,
    threadCollection as unknown as CollectionDefinition,
    messageCollection as unknown as CollectionDefinition,
    assetCollection as unknown as CollectionDefinition,
    llmAttemptCollection as unknown as CollectionDefinition,
    toolExecutionCollection as unknown as CollectionDefinition,
    llmUsageCollection as unknown as CollectionDefinition,
    usageCollection as unknown as CollectionDefinition,
    scheduledJobCollection as unknown as CollectionDefinition,
    memorySpaceCollection as unknown as CollectionDefinition,
    brainNodeCollection as unknown as CollectionDefinition,
    longTermMemoryCollection as unknown as CollectionDefinition,
  ];
}

function buildCoreMemory(): MemoryResource[] {
  return [
    { name: "participant", ...(participantMemory as object) } as MemoryResource,
    { name: "history", ...(historyMemory as object) } as MemoryResource,
    { name: "long_term", ...(longTermMemory as object) } as MemoryResource,
  ];
}

function buildCoreProcessors(): ProcessorEntry[] {
  const durableProcessors = [
    longTermMemoryTriggerMessageCreatedProcessor,
    messageRouterMessageCreatedProcessor,
    llmCallLlmAttemptCreatedProcessor,
    llmResultLlmAttemptCompletedProcessor,
    llmResultLlmAttemptFailedProcessor,
    toolCallToolExecutionCreatedProcessor,
    toolResultToolExecutionCompletedProcessor,
    toolResultToolExecutionFailedProcessor,
    ragIngestRagIngestionCreatedProcessor,
    entityExtractionCreatedProcessor,
    longTermMemoryConsolidationCreatedProcessor,
  ].flatMap((mod) => toProcessorEntries(mod as ProcessorModule));

  const legacyProcessors = [
    toProcessorEntry("new_message", messageRouterMessageCreatedProcessor),
    toProcessorEntry("llm_call", llmCallLlmAttemptCreatedProcessor),
    toProcessorEntry("llm_result", llmResultLlmAttemptFailedProcessor),
    toProcessorEntry("tool_call", toolCallToolExecutionCreatedProcessor),
    toProcessorEntry("tool_result", toolResultToolExecutionFailedProcessor),
    toProcessorEntry("rag_ingest", ragIngestRagIngestionCreatedProcessor),
    toProcessorEntry("entity_extract", entityExtractionCreatedProcessor),
  ];

  return [...durableProcessors, ...legacyProcessors];
}

function buildCoreLlm(): Array<{ name: string; factory: ProviderFactory }> {
  return Object.entries(llmProviders).map(([name, factory]) => ({
    name,
    factory: factory as ProviderFactory,
  }));
}

function buildCoreStorage(): Array<
  { name: string; module: Record<string, unknown> }
> {
  return Object.entries(storageAdapters).map(([name, module]) => ({
    name,
    module: module as Record<string, unknown>,
  }));
}

export const coreResources: Resources = {
  agents: [],
  channels: buildCoreChannels(),
  collections: buildCoreCollections(),
  memory: buildCoreMemory(),
  tools: buildCoreTools(),
  processors: buildCoreProcessors(),
  skills: coreSkills,
  llm: buildCoreLlm(),
  storage: buildCoreStorage(),
};
