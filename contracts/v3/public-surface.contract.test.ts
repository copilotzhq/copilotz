import { assertEquals } from "@std/assert";

import * as copilotz from "../../index.ts";
import * as adapters from "../../runtime/adapters/index.ts";
import * as denoAdapters from "../../runtime/adapters/deno/index.ts";
import * as nodeAdapters from "../../runtime/adapters/node/index.ts";
import * as stdioAdapters from "../../runtime/adapters/stdio.ts";
import * as application from "../../runtime/application/index.ts";
import * as attachments from "../../runtime/attachments/index.ts";
import * as capabilities from "../../runtime/capabilities/index.ts";
import * as content from "../../runtime/content/index.ts";
import * as domain from "../../runtime/domain/index.ts";
import * as engine from "../../runtime/engine/index.ts";
import * as events from "../../runtime/events/index.ts";
import * as execution from "../../runtime/execution/index.ts";
import * as plugins from "../../runtime/plugins/index.ts";
import * as server from "../../server/index.ts";
import * as migration from "../../migration/v1/index.ts";
import type {
  CopilotzApplication,
  CopilotzEvent,
  CreateCopilotzOptions,
  EventNativeRunHandle,
  PluginManifest,
  ThreadAttachment,
} from "../../index.ts";

function compilePublicTypes(
  _application: CopilotzApplication,
  _options: CreateCopilotzOptions,
  _event: CopilotzEvent,
  _run: EventNativeRunHandle,
  _attachment: ThreadAttachment,
  _manifest: PluginManifest,
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
    "createCopilotzApplication",
    "createCopilotzEngine",
    "createManagedOminipgSession",
    "definePlugin",
    "defineProcessor",
    "defineCollection",
    "createAttachmentRuntime",
    "createContentPreparer",
    "createConversationRepository",
    "createEventStore",
    "createDeliveryExecutor",
    "createAgentAskPlugin",
    "createTextWorkflowPlugin",
    "createAgentCapabilityResolver",
  ]);
  for (
    const removed of [
      "createDatabase",
      "loadResources",
      "withSchema",
      "getNativeTools",
      "createAssetStoreForNamespace",
      "createUsageService",
    ]
  ) assertEquals(removed in copilotz, false, removed);
});

Deno.test("v3 package subpaths expose cohesive factories", () => {
  assertFunctions(application, ["createCopilotz", "createCopilotzApplication"]);
  assertFunctions(adapters, [
    "createManagedOminipgSession",
    "createModulePluginResolver",
    "createServerWorkflowToolCatalog",
  ]);
  assertEquals("connectMcp" in adapters, false);
  assertFunctions(stdioAdapters, [
    "connectMcp",
    "createServerWorkflowToolCatalog",
  ]);
  assertFunctions(nodeAdapters, [
    "createInteractiveCliIo",
    "startInteractiveCli",
  ]);
  assertFunctions(denoAdapters, [
    "buildOpenSkillsPlugin",
    "createPersistentTerminalService",
    "createProcessToolsPlugin",
    "createWorkspaceToolsPlugin",
  ]);
  assertFunctions(attachments, [
    "createAttachmentRuntime",
    "defineRealtimeProviderResource",
  ]);
  assertFunctions(capabilities, [
    "createAgentCapabilityResolver",
    "selectCapabilityResources",
  ]);
  assertFunctions(content, [
    "createContentPreparer",
    "createContentResolver",
    "createDatabaseAssetRepository",
  ]);
  assertFunctions(domain, [
    "defineCollection",
    "createConversationRepository",
    "createEventCollections",
  ]);
  assertFunctions(engine, ["createCopilotzEngine"]);
  assertFunctions(events, ["createEventStore", "createEventCoordinator"]);
  assertFunctions(execution, ["createDeliveryExecutor"]);
  assertFunctions(plugins, ["definePlugin", "defineProcessor"]);
});

Deno.test("server and migration remain explicit bounded subpaths", () => {
  assertFunctions(server, [
    "createEventNativeApp",
    "createEventNativeFetchHandler",
    "createV1FetchHandler",
    "createV1SseProjector",
  ]);
  for (
    const removed of [
      "withApp",
      "createGraphHandlers",
      "createThreadHandlers",
      "tickScheduledJobs",
    ]
  ) assertEquals(removed in server, false, removed);
  assertFunctions(migration, ["upgradeV1Schema", "upgradeV1Schemas"]);
});
