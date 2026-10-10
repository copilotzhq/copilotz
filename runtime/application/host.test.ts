import { defineServerFacade, serverPlugin } from "../../server/index.ts";
import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import {
  type ActionContext,
  type ApplicationOutput,
  type CopilotzApplication,
  createCopilotz as createTypedCopilotz,
  type CreateCopilotzOptions,
  defineAction,
  defineCollection,
  definePlugin,
  isStreamOutput,
  relation,
} from "../../index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";

// Erase composition types only in runtime tests that intentionally pass invalid input.
const createCopilotz = createTypedCopilotz as (
  options: Exclude<CreateCopilotzOptions, { role: "worker" }>,
) => Promise<
  CopilotzApplication & { fetch(request: Request): Promise<Response> }
>;

const note = defineCollection({
  name: "host_note",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      text: { type: "string", minLength: 1 },
      count: { type: "integer" },
    },
    required: ["text", "count"],
  } as const,
  defaults: { count: 0 },
  search: { enabled: true, fields: ["text"] },
  queries: {
    byText: {
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      } as const,
      filter: ({ input }) => ({ text: input.text }),
    },
  },
  commands: {
    increment: {
      event: "host_note.incremented",
      input: { type: "object", additionalProperties: false },
      mutate: ({ current }) => ({ set: { count: Number(current.count) + 1 } }),
    },
  },
});

function fixture() {
  let calls = 0;
  const metadata: unknown[] = [];
  const echo = defineAction({
    id: "host.echo",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    } as const,
    async execute(input: { value: string }, context: ActionContext) {
      calls++;
      metadata.push(context.action.metadata);
      if (input.value === "fail") {
        throw Object.assign(new Error("Card 'x' is not on this board."), {
          name: "BoardError",
          code: "card_not_on_board",
        });
      }
      return { echoed: input.value, namespace: context.namespace };
    },
  });
  return {
    plugin: definePlugin({
      id: "host.fixture",
      version: "1",
      actions: { echo },
      collections: { notes: note },
    }),
    calls: () => calls,
    metadata,
  };
}

async function history(
  app: CopilotzApplication,
  operationId: string,
): Promise<ApplicationOutput[]> {
  const attachment = await app.attach({ operationId });
  const outputs: ApplicationOutput[] = [];
  for await (const output of attachment.outputs) {
    if (isStreamOutput(output)) await output.payload.cancel();
    outputs.push(output);
  }
  await attachment.done;
  await attachment.drained;
  return outputs;
}

Deno.test("host maps enumerate exactly the caller-facing aliases, including with the Server plugin", async () => {
  const f = fixture();
  const dependency = definePlugin({
    id: "host.dependency",
    version: "1",
    actions: {
      nestedEcho: defineAction({ id: "host.nested", execute: () => null }),
    },
    collections: {
      nestedNotes: defineCollection({
        name: "host_nested_note",
        schema: { type: "object" },
      }),
    },
  });
  const plugin = definePlugin({
    id: "host.parent",
    version: "1",
    plugins: [dependency, f.plugin],
  });
  for (const plugins of [[plugin], [plugin, serverPlugin]]) {
    const app = await createCopilotz({
      namespace: "host",
      plugins,
      actions: {
        directEcho: defineAction({ id: "host.direct", execute: () => null }),
      },
      collections: {
        directNotes: defineCollection({
          name: "host_direct_note",
          schema: { type: "object" },
        }),
      },
    });
    try {
      assertEquals(Object.keys(app.actions).sort(), [
        "directEcho",
        "echo",
        "nestedEcho",
      ]);
      assertEquals(Object.keys(app.collections).sort(), [
        "directNotes",
        "nestedNotes",
        "notes",
      ]);
      assertEquals(Object.getPrototypeOf(app.actions), null);
      assertEquals(Object.getPrototypeOf(app.collections), null);
      assertEquals(app.actions.serverInvoke, undefined);
      assertEquals(app.actions["host.echo"], undefined);
      assertEquals(app.collections.host_note, undefined);
      assertEquals(Object.keys(app.collections.notes.commands), ["increment"]);
      assertEquals(Object.keys(app.collections.notes.queries), ["byText"]);
      assertEquals(app.collections.notes.commands["constructor"], undefined);
      assertEquals(app.collections.notes.queries["constructor"], undefined);
      assertEquals(await app.listOperations(), []);
    } finally {
      await app.close();
    }
  }
});

Deno.test("host Action call validates before admission, records lifecycle and replays its output and metadata", async () => {
  const f = fixture();
  const app = await createCopilotz({ namespace: "host", plugins: [f.plugin] });
  try {
    await assertRejects(
      () => app.actions.echo({ value: 1 }),
      TypeError,
      "schema validation",
    );
    await assertRejects(
      async () => app.actions.missing({}),
      TypeError,
    );
    await assertRejects(
      async () => app.actions["constructor"]({}),
      TypeError,
    );
    assertEquals(await app.listOperations(), []);
    assertEquals(f.calls(), 0);
    const options = {
      idempotencyKey: "echo-one",
      actionMetadata: { origin: "admin", nested: { value: 1 } },
      operationMetadata: { task: "echo-one" },
      metadata: { source: "host-test" },
      correlationId: "host-correlation",
      causationId: "host-cause",
    };
    const output = { echoed: "hello", namespace: "host" };
    assertEquals(await app.actions.echo({ value: "hello" }, options), output);
    assertEquals(await app.actions.echo({ value: "hello" }, options), output);
    assertEquals(f.calls(), 1);
    assertEquals(f.metadata, [{
      ...options.actionMetadata,
      copilotzServer: {
        schema: "copilotz.server.action.v1",
        requestId: "host:echo-one",
        actionAlias: "echo",
      },
    }]);
    const operations = await app.listOperations({
      metadata: { task: "echo-one" },
    });
    assertEquals(operations.length, 1);
    assertEquals(operations[0].state, "completed");
    const outputs = await history(app, operations[0].operationId);
    const request = outputs.find((output) =>
      output.type === "copilotz.server.action.requested"
    );
    assertExists(request);
    assert(!isStreamOutput(request));
    assertEquals(request.correlationId, options.correlationId);
    assertEquals(request.causationId, options.causationId);
    assertEquals(request.metadata.source, "host-test");
    const events = outputs.filter((
      event,
    ) => event.type.startsWith("host.echo."));
    assertEquals(events.map((event) => event.type), [
      "host.echo.invoked",
      "host.echo.completed",
    ]);
    for (const event of events) {
      assert(!isStreamOutput(event));
      assertEquals(
        (event.data as { metadata: unknown }).metadata,
        f.metadata[0],
      );
    }
    await assertRejects(
      () => app.actions.echo({ value: "changed" }, options),
      Error,
      "different data",
    );
    assertEquals(f.calls(), 1);
  } finally {
    await app.close();
  }
});

Deno.test("host Action call restores a recorded failure without executing again", async () => {
  const f = fixture();
  const app = await createCopilotz({ namespace: "host", plugins: [f.plugin] });
  try {
    for (let i = 0; i < 2; i++) {
      const error = await assertRejects(
        () => app.actions.echo({ value: "fail" }, { idempotencyKey: "failed" }),
        Error,
        "Card 'x' is not on this board.",
      );
      assertEquals(error.name, "BoardError");
      assertEquals(
        (error as Error & { code: string }).code,
        "card_not_on_board",
      );
    }
    assertEquals(f.calls(), 1);
    const [operation] = await app.listOperations();
    const events = await history(app, operation.operationId);
    assertEquals(
      events.filter((event) => event.type === "host.echo.failed").length,
      1,
    );
  } finally {
    await app.close();
  }
});

Deno.test("host collection writes emit one Event per operation and replay immutable results", async () => {
  const app = await createCopilotz({
    namespace: "host",
    collections: { notes: note },
  });
  try {
    const created = await app.collections.notes.create({ text: "first" }, {
      idempotencyKey: "create",
    });
    assertEquals(created.count, 0);
    assertEquals(
      await app.collections.notes.create({ text: "first" }, {
        idempotencyKey: "create",
      }),
      created,
    );
    const updated = await app.collections.notes.update({
      id: created.id,
      set: { text: "second" },
    }, { idempotencyKey: "update" });
    assertEquals(updated.text, "second");
    assertEquals(
      await app.collections.notes.update({
        id: created.id,
        set: { text: "second" },
      }, { idempotencyKey: "update" }),
      updated,
    );
    const command = await app.collections.notes.commands.increment({
      id: created.id,
    }, { idempotencyKey: "command" });
    assertEquals(command.count, 1);
    assertEquals(
      await app.collections.notes.commands.increment({ id: created.id }, {
        idempotencyKey: "command",
      }),
      command,
    );
    assertEquals(await app.collections.notes.get({ id: created.id }), command);
    assertEquals(
      await app.collections.notes.list({ where: { text: "second" } }),
      [command],
    );
    assertEquals(
      await app.collections.notes.queries.byText({ text: "second" }),
      [
        command,
      ],
    );
    assertEquals(
      await app.collections.notes.aggregate({
        metrics: { count: { op: "count" } },
      }),
      [{ count: 1 }],
    );
    assertEquals(await app.collections.notes.search({ text: "second" }), [
      command,
    ]);
    assertEquals(await app.collections.notes.relations.list(), []);
    assertEquals(app.collections.notes.definition.name, "host_note");
    assertEquals((await app.listOperations()).length, 3);
    const deleted = { id: created.id, deleted: true };
    assertEquals(
      await app.collections.notes.delete({ id: created.id }, {
        idempotencyKey: "delete",
      }),
      deleted,
    );
    assertEquals(
      await app.collections.notes.delete({ id: created.id }, {
        idempotencyKey: "delete",
      }),
      deleted,
    );
    assertEquals(await app.collections.notes.get({ id: created.id }), null);
    assertEquals(await app.collections.notes.list(), []);
    // Recovery comes from immutable mutation Events even after the projection was deleted.
    assertEquals(
      await app.collections.notes.create({ text: "first" }, {
        idempotencyKey: "create",
      }),
      created,
    );
    const operations = await app.listOperations();
    assertEquals(operations.length, 4);
    const mutations: string[] = [];
    for (const operation of operations) {
      assertEquals(operation.state, "completed");
      const events = (await history(app, operation.operationId)).filter((
        event,
      ) => event.type.startsWith("host_note."));
      assertEquals(events.length, 1);
      mutations.push(events[0].type);
    }
    assertEquals(mutations.sort(), [
      "host_note.created",
      "host_note.deleted",
      "host_note.incremented",
      "host_note.updated",
    ]);
  } finally {
    await app.close();
  }
});

Deno.test("host writes and named reads enforce schemas and reject unknown targets", async () => {
  const app = await createCopilotz({
    namespace: "host",
    collections: { notes: note },
  });
  try {
    await assertRejects(
      () => app.collections.notes.create({ text: 1 }),
      TypeError,
      "schema validation",
    );
    await assertRejects(
      () =>
        app.collections.notes.update({ id: "one", set: { count: "wrong" } }),
      TypeError,
      "schema validation",
    );
    await assertRejects(
      () =>
        app.collections.notes.commands.increment({ id: "one", extra: true }),
      TypeError,
      "schema validation",
    );
    await assertRejects(
      () => app.collections.notes.delete({ id: "" }),
      TypeError,
      "Record id",
    );
    await assertRejects(
      async () => app.collections.absent.create({}),
      TypeError,
    );
    await assertRejects(
      async () => app.collections.notes.commands.absent({ id: "one" }),
      TypeError,
    );
    await assertRejects(
      async () => app.collections.absent.get({ id: "one" }),
      TypeError,
    );
    await assertRejects(
      async () => app.collections.notes.queries.absent(),
      TypeError,
    );
    await assertRejects(
      () => app.collections.notes.queries.byText({ text: 1 }),
      TypeError,
      "schema validation",
    );
    assertEquals(await app.listOperations(), []);
    const stored = await app.collections.notes.create({ text: "kept" });
    // Patch validation alone cannot catch a missing required field in the final record.
    const finalRecordError = await assertRejects(
      () => app.collections.notes.update({ id: stored.id, unset: ["text"] }),
      Error,
      "schema validation",
    );
    assertEquals(
      (finalRecordError as Error & { code: string }).code,
      "collection_validation_failed",
    );
    assert(!finalRecordError.message.includes("Settlement scope"));
    assert(!finalRecordError.message.includes("dead-lettered"));
    assertEquals(await app.collections.notes.get({ id: stored.id }), stored);
    const failed = (await app.listOperations()).find((operation) =>
      operation.state === "failed"
    );
    assertExists(failed);
    assertEquals(
      (await history(app, failed.operationId)).filter((event) =>
        event.type === "host_note.updated"
      ),
      [],
    );
  } finally {
    await app.close();
  }
});

Deno.test("host calls isolate namespaces and replay after application restart", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  const f = fixture();
  const options = { database, namespace: "a", plugins: [f.plugin] };
  let app = await createCopilotz(options);
  try {
    const created = await app.collections.notes.create(
      { id: "one", text: "a" },
      {
        idempotencyKey: "same",
      },
    );
    await app.collections.notes.create({ id: "two", text: "b" }, {
      namespace: "b",
      idempotencyKey: "same",
    });
    assertEquals((await app.collections.notes.get({ id: "one" }))?.text, "a");
    assertEquals(
      (await app.collections.notes.get({ id: "two" }, { namespace: "b" }))
        ?.text,
      "b",
    );
    assertEquals(
      await app.collections.notes.get({ id: "one" }, { namespace: "b" }),
      null,
    );
    assertEquals(await app.collections.notes.get({ id: "two" }), null);
    const invoked = await app.actions.echo({ value: "hello" }, {
      namespace: "b",
      idempotencyKey: "echo",
    });
    assertEquals(invoked, { echoed: "hello", namespace: "b" });
    await app.close();
    app = await createCopilotz(options);
    assertEquals(
      await app.collections.notes.create({ id: "one", text: "a" }, {
        idempotencyKey: "same",
      }),
      created,
    );
    assertEquals(
      await app.actions.echo({ value: "hello" }, {
        namespace: "b",
        idempotencyKey: "echo",
      }),
      invoked,
    );
    assertEquals(f.calls(), 1);
  } finally {
    await app.close();
    await database.close();
  }
});

Deno.test("Gateway host API dispatches Actions and mutations to a Worker", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  const gatewayFixture = fixture();
  const workerFixture = fixture();
  const transport = {
    type: "in-process",
    config: { topic: `host.${crypto.randomUUID()}` },
  } as const;
  const gateway = await createCopilotz({
    role: "gateway",
    namespace: "split",
    database,
    plugins: [gatewayFixture.plugin],
    transports: [transport],
    target: { workerId: "host-worker" },
  });
  const worker = await createTypedCopilotz({
    role: "worker",
    namespace: "split",
    database,
    plugins: [workerFixture.plugin],
    transport,
    id: "host-worker",
  });
  try {
    await worker.ready;
    assertEquals(Object.keys(gateway.actions), ["echo"]);
    assertEquals(Object.keys(gateway.collections), ["notes"]);
    assertEquals(await gateway.actions.echo({ value: "remote" }), {
      echoed: "remote",
      namespace: "split",
    });
    assertEquals(gatewayFixture.calls(), 0);
    assertEquals(workerFixture.calls(), 1);
    const created = await gateway.collections.notes.create({ text: "remote" }, {
      idempotencyKey: "remote",
    });
    assertEquals(
      await gateway.collections.notes.get({ id: created.id }),
      created,
    );
    assertEquals(
      await gateway.collections.notes.create({ text: "remote" }, {
        idempotencyKey: "remote",
      }),
      created,
    );
    assertEquals(Object.keys(worker).sort(), ["close", "closed", "ready"]);
  } finally {
    await worker.close();
    await gateway.close();
    await database.close();
  }
});

Deno.test("host calls select physical schemas without leaking reads or idempotency identities", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  const f = fixture();
  const other = await createCopilotz({
    namespace: "host",
    databaseSchema: "host_other",
    database,
    plugins: [f.plugin],
  });
  const app = await createCopilotz({
    namespace: "host",
    database,
    plugins: [f.plugin],
  });
  try {
    const first = await app.collections.notes.create({
      id: "one",
      text: "default",
    }, { idempotencyKey: "same" });
    const second = await app.collections.notes.create({
      id: "one",
      text: "other",
    }, { databaseSchema: "host_other", idempotencyKey: "same" });
    assertEquals(await app.collections.notes.get({ id: "one" }), first);
    assertEquals(
      await app.collections.notes.get({ id: "one" }, {
        databaseSchema: "host_other",
      }),
      second,
    );
    assertEquals(await other.collections.notes.get({ id: "one" }), second);
    await app.actions.echo({ value: "other" }, {
      databaseSchema: "host_other",
      idempotencyKey: "same-action",
    });
    assertEquals((await app.listOperations()).length, 1);
    assertEquals((await other.listOperations()).length, 2);
  } finally {
    await app.close();
    await other.close();
    await database.close();
  }
});

Deno.test("host APIs require a namespace and concurrent identical invocations share one outcome", async () => {
  const f = fixture();
  const app = await createCopilotz({ plugins: [f.plugin] });
  try {
    await assertRejects(
      () => app.actions.echo({ value: "one" }),
      TypeError,
      "namespace",
    );
    await assertRejects(
      () => app.collections.notes.list(),
      TypeError,
      "namespace",
    );
    await assertRejects(
      () => app.collections.notes.create({ text: "one" }),
      TypeError,
      "namespace",
    );
    const call = () =>
      app.actions.echo({ value: "one" }, {
        namespace: "explicit",
        idempotencyKey: "concurrent",
      });
    const values = await Promise.all([call(), call()]);
    assertEquals(values[0], values[1]);
    assertEquals(f.calls(), 1);
  } finally {
    await app.close();
  }
});

Deno.test("host and HTTP calls keep distinct outcomes when keys and correlations match", async () => {
  const f = fixture();
  let authorized = 0;
  const app = await createCopilotz({
    namespace: "host",
    plugins: [f.plugin, serverPlugin],
    resources: {
      server: {
        default: defineServerFacade({
          expose: { actions: { include: ["host.echo"] } },
          authorize() {
            authorized++;
            return {};
          },
        }),
      },
    },
  });
  try {
    const response = await app.fetch(
      new Request("https://example.test/api/actions/host/echo", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "shared-key",
          "x-copilotz-correlation-id": "shared-correlation",
        },
        body: JSON.stringify({ value: "http" }),
      }),
    );
    assertEquals(response.status, 202);
    const receipt = await response.json();
    // Fetch wraps successful response data in its public envelope.
    const operationId = receipt.data.operationId;
    const attachment = await app.attach({ operationId });
    for await (const output of attachment.outputs) {
      if (isStreamOutput(output)) await output.payload.cancel();
    }
    await attachment.done;
    await attachment.drained;
    const beforeHost = authorized;
    const options = {
      idempotencyKey: "shared-key",
      correlationId: "shared-correlation",
    };
    const expected = { echoed: "host", namespace: "host" };
    assertEquals(
      await app.actions.echo({ value: "host" }, options),
      expected,
    );
    assertEquals(
      await app.actions.echo({ value: "host" }, options),
      expected,
    );
    const record = await app.collections.notes.create({ text: "trusted" });
    assertEquals(await app.collections.notes.get({ id: record.id }), record);
    assertEquals(authorized, beforeHost);
    assertEquals(f.calls(), 2);
  } finally {
    await app.close();
  }
});

Deno.test("host reads forward content selection and cancellation in the selected namespace", async () => {
  const app = await createCopilotz({
    namespace: "default",
    collections: {
      documents: defineCollection({
        name: "host_document",
        schema: {
          type: "object",
          properties: { title: { type: "string" }, body: {} },
          required: ["title", "body"],
        },
        content: { fields: ["body"] },
        search: { enabled: true, fields: ["title"] },
      }),
    },
  });
  try {
    const stored = await app.collections.documents.create({
      title: "hello",
      body: "Host body",
    }, { namespace: "selected" });
    const options = { namespace: "selected", content: { fields: ["body"] } };
    const resolved = await app.collections.documents.get(
      { id: stored.id },
      options,
    );
    assertExists(resolved);
    assertEquals((resolved.body as { value: string }[])[0].value, "Host body");
    assertEquals(await app.collections.documents.list(undefined, options), [
      resolved,
    ]);
    assertEquals(
      await app.collections.documents.search({ text: "hello" }, options),
      [resolved],
    );
    assertEquals(await app.collections.documents.get({ id: stored.id }), null);
    await assertRejects(
      () =>
        app.collections.documents.get({ id: stored.id }, {
          ...options,
          signal: AbortSignal.abort(new Error("host read cancelled")),
        }),
      Error,
      "host read cancelled",
    );
    assertEquals(
      (await app.listOperations({ namespace: "selected" })).length,
      1,
    );
    assertEquals(await app.listOperations(), []);
  } finally {
    await app.close();
  }
});

Deno.test("host Collection validation failures are plain, coded and replayable after restart", async () => {
  const database = await createTestDatabase({ url: ":memory:" });
  const options = {
    namespace: "host-validation",
    database,
    collections: {
      space: defineCollection({ name: "space", schema: { type: "object" } }),
      card: defineCollection({
        name: "card",
        schema: {
          type: "object",
          properties: {
            spaceId: { type: "string" },
            title: { type: "string" },
          },
          required: ["spaceId", "title"],
        } as const,
        relations: { space: relation.belongsTo("space", "spaceId") },
      }),
    },
  };
  let app = await createCopilotz(options);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      for (
        const [key, input, message] of [
          ["schema", { spaceId: "nowhere", title: 42 }, "schema validation"],
          [
            "relation",
            { spaceId: "nowhere", title: "card" },
            "Relation 'space' references missing space 'nowhere'.",
          ],
        ] as const
      ) {
        const error = await assertRejects(
          () => app.collections.card.create(input, { idempotencyKey: key }),
          TypeError,
          message,
        );
        assertEquals(error.name, "CollectionValidationError");
        assertEquals(
          (error as Error & { code: string }).code,
          "collection_validation_failed",
        );
        assert(!error.message.includes("Settlement scope"));
        assert(!error.message.includes("dead-lettered"));
      }
      assertEquals(await app.collections.card.list(), []);
      const operations = await app.listOperations();
      assertEquals(operations.length, 1);
      assertEquals(
        (await history(app, operations[0].operationId)).filter((event) =>
          event.type === "card.created"
        ),
        [],
      );
      if (attempt === 0) {
        await app.close();
        app = await createCopilotz(options);
      }
    }
  } finally {
    await app.close();
    await database.close();
  }
});
