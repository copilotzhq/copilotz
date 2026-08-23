import { assertEquals } from "@std/assert";

import * as copilotz from "../../index.ts";
import * as adapters from "../../runtime/adapters/index.ts";
import * as denoAdapters from "../../runtime/adapters/deno/index.ts";
import * as nodeAdapters from "../../runtime/adapters/node/index.ts";
import * as application from "../../runtime/application/public.ts";
import * as actions from "../../runtime/actions/index.ts";
import * as attachments from "../../runtime/attachments/index.ts";
import * as content from "../../runtime/content/index.ts";
import * as domain from "../../runtime/domain/index.ts";
import * as events from "../../runtime/events/index.ts";
import * as plugins from "../../runtime/plugins/index.ts";
import * as server from "../../server/index.ts";
import * as migration from "../../migration/v1/index.ts";
import * as builtinTools from "../../plugins/tools/builtin/plugin.ts";
import * as toolCatalog from "../../plugins/tools/catalog/server.ts";
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
import * as llm from "@copilotz/copilotz/llm";
import * as coreSchedules from "@copilotz/copilotz/schedules/core";
import * as goals from "@copilotz/copilotz/goals";
import * as schedules from "@copilotz/copilotz/schedules";
import * as usage from "@copilotz/copilotz/usage";
import type {
  AnyCopilotzPlugin,
  CopilotzApplication,
  CopilotzEvent,
  CopilotzGateway,
  CopilotzWorker,
  CreateCopilotzOptions,
  RunHandle,
  ThreadAttachment,
} from "../../index.ts";

function compilePublicTypes(
  _application: CopilotzApplication,
  _options: CreateCopilotzOptions,
  _event: CopilotzEvent,
  _gateway: CopilotzGateway,
  _worker: CopilotzWorker,
  _run: RunHandle,
  _attachment: ThreadAttachment,
  _plugin: AnyCopilotzPlugin,
): void {}
void compilePublicTypes;

function assertFunctions(
  module: Record<string, unknown>,
  names: readonly string[],
): void {
  for (const name of names) assertEquals(typeof module[name], "function", name);
}

Deno.test("v3 root exposes the factory-first application vocabulary", () => {
  assertFunctions(copilotz, [
    "createCopilotz",
    "createCopilotzGateway",
    "createCopilotzWorker",
    "definePlugin",
    "defineProcessor",
    "defineCollection",
    "defineAction",
    "createAttachmentRuntime",
    "createContentPreparer",
    "createEventStore",
  ]);
  for (
    const removed of [
      "createDatabase",
      "loadResources",
      "withSchema",
      "getNativeTools",
      "createAssetStoreForNamespace",
      "createUsageService",
      "createCopilotzApplication",
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

Deno.test("v3 package subpaths expose cohesive factories", () => {
  assertFunctions(application, [
    "createCopilotz",
    "createCopilotzGateway",
    "createCopilotzPersistence",
    "createCopilotzWorker",
  ]);
  assertEquals("createCopilotzApplication" in application, false);
  assertEquals("createServerWorkflowToolCatalog" in adapters, false);
  assertEquals("createModulePluginResolver" in adapters, false);
  assertEquals("createManagedOminipgSession" in adapters, false);
  assertEquals("createOminipgSqlSession" in adapters, false);
  assertEquals("connectMcp" in adapters, false);
  assertFunctions(nodeAdapters, [
    "createInteractiveCliIo",
    "startInteractiveCli",
  ]);
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
  assertFunctions(toolCatalog, [
    "createOpenApiWorkflowToolGenerator",
    "createServerWorkflowToolCatalog",
  ]);
  assertFunctions(denoTools, [
    "createProcessToolsPlugin",
    "createWorkspaceToolsPlugin",
  ]);
  assertFunctions(financeTools, ["createFinanceToolsPlugin"]);
  assertFunctions(mcpTools, ["createMcpWorkflowToolGenerator"]);
  assertFunctions(stdioMcpTools, ["connectMcp"]);
  assertFunctions(openApiTools, ["generateAllApiTools", "generateApiTools"]);
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
  ]);
  assertEquals(typeof core.corePlugin, "object");
  assertFunctions(llm, [
    "createAnthropicAdapter",
    "createDeepSeekAdapter",
    "createGeminiAdapter",
    "createGroqAdapter",
    "createMinimaxAdapter",
    "createOllamaAdapter",
    "createOpenAiAdapter",
    "defineModel",
  ]);
  assertEquals(typeof llm.callLlmAction, "object");
  assertEquals(typeof llm.llmPlugin, "object");
  assertFunctions(goals, ["createGoalRuntime"]);
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
  assertFunctions(attachments, [
    "createAttachmentRuntime",
  ]);
  assertFunctions(content, [
    "createContentPreparer",
    "createContentResolver",
    "createDatabaseAssetRepository",
  ]);
  assertEquals("defineCollection" in domain, false);
  assertEquals("createEventCollections" in domain, false);
  assertEquals("createDomainRelationRepository" in domain, false);
  assertFunctions(events, ["createEventStore", "createEventCoordinator"]);
  assertFunctions(plugins, ["definePlugin", "defineProcessor"]);
  assertFunctions(actions, ["defineAction"]);
});

Deno.test("server and migration remain explicit bounded subpaths", () => {
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
  assertFunctions(migration, ["upgradeV1Schema", "upgradeV1Schemas"]);
});
