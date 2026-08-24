import { assertEquals } from "@std/assert";

import * as copilotz from "../../index.ts";
import * as denoAdapters from "../../runtime/adapters/deno/index.ts";
import * as application from "../../runtime/application/public.ts";
import * as actions from "../../runtime/actions/index.ts";
import * as content from "../../runtime/content/index.ts";
import * as events from "../../runtime/events/index.ts";
import * as plugins from "../../runtime/plugins/index.ts";
import * as persistence from "../../runtime/persistence/index.ts";
import * as server from "../../server/index.ts";
import * as migration from "../../migration/v4/index.ts";
import * as tools from "../../plugins/tools/index.ts";
import * as builtinTools from "../../plugins/tools/builtin/plugin.ts";
import * as denoTools from "../../plugins/tools/deno/index.ts";
import * as financeTools from "../../plugins/tools/finance/plugin.ts";
import * as mcpTools from "../../plugins/tools/mcp/generator.ts";
import * as stdioMcpTools from "../../plugins/tools/mcp/stdio.ts";
import * as openApiTools from "../../plugins/tools/openapi/generator.ts";
import * as persistentTerminalTools from "../../plugins/tools/persistent-terminal/plugin.ts";
import * as denoPersistentTerminal from "../../plugins/tools/persistent-terminal/deno.ts";
import * as webTools from "../../plugins/tools/web/plugin.ts";
import * as skills from "../../plugins/skills/index.ts";
import * as denoSkills from "../../plugins/skills/deno.ts";
import * as admin from "../../plugins/admin/index.ts";
import * as knowledge from "../../plugins/knowledge/index.ts";
import * as memory from "../../plugins/memory/index.ts";
import * as core from "@copilotz/copilotz/core";
import * as coreCli from "@copilotz/copilotz/core/cli";
import * as llm from "@copilotz/copilotz/llm";
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
      "createBuiltInToolsPlugin",
      "createFinanceToolsPlugin",
      "createPersistentTerminalToolsPlugin",
      "createWebToolsPlugin",
      "createAdminPlugin",
      "createKnowledgePlugin",
      "createLongTermMemoryPlugin",
      "corePlugin",
      "createGoalRuntime",
      "createUsageWorkflowPlugin",
      "schedulesPlugin",
      "coreSchedulesPlugin",
      "defineLlmProviderResource",
      "defineAgent",
      "defineModel",
      "llmPlugin",
      "createAgentCapabilityResolver",
      "defineContextResource",
      "requireAgent",
      "workflowMetadata",
    ]
  ) assertEquals(removed in copilotz, false, removed);
});

Deno.test("package subpaths expose cohesive factories", () => {
  assertEquals(Object.keys(application), []);
  assertEquals("createCopilotzApplication" in application, false);
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
  assertFunctions(builtinTools, ["createBuiltInToolsPlugin"]);
  assertFunctions(denoTools, [
    "createProcessToolsPlugin",
    "createWorkspaceToolsPlugin",
  ]);
  assertFunctions(financeTools, ["createFinanceToolsPlugin"]);
  assertFunctions(mcpTools, ["createMcpToolsPlugin"]);
  assertFunctions(stdioMcpTools, ["connectMcp"]);
  assertFunctions(openApiTools, ["createOpenApiToolsPlugin"]);
  assertFunctions(openApiTools, ["defineApi"]);
  assertFunctions(tools, ["createToolsPlugin", "defineTool"]);
  assertFunctions(persistentTerminalTools, [
    "createPersistentTerminalToolsPlugin",
  ]);
  assertFunctions(denoPersistentTerminal, [
    "createPersistentTerminalService",
  ]);
  assertFunctions(webTools, ["createWebToolsPlugin"]);
  assertFunctions(skills, [
    "createSkillsPlugin",
    "defineInlineSkill",
    "defineSkill",
  ]);
  assertFunctions(denoSkills, ["buildOpenSkillsPlugin"]);
  assertFunctions(admin, ["createAdminPlugin"]);
  assertFunctions(knowledge, ["createKnowledgePlugin"]);
  assertFunctions(memory, ["createLongTermMemoryPlugin"]);
  assertFunctions(core, [
    "message",
    "createAgentCapabilityResolver",
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
  assertFunctions(llm, ["createLlmAdapter", "defineModel"]);
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
  assertFunctions(goals, [
    "createGoalsPlugin",
    "defineGoal",
    "startGoal",
    "cancelGoal",
    "goalResult",
  ]);
  assertEquals(typeof goals.goalCollection, "object");
  assertEquals("createGoalRuntime" in goals, false);
  assertFunctions(usage, ["createUsageWorkflowPlugin"]);
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
  ]);
  assertFunctions(events, ["createEventStore", "createEventCoordinator"]);
  assertFunctions(plugins, ["definePlugin", "defineProcessor"]);
  assertFunctions(actions, ["defineAction"]);
});

Deno.test("server and the single published-data migration remain explicit bounded subpaths", () => {
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
  assertFunctions(migration, ["migrateToV4"]);
});
