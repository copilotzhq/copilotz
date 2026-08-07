import { assertEquals } from "@std/assert";

import * as copilotzModule from "@/index.ts";
import type {
  Agent,
  API,
  Copilotz,
  CopilotzDb,
  Event,
  GoalResult,
  GoalStreamEvent,
  IngressResult,
  LLMRuntimeConfig,
  MessagePayload,
  NewEvent,
  ProcessorDeps,
  Thread,
  ToolConfig,
  ToolExecutionContext,
} from "@/index.ts";
import * as resourceModule from "@/resources/index.ts";
import * as serverModule from "@/server/index.ts";

type DownstreamCopilotzSurface = Pick<
  Copilotz,
  | "config"
  | "db"
  | "ops"
  | "run"
  | "goal"
  | "recover"
  | "start"
  | "shutdown"
  | "assets"
  | "embeddings"
  | "collections"
  | "schema"
>;

type CurrentRunHandle = Awaited<ReturnType<Copilotz["run"]>>;

function compileDownstreamTypes(
  _copilotz: DownstreamCopilotzSurface,
  _db: CopilotzDb,
  _agent: Agent,
  _api: API,
  _event: Event,
  _newEvent: NewEvent,
  _deps: ProcessorDeps,
  _thread: Thread,
  _message: MessagePayload,
  _tool: ToolConfig,
  _toolContext: ToolExecutionContext,
  _llm: LLMRuntimeConfig,
  _ingress: IngressResult,
  _goalResult: GoalResult,
  _goalEvent: GoalStreamEvent,
  run: CurrentRunHandle,
): void {
  const queueId: string = run.queueId;
  const threadId: string = run.threadId;
  const status: "queued" = run.status;
  const done: Promise<void> = run.done;
  const cancel: () => void = run.cancel;
  const events: AsyncIterable<unknown> = run.events;
  void [queueId, threadId, status, done, cancel, events];
}

void compileDownstreamTypes;

Deno.test("A02 root package retains downstream-consumed value exports", () => {
  const expectedFunctions = [
    "createCopilotz",
    "createDatabase",
    "defineCollection",
    "listTenantSchemas",
    "loadResources",
    "parseAssetRef",
    "withSchema",
  ] as const;

  for (const name of expectedFunctions) {
    assertEquals(typeof copilotzModule[name], "function", name);
  }
  assertEquals(typeof copilotzModule.index, "object");
});

Deno.test("A02 server package retains framework-independent handler factories", () => {
  const expectedFunctions = [
    "createAssetHandlers",
    "createChannelHandlers",
    "createCollectionHandlers",
    "createEventHandlers",
    "createGraphHandlers",
    "createMessageHandlers",
    "createParticipantHandlers",
    "createThreadHandlers",
    "tickScheduledJobs",
    "withApp",
  ] as const;

  for (const name of expectedFunctions) {
    assertEquals(typeof serverModule[name], "function", name);
  }
});

Deno.test("A02 resources package retains manifest discovery exports", () => {
  assertEquals(typeof resourceModule.bundledResourcesUrl, "string");
  assertEquals(resourceModule.bundledResourcesUrl.startsWith("file:"), true);
  assertEquals(typeof resourceModule.manifest, "object");
});
