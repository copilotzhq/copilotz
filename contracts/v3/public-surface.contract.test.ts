import { assertEquals } from "@std/assert";

import * as copilotz from "../../index.ts";
import * as adapters from "../../runtime/adapters/index.ts";
import * as denoAdapters from "../../runtime/adapters/deno/index.ts";
import * as nodeAdapters from "../../runtime/adapters/node/index.ts";
import * as stdioAdapters from "../../runtime/adapters/stdio.ts";
import * as application from "../../runtime/application/public.ts";
import * as actions from "../../runtime/actions/index.ts";
import * as attachments from "../../runtime/attachments/index.ts";
import * as capabilities from "../../runtime/capabilities/index.ts";
import * as content from "../../runtime/content/index.ts";
import * as domain from "../../runtime/domain/index.ts";
import * as events from "../../runtime/events/index.ts";
import * as plugins from "../../runtime/plugins/index.ts";
import * as server from "../../server/index.ts";
import * as migration from "../../migration/v1/index.ts";
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
      "createCopilotzApplication",
      "createCopilotzEngine",
      "createDeliveryExecutor",
      "createManagedOminipgSession",
      "createOminipgSqlSession",
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
  assertFunctions(adapters, [
    "createServerWorkflowToolCatalog",
  ]);
  assertEquals("createModulePluginResolver" in adapters, false);
  assertEquals("createManagedOminipgSession" in adapters, false);
  assertEquals("createOminipgSqlSession" in adapters, false);
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
    "listen",
  ]);
  assertFunctions(attachments, [
    "createAttachmentRuntime",
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
