import { assert, assertEquals } from "@std/assert";

import {
  type CollectionRecord,
  createCollectionRuntime,
  defineCollection,
  isCollectionNoop,
  relation,
} from "./index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
import {
  createCoreSchemaStatements,
  createEventCoordinator,
  createEventStore,
  createSqlSession,
} from "../events/index.ts";
import { createDeliveryExecutor } from "../execution/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
} from "../plugins/index.ts";

const NOW = "2026-08-17T22:00:00.000Z";
const NAMESPACE = "phase-5";

const jobDefinition = defineCollection({
  name: "job",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      status: { type: "string" },
      title: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: ["id", "namespace", "status", "title", "createdAt", "updatedAt"],
  } as const,
  defaults: { status: "open" },
});

const jobNoteDefinition = defineCollection({
  name: "job_note",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      jobId: { type: "string" },
      text: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: ["id", "namespace", "jobId", "text", "createdAt", "updatedAt"],
  } as const,
  relations: {
    job: relation.belongsTo("job", "jobId", "job_notes"),
  },
});

Deno.test("static processor uses frozen event body and captures input in a child event", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  const schema = "phase_5_authority";
  for (const statement of createCoreSchemaStatements(schema)) {
    await session.query(statement);
  }
  const store = createEventStore({ session, schema });
  const seen: Array<Readonly<{ title: string; fetched: boolean }>> = [];
  const sideEffects: string[] = [];
  let runtime: ReturnType<typeof createCollectionRuntime> | undefined;
  const processor = defineProcessor({
    id: "job.capture-external",
    on: [{
      eventType: "job.created",
      data: { operation: "create", record: { status: "open" } },
    }],
    async handle(event, context) {
      const body = event.data as {
        operation: string;
        record: CollectionRecord;
      };
      seen.push({
        title: String(body.record.title),
        fetched: Object.hasOwn(context, "jobs"),
      });
      await context.transaction(
        async ({ collections }) => {
          await collections.job_note.create({
            id: `note:${body.record.id}`,
            jobId: body.record.id,
            text: JSON.stringify({
              source: "external",
              title: body.record.title,
            }),
          });
        },
        { operationKey: `job-note:${body.record.id}` },
      );
      sideEffects.push(String(body.record.title));
    },
  });
  const ignored = defineProcessor({
    id: "job.ignore-closed",
    on: [{
      eventType: "job.created",
      data: { operation: "create", record: { status: "closed" } },
    }],
    handle() {
      throw new Error("closed matcher must not run");
    },
  });
  const registry = await createPluginRegistry({
    plugins: [definePlugin({
      id: "test.phase-5",
      version: "1.0.0",
      processors: { observer: processor, ignored },
    })],
  });
  const executor = createDeliveryExecutor({
    store,
    registry,
    workerId: "phase-5-authority",
    createContext: (base) => {
      const context = createTestProcessorContext(base);
      const collections = runtime!.withScope({
        namespace: base.event.namespace,
        createMutationIdentity: base.createMutationIdentity,
      });
      const transaction: typeof context.transaction = async (
        execute,
        options = {},
      ) => {
        const operationKey = options.operationKey?.trim() ||
          `processor:${base.idempotencyKey}`;
        const result = await runtime!.transaction({
          operationKey,
          namespace: base.event.namespace,
          identity: base.createMutationIdentity(
            operationKey,
            options.identity?.metadata as Record<string, unknown> | undefined,
          ),
          execute: async ({ collections, relations }) =>
            await execute(Object.freeze({
              collections,
              relations,
            })),
        });
        return result.value;
      };
      return Object.freeze({
        ...context,
        collections,
        transaction,
      });
    },
  });
  const coordinator = createEventCoordinator({ store, registry, executor });
  let nextId = 0;
  runtime = createCollectionRuntime({
    coordinator,
    session,
    eventStore: store,
    createId: () => `phase-5-${++nextId}`,
    now: () => new Date(NOW),
  });
  const jobs = runtime.bind(jobDefinition);
  const notes = runtime.bind(jobNoteDefinition);
  try {
    const created = await runtime.transaction({
      operationKey: "job-create-update",
      namespace: NAMESPACE,
      execute: async ({ collections }) => {
        const job = await collections.job.create({
          id: "job-a",
          title: "original",
        });
        await collections.job.update({
          id: "job-a",
          set: { title: "later" },
        });
        return job;
      },
    });
    await Promise.all(created.dispatch.handles.map((handle) => handle.done));
    const mutation = created.writes[0];
    assertEquals(isCollectionNoop(mutation), false);
    if (isCollectionNoop(mutation)) throw new Error("expected job.created");
    assertEquals(
      mutation.deliveries.map((item) => item.consumerId),
      ["processor:job.capture-external"],
    );
    const note = await notes.get("note:job-a", NAMESPACE);
    assert(note);
    assertEquals(JSON.parse(String(note.text)), {
      source: "external",
      title: "original",
    });
    assertEquals(seen, [{ title: "original", fetched: false }]);
    assertEquals(sideEffects, ["original"]);
    assertEquals((await jobs.get("job-a", NAMESPACE))?.title, "later");
  } finally {
    await executor.shutdown();
    await db.close();
  }
});
