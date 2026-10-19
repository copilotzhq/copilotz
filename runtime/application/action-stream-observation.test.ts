import { assertEquals, assertExists, assertRejects } from "@std/assert";
import {
  type ActionCallers,
  type ActionContext,
  defineAction,
} from "../actions/index.ts";
import {
  definePlugin,
  defineProcessor,
  type ProcessorContext,
} from "../plugins/index.ts";
import type { ContentStreamWriter, StreamOutput } from "../streams/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createCopilotzApplication } from "./application.ts";

for (const mode of ["immediate", "deferred", "cancelled"] as const) {
  const deferred = mode === "deferred";
  const cancelled = mode === "cancelled";
  Deno.test(
    `application supports ${mode} observation of an Action stream without retaining producer authority`,
    async () => {
      const db = await createTestDatabase({ url: ":memory:" });
      const releaseObservation = Promise.withResolvers<void>();
      const observerStarted = Promise.withResolvers<void>();
      const releaseProducer = Promise.withResolvers<void>();
      let retainedOpen: ActionContext["streams"]["open"] | undefined;
      let retainedAppend: ContentStreamWriter["append"] | undefined;
      let actionEnded = false;
      const acquisitionAfterAction: boolean[] = [];
      const streamAction = defineAction({
        id: "test.observed-action-stream",
        async execute(_input, context) {
          retainedOpen = context.streams.open;
          const writer = await context.streams.open({
            id: "action-stream",
            mediaType: "text/plain",
            role: "output",
          });
          retainedAppend = writer.append;
          // The producer completes immediately; observation must not hold its
          // open capability alive or require it to wait for a future consumer.
          await writer.append({
            appendId: "first",
            bytes: new TextEncoder().encode("runtime "),
          });
          await writer.append({
            appendId: "second",
            bytes: new TextEncoder().encode("ready"),
          });
          if (cancelled) await releaseProducer.promise;
          await writer.close({ assetId: "action-stream-asset" });
          return { completed: true };
        },
      });
      type Context = ProcessorContext<
        ProcessorContext["resources"],
        ProcessorContext["adapters"],
        ActionCallers<{ stream: typeof streamAction }>,
        ProcessorContext["collections"]
      >;
      const application = await createCopilotzApplication({
        database: db,
        namespace: "action-observation",
        databaseSchema: deferred ? "observation_deferred" : "observation_now",
        engine: { retryBaseMs: 0, random: () => 0 },
        plugins: [definePlugin({
          id: "test.action-observation",
          version: "1",
          actions: { stream: streamAction },
          processors: {
            invoke: defineProcessor<Context>({
              id: "test.invoke-observed-action",
              on: [{ eventType: "test.observe-action" }],
              async handle(_event, context) {
                await context.actions.stream({}, { operationKey: "stream" });
                actionEnded = true;
              },
            }),
          },
        })],
      });
      // Gate only the application observer's physical acquisitions, not the
      // producer or owner queue. This makes delayed attachment deterministic.
      const streams = application.engine.streams as {
        follow: typeof application.engine.streams.follow;
      };
      const operations = application.engine.operations as {
        waitForStreamTerminal:
          typeof application.engine.operations.waitForStreamTerminal;
      };
      const follow = streams.follow;
      const terminal = operations.waitForStreamTerminal;
      streams.follow = async (...args) => {
        observerStarted.resolve();
        if (deferred) await releaseObservation.promise;
        acquisitionAfterAction.push(actionEnded);
        return await follow(...args);
      };
      operations.waitForStreamTerminal = async (...args) => {
        if (deferred) await releaseObservation.promise;
        acquisitionAfterAction.push(actionEnded);
        return await terminal(...args);
      };
      try {
        const sent = await application.send({ type: "test.observe-action" });
        const observed = (async () => {
          const outputs: Array<{ body: string; terminal: unknown }> = [];
          for await (const output of sent.outputs) {
            if (output.type !== "stream.output") continue;
            const stream = output as StreamOutput;
            if (cancelled) {
              try {
                await stream.payload.cancel("observer_detached");
              } finally {
                releaseProducer.resolve();
              }
              outputs.push({ body: "", terminal: await stream.terminal });
              continue;
            }
            const [body, status] = await Promise.all([
              new Response(stream.payload).text(),
              stream.terminal,
            ]);
            outputs.push({ body, terminal: status });
          }
          return outputs;
        })();
        // Observe both branches immediately so an actual observation failure
        // is a test assertion failure, never an intentionally dangling promise.
        const observation = Promise.allSettled([observed]);
        await observerStarted.promise;
        await sent.done;
        assertEquals(actionEnded, true);
        releaseObservation.resolve();
        const [outcome] = await observation;
        if (outcome.status === "rejected") throw outcome.reason;
        assertEquals(outcome.value.length, 1);
        assertEquals(outcome.value[0].body, cancelled ? "" : "runtime ready");
        assertEquals(
          (outcome.value[0].terminal as { outcome: string }).outcome,
          "completed",
        );
        assertEquals(acquisitionAfterAction, [deferred, deferred]);
        assertExists(retainedOpen);
        assertExists(retainedAppend);
        await assertRejects(
          async () =>
            await retainedOpen!({ mediaType: "text/plain", role: "output" }),
          Error,
          "owner_assignment_ended",
        );
        await assertRejects(
          async () =>
            await retainedAppend!({
              appendId: "late",
              bytes: new TextEncoder().encode("forbidden"),
            }),
          Error,
          "owner_assignment_ended",
        );
      } finally {
        releaseProducer.resolve();
        releaseObservation.resolve();
        await application.shutdown();
        await db.close();
      }
    },
  );
}
