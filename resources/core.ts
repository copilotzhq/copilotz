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

// ---- Core: skills (static text imports) ------------------------------------
import addApiIntegrationSkillRaw from "@/resources/skills/add-api-integration/SKILL.md" with {
  type: "text",
};
import addProcessorSkillRaw from "@/resources/skills/add-processor/SKILL.md" with {
  type: "text",
};
import advancedChatFeaturesSkillRaw from "@/resources/skills/advanced-chat-features/SKILL.md" with {
  type: "text",
};
import buildCopilotzSystemSkillRaw from "@/resources/skills/build-copilotz-system/SKILL.md" with {
  type: "text",
};
import configureChatUiSkillRaw from "@/resources/skills/configure-chat-ui/SKILL.md" with {
  type: "text",
};
import configureMcpSkillRaw from "@/resources/skills/configure-mcp/SKILL.md" with {
  type: "text",
};
import configureRagSkillRaw from "@/resources/skills/configure-rag/SKILL.md" with {
  type: "text",
};
import createAgentSkillRaw from "@/resources/skills/create-agent/SKILL.md" with {
  type: "text",
};
import createChannelSkillRaw from "@/resources/skills/create-channel/SKILL.md" with {
  type: "text",
};
import createEmbeddingProviderSkillRaw from "@/resources/skills/create-embedding-provider/SKILL.md" with {
  type: "text",
};
import createFeatureSkillRaw from "@/resources/skills/create-feature/SKILL.md" with {
  type: "text",
};
import createLlmProviderSkillRaw from "@/resources/skills/create-llm-provider/SKILL.md" with {
  type: "text",
};
import createMemorySkillRaw from "@/resources/skills/create-memory/SKILL.md" with {
  type: "text",
};
import createStorageAdapterSkillRaw from "@/resources/skills/create-storage-adapter/SKILL.md" with {
  type: "text",
};
import createToolSkillRaw from "@/resources/skills/create-tool/SKILL.md" with {
  type: "text",
};
import debugRuntimeIssueSkillRaw from "@/resources/skills/debug-runtime-issue/SKILL.md" with {
  type: "text",
};
import exploreCodebaseSkillRaw from "@/resources/skills/explore-codebase/SKILL.md" with {
  type: "text",
};
import implementFeatureSkillRaw from "@/resources/skills/implement-feature/SKILL.md" with {
  type: "text",
};
import integrateExternalServiceSkillRaw from "@/resources/skills/integrate-external-service/SKILL.md" with {
  type: "text",
};
import multiAgentSetupSkillRaw from "@/resources/skills/multi-agent-setup/SKILL.md" with {
  type: "text",
};
import refactorResourceArchitectureSkillRaw from "@/resources/skills/refactor-resource-architecture/SKILL.md" with {
  type: "text",
};
import reviewCopilotzProjectSkillRaw from "@/resources/skills/review-copilotz-project/SKILL.md" with {
  type: "text",
};
import shipChatExperienceSkillRaw from "@/resources/skills/ship-chat-experience/SKILL.md" with {
  type: "text",
};
import setupCollectionSkillRaw from "@/resources/skills/setup-collection/SKILL.md" with {
  type: "text",
};

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
    shouldProcess: asShouldProcess(maybeShouldProcess as any),
    process: asProcess(maybeProcess as any),
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
  parseBundledSkill("add-api-integration", addApiIntegrationSkillRaw),
  parseBundledSkill("add-processor", addProcessorSkillRaw),
  parseBundledSkill("advanced-chat-features", advancedChatFeaturesSkillRaw),
  parseBundledSkill("build-copilotz-system", buildCopilotzSystemSkillRaw),
  parseBundledSkill("configure-chat-ui", configureChatUiSkillRaw),
  parseBundledSkill("configure-mcp", configureMcpSkillRaw),
  parseBundledSkill("configure-rag", configureRagSkillRaw),
  parseBundledSkill("create-channel", createChannelSkillRaw),
  parseBundledSkill("create-embedding-provider", createEmbeddingProviderSkillRaw),
  parseBundledSkill("create-agent", createAgentSkillRaw),
  parseBundledSkill("create-feature", createFeatureSkillRaw),
  parseBundledSkill("create-llm-provider", createLlmProviderSkillRaw),
  parseBundledSkill("create-memory", createMemorySkillRaw),
  parseBundledSkill("create-storage-adapter", createStorageAdapterSkillRaw),
  parseBundledSkill("create-tool", createToolSkillRaw),
  parseBundledSkill("debug-runtime-issue", debugRuntimeIssueSkillRaw),
  parseBundledSkill("explore-codebase", exploreCodebaseSkillRaw),
  parseBundledSkill("implement-feature", implementFeatureSkillRaw),
  parseBundledSkill("integrate-external-service", integrateExternalServiceSkillRaw),
  parseBundledSkill("multi-agent-setup", multiAgentSetupSkillRaw),
  parseBundledSkill("refactor-resource-architecture", refactorResourceArchitectureSkillRaw),
  parseBundledSkill("review-copilotz-project", reviewCopilotzProjectSkillRaw),
  parseBundledSkill("ship-chat-experience", shipChatExperienceSkillRaw),
  parseBundledSkill("setup-collection", setupCollectionSkillRaw),
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
    toProcessorEntry("new_message", newMessageProcessor as any),
    toProcessorEntry("llm_call", llmCallProcessor as any),
    toProcessorEntry("llm_result", llmResultProcessor as any),
    toProcessorEntry("tool_call", toolCallProcessor as any),
    toProcessorEntry("tool_result", toolResultProcessor as any),
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

