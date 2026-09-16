import { defineServerFacade as fixtureServerFacade } from "@copilotz/copilotz/server";
import { definePlugin as defineFixturePlugin } from "@copilotz/copilotz/plugins";
import { assert, assertEquals } from "@std/assert";
import { type ActionContext, defineAction } from "../runtime/actions/index.ts";
import { definePlugin } from "../runtime/plugins/index.ts";
import { createCopilotzApplication } from "../runtime/application/index.ts";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import { encodeOperationReplayCursor } from "../runtime/streams/cursor.ts";
import { serverPlugin } from "../plugins/server/plugin.ts";
import { createServerFacadeFetchHandler } from "./facade.ts";
import {
  createCopilotzClient,
  type ObservationFrame,
} from "../client/index.ts";

Deno.test("replay retains a stream's source Action context when invocation precedes the checkpoint", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  let release!: () => void;
  const finish = new Promise<void>((resolve) => release = resolve);
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => opened = resolve);
  const application = await createCopilotzApplication({
    database,
    namespace: "origin-test",
    plugins: [
      definePlugin({
        id: "origin-test",
        version: "1",
        actions: {
          stream: defineAction({
            id: "test.origin.stream",
            inputSchema: { type: "object" },
            async execute(_input: unknown, context: ActionContext) {
              const stream = await context.streams.open({
                mediaType: "text/plain",
                role: "tool-output",
              });
              await stream.append({
                bytes: new TextEncoder().encode("progress"),
                appendId: "one",
              });
              opened();
              await finish;
              await stream.close({ assetId: "retained-progress" });
              return "done";
            },
          }),
        },
      }),
      defineFixturePlugin({
        ...serverPlugin,
        resources: {
          server: {
            default: fixtureServerFacade({
              authenticate: () => ({
                actor: { id: "owner" },
                actionMetadata: {
                  copilotzToolAction: {
                    planMessageId: "plan",
                    toolCallId: "reused-provider-id",
                  },
                },
              }),
            }),
          },
        },
      }),
    ],
  });
  const handler = createServerFacadeFetchHandler(application);
  const client = createCopilotzClient({
    baseUrl: "https://test/api",
    fetch: ((url, init) => handler(new Request(url, init))) as typeof fetch,
  });
  try {
    const receipt = await client.actions.submit("test.origin.stream", {}, {
      idempotencyKey: "origin",
    });
    await ready;
    const events = await application.events.list({
      namespace: "origin-test",
      limit: 1000,
    });
    const invocation = events.find((event) =>
      event.type === "test.origin.stream.invoked"
    )!;
    assert(invocation);
    const checkpoint = encodeOperationReplayCursor({
      eventPosition: events.at(-1)!.position,
    });
    const frames: ObservationFrame[] = [];
    await client.operations.observe({
      operationIds: [receipt.operationId],
      checkpoint,
      onFrame(frame) {
        frames.push(frame);
        if (frame.kind === "stream-chunk") release();
      },
    });
    const descriptor = frames.find((frame) =>
      frame.kind === "output" && frame.output.type === "stream.output"
    );
    assert(descriptor?.kind === "output");
    const metadata = descriptor.output.metadata as Record<string, unknown>;
    const source = metadata.sourceAction as {
      actionRunId: string;
      metadata: Record<string, unknown>;
    };
    assertEquals(source.actionRunId, metadata.sourceActionRunId);
    assertEquals(source.metadata.copilotzToolAction, {
      planMessageId: "plan",
      toolCallId: "reused-provider-id",
    });
    assert(
      !frames.some((frame) =>
        frame.kind === "output" && frame.output.id === invocation.id
      ),
    );
    assertEquals(await client.operations.result(receipt.operationId), "done");
  } finally {
    release();
    await application.close();
    await database.close();
  }
});

Deno.test("stream origin cache remains bounded without limiting a long run's Action count", async () => {
  const { createStreamOriginResolver } = await import("./stream-origin.ts");
  type Runtime = Parameters<typeof createStreamOriginResolver>[0];
  let reads = 0;
  const runtime = {
    operations: {
      listEventIds: ({ operationId }: { operationId: string }) =>
        Promise.resolve([{ eventId: operationId, position: "1" }]),
    },
    events: {
      get: (_namespace: string, id: string) =>
        Promise.resolve({ subject: { id }, type: "test.invoked" }),
      resolve: (_namespace: string, id: string) => {
        reads++;
        return Promise.resolve({
          data: { actionRunId: id, metadata: { safe: true } },
        });
      },
    },
  } as unknown as Runtime;
  const resolve = createStreamOriginResolver(
    runtime,
    "tenant",
    new AbortController().signal,
  );
  for (let index = 0; index <= 300; index++) {
    const run = index === 300 ? "run-0" : `run-${index}`;
    const stream = {
      metadata: { sourceActionRunId: run },
    } as unknown as Parameters<
      typeof resolve
    >[1];
    assertEquals((await resolve(run, stream)).metadata.sourceAction, {
      actionRunId: run,
      metadata: { safe: true },
    });
  }
  assertEquals(reads, 301);
});
