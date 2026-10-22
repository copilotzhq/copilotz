import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createTestApplication,
  defineTestServerFacade,
} from "../../../runtime/testing/server-authorization.test.ts";
import { createTestDatabase } from "../../../runtime/testing/ominipg.ts";
import { definePlugin } from "@copilotz/copilotz/plugins";
import { type ActionContext, defineAction } from "@copilotz/copilotz/actions";
import {
  CORE_TOOL_ACTION_METADATA_SCHEMA,
  corePlugin,
} from "@copilotz/copilotz/core";
import { serverPlugin } from "../../server/index.ts";
import { coreHttpAdapter } from "../index.ts";
import { createServerFacadeFetchHandler } from "../../../server/facade.ts";
import {
  createCopilotzClient,
  type ObservationFrame,
} from "../../../client/index.ts";

Deno.test("Tool live and retained nested streams use the captured output audience", async () => {
  const database = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  let release = () => {};
  let opened = () => {};
  let finish = Promise.resolve();
  let policy: "public_status" | "requester_only" | "public" = "public_status";
  const child = defineAction({
    id: "test.toolvis.child",
    async execute(_input: unknown, context: ActionContext) {
      const stream = await context.streams.open({
        mediaType: "text/plain",
        role: "tool-output",
      });
      await stream.append({
        bytes: new TextEncoder().encode("PRIVATE_PROGRESS"),
        appendId: "one",
      });
      await context.progress({ output: "PRIVATE_PROGRESS" });
      opened();
      await finish;
      const progress = await stream.close({
        assetId: `toolvis-progress-${policy}`,
      });
      const [retained] = await context.content.materialize([progress], {
        origin: { type: "test.toolvis", id: context.action.runId },
      });
      return { text: "PRIVATE_RESULT", progress: retained };
    },
  });
  const parent = defineAction({
    id: "test.toolvis.parent",
    execute(_input: unknown, context: ActionContext) {
      return context.actions.child({});
    },
  });
  const application = await createTestApplication({
    database,
    namespace: "tenant",
    databaseSchema: `toolvis_stream_${crypto.randomUUID().replaceAll("-", "")}`,
    plugins: [
      definePlugin({ ...corePlugin, processors: {} }),
      definePlugin({
        id: "test.toolvis.http",
        version: "1",
        adapters: { http: { core: coreHttpAdapter } },
      }),
      definePlugin({
        id: "test.toolvis",
        version: "1",
        actions: { parent, child },
      }),
      definePlugin({
        ...serverPlugin,
        resources: {
          server: {
            default: defineTestServerFacade({
              authenticate(request) {
                return {
                  namespace: "tenant",
                  actor: { id: request.headers.get("x-viewer") ?? "human" },
                  actionMetadata: {
                    schema: CORE_TOOL_ACTION_METADATA_SCHEMA,
                    planId: "plan",
                    planMessageId: "plan-message",
                    planIndex: 0,
                    stageIndex: 0,
                    stageCount: 1,
                    planSize: 1,
                    toolCallId: "call",
                    action: "parent",
                    threadId: "thread",
                    triggerMessageId: "trigger",
                    agentId: "agent",
                    agentParticipantId: "agent",
                    initiatorParticipantId: "human",
                    availableToolIds: ["parent"],
                    responseVisibility: { kind: "public" },
                    parentLlmActionRunId: "llm",
                    outputVisibility: {
                      kind: "tool",
                      policy,
                      requesterId: "agent",
                      initiatorId: "human",
                    },
                  },
                };
              },
              evaluate: (request) => ({
                assets: {
                  read: [new URL(request.url).pathname.split("/").at(-1)!],
                },
                operations: { metadata: {} },
                actions: { parent: {}, child: {} },
                collections: { participant: {}, thread: {}, message: {} },
              }),
            }),
          },
        },
      }),
    ],
  });
  const handler = createServerFacadeFetchHandler(application);
  const client = (viewer: string) =>
    createCopilotzClient({
      baseUrl: "https://test/api",
      fetch: ((url, init) => {
        const request = new Request(url, init);
        request.headers.set("x-viewer", viewer);
        return handler(request);
      }) as typeof fetch,
    });
  try {
    for (
      const selected of ["public_status", "requester_only", "public"] as const
    ) {
      policy = selected;
      const ready = new Promise<void>((resolve) => opened = resolve);
      finish = new Promise<void>((resolve) => release = resolve);
      const receipt = await client("human").actions.submit("parent", {}, {
        idempotencyKey: selected,
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          ready,
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Tool stream did not open")),
              10_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      const observed = new Map<string, ObservationFrame[]>();
      const subscriptions = ["human", "other-human", "agent"].map(
        async (viewer) => {
          const frames: ObservationFrame[] = [];
          observed.set(viewer, frames);
          await client(viewer).operations.observe({
            operationIds: [receipt.operationId],
            signal: AbortSignal.timeout(15_000),
            onFrame(frame) {
              frames.push(frame);
              if (
                frame.kind === "stream-chunk" && viewer === "agent"
              ) release();
            },
          });
        },
      );
      await Promise.all(subscriptions);
      const result =
        (await client("agent").operations.result(receipt.operationId))
          .value as { progress: { assetId: string } };
      assert(result.progress.assetId);
      for (const [viewer, frames] of observed) {
        const readable = policy === "public" || viewer === "agent" ||
          policy === "public_status" && viewer === "human";
        if (readable) {
          assertEquals(
            ((await client(viewer).operations.result(receipt.operationId))
              .value as { text: string }).text,
            "PRIVATE_RESULT",
          );
        } else {await assertRejects(() =>
            client(viewer).operations.result(receipt.operationId)
          );}
        const assetResponse = await handler(
          new Request(`https://test/api/assets/${result.progress.assetId}`, {
            headers: { "x-viewer": viewer },
          }),
        );
        assertEquals(
          assetResponse.status,
          readable ? 200 : 404,
          `retained stream asset ${policy} / ${viewer}`,
        );
        const chunks = frames.filter((frame) => frame.kind === "stream-chunk");
        assertEquals(chunks.length > 0, readable, `${policy} / ${viewer}`);
        if (!readable) {
          assertEquals(
            JSON.stringify(frames).includes("PRIVATE_RESULT"),
            false,
            `lifecycle ${policy} / ${viewer}`,
          );
          assertEquals(
            JSON.stringify(frames).includes("PRIVATE_PROGRESS"),
            false,
            `progress ${policy} / ${viewer}`,
          );
        }
        assert(
          frames.some((frame) =>
            frame.kind === "output" && frame.output.type === "operation.settled"
          ),
        );
      }
      // A new observer after settlement must get the same policy on replay.
      const replay: ObservationFrame[] = [];
      await client("other-human").operations.observe({
        operationIds: [receipt.operationId],
        onFrame: (frame) => {
          replay.push(frame);
        },
      });
      assertEquals(
        replay.some((frame) => frame.kind === "stream-chunk"),
        policy === "public",
      );
    }
  } finally {
    release();
    await application.close();
    await database.close();
  }
});

Deno.test("Tool terminal feed projection removes every duplicate body envelope", async () => {
  const { projectCoreOutput } = await import("./tool-visibility.ts");
  type Output = Parameters<typeof projectCoreOutput>[0];
  type Read = Parameters<typeof projectCoreOutput>[2];
  const scope = { actor: { id: "human" } } as Parameters<
    typeof projectCoreOutput
  >[1];
  for (const toolStatus of ["completed", "failed", "cancelled"]) {
    const visibility = {
      kind: "tool",
      policy: "requester_only",
      requesterId: "agent",
      initiatorId: "human",
    };
    const safe = {
      id: "result",
      threadId: "thread",
      visibility,
      content: [],
      metadata: {
        toolStatus,
        toolInvocation: { id: "call" },
        copilotzWorkflow: { sourceMessageId: "plan" },
      },
    };
    const unsafe = {
      operation: "create",
      record: { ...safe, content: ["SECRET"] },
      intent: { input: "SECRET" },
      assets: ["SECRET"],
    };
    const output = {
      type: "message.created",
      data: unsafe,
      payload: unsafe,
      delta: "SECRET",
      metadata: { diagnostic: "SECRET" },
    } as unknown as Output;
    const projected = await projectCoreOutput(output, scope, {
      query(_name: string, _query: string, input: Record<string, unknown>) {
        assertEquals(input.viewerParticipantIds, ["human"]);
        return Promise.resolve([safe]);
      },
    } as unknown as Read, () => Promise.resolve([]));
    assert(projected);
    assertEquals(JSON.stringify(projected).includes("SECRET"), false);
    assertEquals(
      (projected as unknown as { data: { record: unknown } }).data.record,
      safe,
    );
  }
  const llm = await projectCoreOutput(
    {
      type: "llm.call.invoked",
      data: { actionRunId: "run", input: "SECRET" },
      payload: { input: "SECRET" },
      delta: "SECRET",
      metadata: {},
    } as unknown as Output,
    scope,
    {} as Read,
    () => Promise.resolve([]),
  );
  assertEquals(JSON.stringify(llm).includes("SECRET"), false);
});
