import addApiIntegrationData from "../../resources/skills/add-api-integration/SKILL.ts";
import addProcessorData from "../../resources/skills/add-processor/SKILL.ts";
import advancedChatFeaturesData from "../../resources/skills/advanced-chat-features/SKILL.ts";
import buildCopilotzSystemData from "../../resources/skills/build-copilotz-system/SKILL.ts";
import configureChatUiData from "../../resources/skills/configure-chat-ui/SKILL.ts";
import configureMcpData from "../../resources/skills/configure-mcp/SKILL.ts";
import configureRagData from "../../resources/skills/configure-rag/SKILL.ts";
import createAgentData from "../../resources/skills/create-agent/SKILL.ts";
import createChannelData from "../../resources/skills/create-channel/SKILL.ts";
import createEmbeddingProviderData from "../../resources/skills/create-embedding-provider/SKILL.ts";
import createFeatureData from "../../resources/skills/create-feature/SKILL.ts";
import createLlmProviderData from "../../resources/skills/create-llm-provider/SKILL.ts";
import createMemoryData from "../../resources/skills/create-memory/SKILL.ts";
import createStorageAdapterData from "../../resources/skills/create-storage-adapter/SKILL.ts";
import createToolData from "../../resources/skills/create-tool/SKILL.ts";
import debugRuntimeIssueData from "../../resources/skills/debug-runtime-issue/SKILL.ts";
import exploreCodebaseData from "../../resources/skills/explore-codebase/SKILL.ts";
import implementFeatureData from "../../resources/skills/implement-feature/SKILL.ts";
import integrateExternalServiceData from "../../resources/skills/integrate-external-service/SKILL.ts";
import multiAgentSetupData from "../../resources/skills/multi-agent-setup/SKILL.ts";
import refactorResourceArchitectureData from "../../resources/skills/refactor-resource-architecture/SKILL.ts";
import reviewCopilotzProjectData from "../../resources/skills/review-copilotz-project/SKILL.ts";
import setupCollectionData from "../../resources/skills/setup-collection/SKILL.ts";
import shipChatExperienceData from "../../resources/skills/ship-chat-experience/SKILL.ts";
import { parseSkillMarkdown } from "./parser.ts";
import type { Skill } from "../resources/index.ts";
import { type CopilotzPlugin, definePlugin } from "../plugins/index.ts";

const BUNDLED_SKILL_DATA = [
  ["add-api-integration", addApiIntegrationData],
  ["add-processor", addProcessorData],
  ["advanced-chat-features", advancedChatFeaturesData],
  ["build-copilotz-system", buildCopilotzSystemData],
  ["configure-chat-ui", configureChatUiData],
  ["configure-mcp", configureMcpData],
  ["configure-rag", configureRagData],
  ["create-agent", createAgentData],
  ["create-channel", createChannelData],
  ["create-embedding-provider", createEmbeddingProviderData],
  ["create-feature", createFeatureData],
  ["create-llm-provider", createLlmProviderData],
  ["create-memory", createMemoryData],
  ["create-storage-adapter", createStorageAdapterData],
  ["create-tool", createToolData],
  ["debug-runtime-issue", debugRuntimeIssueData],
  ["explore-codebase", exploreCodebaseData],
  ["implement-feature", implementFeatureData],
  ["integrate-external-service", integrateExternalServiceData],
  ["multi-agent-setup", multiAgentSetupData],
  ["refactor-resource-architecture", refactorResourceArchitectureData],
  ["review-copilotz-project", reviewCopilotzProjectData],
  ["setup-collection", setupCollectionData],
  ["ship-chat-experience", shipChatExperienceData],
] as const;

export type BundledSkillId = typeof BUNDLED_SKILL_DATA[number][0];

export const BUNDLED_SKILL_IDS: readonly BundledSkillId[] = Object.freeze(
  BUNDLED_SKILL_DATA.map(([id]) => id),
);

export type CreateBundledSkillsPluginOptions = Readonly<{
  id?: string;
  version?: string;
  include?: readonly BundledSkillId[];
}>;

function dataUrlText(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  const base64 = comma < 0 ? dataUrl : dataUrl.slice(comma + 1);
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter((item): item is string =>
    typeof item === "string"
  );
  return result.length ? result : undefined;
}

function skillFrom(id: string, dataUrl: string): Skill {
  const { frontmatter, body } = parseSkillMarkdown(dataUrlText(dataUrl));
  const allowedTools = strings(frontmatter["allowed-tools"]);
  const tags = strings(frontmatter.tags);
  return Object.freeze({
    name: typeof frontmatter.name === "string" ? frontmatter.name : id,
    description: typeof frontmatter.description === "string"
      ? frontmatter.description
      : "",
    content: body,
    ...(allowedTools ? { allowedTools: Object.freeze(allowedTools) } : {}),
    ...(tags ? { tags: Object.freeze(tags) } : {}),
    source: "bundled",
    sourcePath: id,
    hasReferences: false,
  }) as Skill;
}

const bundledSkills = Object.freeze(
  BUNDLED_SKILL_DATA.map(([id, data]) => skillFrom(id, data)),
);

/** Returns the immutable, package-embedded skill catalog without I/O. */
export function getBundledSkills(): readonly Skill[] {
  return bundledSkills;
}

/** Provides package-embedded skills as ordinary stable-ID plugin resources. */
export function createBundledSkillsPlugin(
  options: CreateBundledSkillsPluginOptions = {},
): CopilotzPlugin {
  const include = options.include ?? BUNDLED_SKILL_IDS;
  const known = new Set<string>(BUNDLED_SKILL_IDS);
  const selected = include.map((id) => {
    if (!known.has(id)) {
      throw new TypeError(`Unknown bundled skill '${id}'.`);
    }
    return bundledSkills.find((skill) => skill.name === id)!;
  });
  if (new Set(include).size !== include.length) {
    throw new TypeError("Bundled skill selection contains duplicate IDs.");
  }
  return definePlugin({
    manifest: {
      id: options.id ?? "@copilotz/bundled-skills",
      version: options.version ?? "3.0.0",
      provides: { skills: selected.map((skill) => skill.name) },
    },
    resources: { skills: selected },
  });
}
