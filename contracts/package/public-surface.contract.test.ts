/** @module Locks the deliberate package export surface. */
import { assertEquals } from "@std/assert";

import * as copilotz from "../../index.ts";
import * as denoAdapters from "../../runtime/adapters/deno/index.ts";
import * as application from "../../runtime/application/public.ts";
import * as engine from "../../runtime/engine/index.ts";
import * as actions from "../../runtime/actions/index.ts";
import * as content from "../../runtime/content/index.ts";
import * as events from "../../runtime/events/index.ts";
import * as plugins from "../../runtime/plugins/index.ts";
import * as persistence from "../../runtime/persistence/index.ts";
import * as server from "../../server/index.ts";
import * as tools from "../../plugins/core/index.ts";
import * as builtinTools from "../../plugins/tool-builtin/index.ts";
import * as denoTools from "../../plugins/tool-deno/index.ts";
import * as financeTools from "../../plugins/tool-finance/index.ts";
import * as mcpTools from "../../plugins/tool-mcp/index.ts";
import * as stdioMcpTools from "../../plugins/tool-mcp/adapters/stdio/index.ts";
import * as openApiTools from "../../plugins/tool-openapi/index.ts";
import * as persistentTerminalTools from "../../plugins/tool-persistent-terminal/index.ts";
import * as denoPersistentTerminal from "../../plugins/tool-persistent-terminal/adapters/deno-terminal/index.ts";
import * as webTools from "../../plugins/tool-web/index.ts";
import * as skills from "../../plugins/skills/index.ts";
import * as denoSkills from "../../plugins/skills/authoring/open-skills/index.ts";
import * as admin from "../../plugins/admin/index.ts";
import * as knowledge from "../../plugins/knowledge/index.ts";
import * as memory from "../../plugins/memory/index.ts";
import * as core from "@copilotz/copilotz/core";
import * as coreCli from "@copilotz/copilotz/core/cli";
import * as llm from "@copilotz/copilotz/llm";
import * as llmTokens from "@copilotz/copilotz/llm/tokens";
import * as coreSchedules from "@copilotz/copilotz/schedules/core";
import * as goals from "@copilotz/copilotz/goals";
import * as schedules from "@copilotz/copilotz/schedules";
import * as usage from "@copilotz/copilotz/usage";
import type {
  CopilotzApplication,
  CreateCopilotzOptions,
} from "../../index.ts";

function compilePublicTypes(
  _application: CopilotzApplication,
  _options: CreateCopilotzOptions,
): void {}
void compilePublicTypes;

function assertFunctions(
  module: Record<string, unknown>,
  names: readonly string[],
): void {
  for (const name of names) assertEquals(typeof module[name], "function", name);
}

Deno.test("package root exposes only the application factory", () => {
  assertFunctions(copilotz, ["createCopilotz"]);
  assertEquals(Object.keys(copilotz).sort(), ["createCopilotz"]);
  for (
    const removed of [
      "createDatabase",
      "loadResources",
      "withSchema",
      "getNativeTools",
      "createAssetStoreForNamespace",
      "createUsageService",
      "createCopilotzApplication",
      "createCopilotzGateway",
      "createCopilotzWorker",
      "createCopilotzPersistence",
      "createCopilotzEngine",
      "createDeliveryExecutor",
      "createManagedOminipgSession",
      "createOminipgSqlSession",
      "builtInToolsPlugin",
      "financeToolsPlugin",
      "persistentTerminalToolsPlugin",
      "webToolsPlugin",
      "adminPlugin",
      "knowledgePlugin",
      "memoryPlugin",
      "corePlugin",
      "createGoalRuntime",
      "usagePlugin",
      "schedulesPlugin",
      "coreSchedulesPlugin",
      "defineLlmProviderResource",
      "defineAgent",
      "defineLlmConnection",
      "llmPlugin",
      "agentCapabilities",
      "defineContextResource",
      "requireAgent",
      "workflowMetadata",
    ]
  ) assertEquals(removed in copilotz, false, removed);
});

Deno.test("package subpaths expose cohesive owner APIs", () => {
  assertEquals(Object.keys(application), []);
  assertEquals("createCopilotzApplication" in application, false);
  assertFunctions(engine, ["createCopilotzEngine"]);
  assertFunctions(persistence, ["createCopilotzPersistence"]);
  assertFunctions(coreCli, ["createInteractiveCli", "startInteractiveCli"]);
  assertFunctions(denoAdapters, ["listen"]);
  for (
    const moved of [
      "createPersistentTerminalService",
      "createProcessToolsPlugin",
      "createWorkspaceToolsPlugin",
      "buildOpenSkillsPlugin",
    ]
  ) assertEquals(moved in denoAdapters, false, moved);
  assertEquals(typeof builtinTools.builtInToolsPlugin, "object");
  assertEquals(typeof denoTools.denoToolsPlugin, "object");
  assertEquals(typeof financeTools.financeToolsPlugin, "object");
  assertFunctions(mcpTools, ["prepareMcpTools"]);
  assertFunctions(stdioMcpTools, ["connectMcp"]);
  assertFunctions(openApiTools, ["compileOpenApiTools"]);
  assertFunctions(openApiTools, ["defineApi"]);
  assertFunctions(tools, ["defineTool"]);
  assertEquals(
    typeof persistentTerminalTools.persistentTerminalToolsPlugin,
    "object",
  );
  assertFunctions(denoPersistentTerminal, [
    "createPersistentTerminalService",
  ]);
  assertEquals(typeof webTools.webToolsPlugin, "object");
  assertFunctions(skills, [
    "defineInlineSkill",
    "defineSkill",
  ]);
  assertFunctions(denoSkills, ["buildOpenSkillsPlugin"]);
  assertEquals(typeof admin.adminPlugin, "object");
  assertEquals(typeof knowledge.knowledgePlugin, "object");
  assertEquals(typeof memory.memoryPlugin, "object");
  assertFunctions(core, [
    "message",
    "defineAgent",
    "defineContextResource",
    "normalizeThreadMetadata",
    "selectCapabilityResources",
    "workflowMetadata",
    "mapMessageRecord",
    "mapParticipantRecord",
    "mapThreadRecord",
  ]);
  assertEquals(typeof core.corePlugin, "object");
  assertFunctions(llm, [
    "createLlmAdapter",
    "defineLlmConnection",
    "createChatGptConnection",
    "normalizeLlmModelSelections",
  ]);
  assertEquals("defineModel" in llm, false);
  assertEquals("defineLlmCredential" in llm, false);
  assertFunctions(llmTokens, ["estimateTextTokens", "estimateTokens"]);
  for (
    const removed of [
      "createAnthropicAdapter",
      "createDeepSeekAdapter",
      "createGeminiAdapter",
      "createGroqAdapter",
      "createMinimaxAdapter",
      "createOllamaAdapter",
      "createOpenAiAdapter",
    ]
  ) assertEquals(removed in llm, false, removed);
  assertEquals(typeof llm.callLlmAction, "object");
  assertEquals(typeof llm.llmPlugin, "object");
  assertEquals(typeof goals.runGoalAction, "object");
  assertEquals("runGoal" in goals, false);
  assertEquals(typeof core.agentCapabilities.resolve, "function");
  assertEquals("createAgentCapabilityResolver" in core, false);
  for (
    const removed of [
      "createGoalsPlugin",
      "defineGoal",
      "startGoal",
      "cancelGoal",
      "goalResult",
      "goalCollection",
      "createGoalRuntime",
    ]
  ) assertEquals(removed in goals, false, removed);
  assertEquals(typeof usage.usagePlugin, "object");
  assertEquals(typeof usage.usageCollection, "object");
  assertFunctions(schedules, [
    "createScheduledJob",
    "getNextScheduledRunAt",
    "scheduleTick",
  ]);
  assertEquals(typeof schedules.schedulesPlugin, "object");
  assertFunctions(coreSchedules, [
    "normalizeCoreScheduledMessagePayload",
    "scheduledMessageJob",
  ]);
  assertEquals(typeof coreSchedules.coreSchedulesPlugin, "object");
  assertFunctions(content, [
    "createContentPreparer",
    "createContentResolver",
    "createDatabaseAssetRepository",
    "createGcsBodyStore",
    "createGcsBodyStoreAdapter",
    "createGcsMetadataAccessTokenProvider",
  ]);
  assertFunctions(events, ["createEventStore", "createEventCoordinator"]);
  assertFunctions(plugins, ["definePlugin", "defineProcessor"]);
  assertFunctions(actions, [
    "createSecretAdapter",
    "defineAction",
    "resolveActionSourceData",
    "secret",
  ]);
  assertFunctions(server, [
    "compileServerRoutes",
    "createServerFacadeFetchHandler",
    "createHttpAdapter",
    "defineServerFacade",
  ]);
  assertEquals(typeof server.serverPlugin, "object");
});

Deno.test("server exposes only its bounded transport API", () => {
  for (
    const removed of [
      "withApp",
      "createGraphHandlers",
      "createThreadHandlers",
      "tickScheduledJobs",
      "createEventNativeApp",
      "createEventNativeFetchHandler",
      "createV1RouteAdapter",
    ]
  ) assertEquals(removed in server, false, removed);
});
