import type { ChannelEntry } from "@/server/channels.ts";
import type { Skill } from "@/runtime/loaders/skill-types.ts";
import { parseSkillMarkdown } from "@/runtime/loaders/skill-parser.ts";
import type {
  Event,
  EventProcessor,
  MemoryResource,
  NewEvent,
  NewUnknownEvent,
  ProcessorDeps,
} from "@/types/index.ts";
import type { ProviderFactory } from "@/runtime/llm/types.ts";
import type { Resources } from "@/runtime/loaders/resources.ts";
import type { CollectionDefinition, ToolConfig } from "@/index.ts";

// ---- Core: channels.web ----------------------------------------------------
import webIngressAdapter from "@/resources/channels/web/ingress.ts";
import webEgressAdapter from "@/resources/channels/web/egress.ts";

// ---- Core: collections -----------------------------------------------------
import participantCollection from "@/resources/collections/participant.ts";
import messageCollection from "@/resources/collections/message.ts";
import llmUsageCollection from "@/resources/collections/llm_usage.ts";

// ---- Core: memory ----------------------------------------------------------
import participantMemory from "@/resources/memory/participant.ts";
import historyMemory from "@/resources/memory/history.ts";

// ---- Core: tools -----------------------------------------------------------
import { nativeTools } from "@/resources/tools/_registry.ts";

// ---- Core: processors ------------------------------------------------------
import * as newMessageProcessor from "@/resources/processors/new_message/index.ts";
import * as llmCallProcessor from "@/resources/processors/llm_call/index.ts";
import * as llmResultProcessor from "@/resources/processors/llm_result/index.ts";
import * as toolCallProcessor from "@/resources/processors/tool_call/index.ts";
import * as toolResultProcessor from "@/resources/processors/tool_result/index.ts";

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

const asShouldProcess = (
  fn: (event: unknown, deps?: unknown) => boolean | Promise<boolean>,
): ProcessorEntry["shouldProcess"] => {
  return async (event: Event, deps: ProcessorDeps): Promise<boolean> => {
    try {
      return Boolean(await fn(event, deps));
    } catch {
      return false;
    }
  };
};

const asProcess = (
  fn: (event: unknown, deps?: unknown) => unknown | Promise<unknown>,
): ProcessorEntry["process"] => {
  return async (event: Event, deps: ProcessorDeps) => {
    const result = await fn(event, deps);
    if (result == null) return;
    if (Array.isArray(result)) {
      return { producedEvents: result as Array<NewEvent | NewUnknownEvent> };
    }
    if (
      typeof result === "object" && result &&
      "type" in (result as Record<string, unknown>) &&
      "payload" in (result as Record<string, unknown>)
    ) {
      return { producedEvents: [result as NewEvent | NewUnknownEvent] };
    }
    if (
      typeof result === "object" && result &&
      "producedEvents" in (result as Record<string, unknown>)
    ) {
      const produced = (result as { producedEvents?: unknown }).producedEvents;
      if (Array.isArray(produced)) {
        return {
          producedEvents: produced as Array<NewEvent | NewUnknownEvent>,
        };
      }
      if (produced) {
        return { producedEvents: [produced as NewEvent | NewUnknownEvent] };
      }
    }
    return;
  };
};

function toProcessorEntry(
  eventType: string,
  mod: Record<string, unknown>,
): ProcessorEntry {
  const maybeShouldProcess = mod.shouldProcess;
  const maybeProcess = mod.process || mod.default;
  if (typeof maybeShouldProcess !== "function" || typeof maybeProcess !== "function") {
    throw new Error(`Invalid processor module for ${eventType}`);
  }
  return {
    shouldProcess: asShouldProcess(
      maybeShouldProcess as (
        event: unknown,
        deps?: unknown,
      ) => boolean | Promise<boolean>,
    ),
    process: asProcess(
      maybeProcess as (
        event: unknown,
        deps?: unknown,
      ) => unknown | Promise<unknown>,
    ),
    eventType: eventType.toUpperCase(),
    priority: typeof mod.priority === "number" ? mod.priority : 0,
  };
}

const coreTools = [
  "list_skills",
  "load_skill",
  "read_skill_resource",
  "persistent_terminal",
  "update_my_memory",
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
    messageCollection as unknown as CollectionDefinition,
    llmUsageCollection as unknown as CollectionDefinition,
  ];
}

function buildCoreMemory(): MemoryResource[] {
  return [
    { name: "participant", ...(participantMemory as object) } as MemoryResource,
    { name: "history", ...(historyMemory as object) } as MemoryResource,
  ];
}

function buildCoreProcessors(): ProcessorEntry[] {
  return [
    toProcessorEntry("new_message", newMessageProcessor as Record<string, unknown>),
    toProcessorEntry("llm_call", llmCallProcessor as Record<string, unknown>),
    toProcessorEntry("llm_result", llmResultProcessor as Record<string, unknown>),
    toProcessorEntry("tool_call", toolCallProcessor as Record<string, unknown>),
    toProcessorEntry("tool_result", toolResultProcessor as Record<string, unknown>),
  ];
}

function buildCoreLlm(): Array<{ name: string; factory: ProviderFactory }> {
  return Object.entries(llmProviders).map(([name, factory]) => ({
    name,
    factory: factory as ProviderFactory,
  }));
}

function buildCoreStorage(): Array<{ name: string; module: Record<string, unknown> }> {
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

