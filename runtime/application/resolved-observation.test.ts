import { assertEquals, assertExists, assertStrictEquals } from "@std/assert";
import { defineCollection } from "../collections/index.ts";
import type { ResolvedCopilotzEvent } from "../events/index.ts";
import {
  definePlugin,
  defineProcessor,
  type ProcessorContext,
  type ProcessorEvent,
} from "../plugins/index.ts";
import type { ApplicationOutput } from "../streams/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createCopilotzApplication } from "./application.ts";

const NAMESPACE = "resolved-observation";
const SCHEMA = "resolved_observation";

const messageCollection = defineCollection({
  name: "message",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      content: { type: "array", items: { type: "string" } },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: ["id", "namespace", "content", "createdAt", "updatedAt"],
  } as const,
});

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

type MessageCreatedData = Readonly<{
  operation: "create";
  record: Readonly<{
    id: string;
    content: readonly string[];
  }>;
}>;

function messageCreated(
  outputs: readonly ApplicationOutput[],
): ResolvedCopilotzEvent<MessageCreatedData> {
  const output = outputs.find((item) =>
    item.type === "message.created" && "data" in item
  );
  assertExists(output);
  return output as ResolvedCopilotzEvent<MessageCreatedData>;
}

Deno.test("send and observe expose the resolved immutable message.created body", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const processorEvents: ProcessorEvent[] = [];
  const application = await createCopilotzApplication({
    database: db,
    namespace: NAMESPACE,
    databaseSchema: SCHEMA,
    plugins: [definePlugin({
      id: "test.resolved-observation",
      version: "1.0.0",
      collections: { message: messageCollection },
      processors: {
        createMessage: defineProcessor<ProcessorContext>({
          id: "test.resolved-observation.create-message",
          on: [{ eventType: "test.resolved-observation.create-message" }],
          async handle(event, context) {
            if (!event.durable) return;
            await context.collections.message.create({
              id: `message:${event.id}`,
              content: ["hello"],
            }, { operationKey: "create-message" });
          },
        }),
        observeMessage: defineProcessor<ProcessorContext>({
          id: "test.resolved-observation.observe-message",
          on: [{ eventType: "message.created" }],
          handle(event) {
            processorEvents.push(event);
          },
        }),
      },
    })],
    engine: { retryBaseMs: 0, random: () => 0 },
  });
  try {
    const global = (async () => {
      for await (const output of application.observe()) {
        if (output.type === "message.created") return [output];
      }
      return [];
    })();
    const run = await application.send({
      type: "test.resolved-observation.create-message",
    });
    const sentOutputs = collect(run.outputs);
    await run.done;

    const sent = messageCreated(await sentOutputs);
    const observed = messageCreated(await global);
    const processor = processorEvents[0] as ProcessorEvent<MessageCreatedData>;
    assertExists(
      (sent.payload as { dataRef?: { eventBodyId?: string } }).dataRef
        ?.eventBodyId,
    );
    assertEquals(sent.data.operation, "create");
    assertEquals(sent.data.record.content, ["hello"]);
    assertEquals(Object.isFrozen(sent), true);
    assertEquals(Object.isFrozen(sent.data), true);
    assertEquals(Object.isFrozen(sent.data.record), true);
    assertStrictEquals(observed, sent);
    assertEquals(observed.data, sent.data);
    assertEquals(processor.payload, sent.payload);
    assertEquals(processor.data, sent.data);
  } finally {
    await application.shutdown();
    await db.close();
  }
});
