import assert from "node:assert/strict";
import { test } from "node:test";
import { defineCollection } from "../collections/index.ts";
import { createOwnerTransactionPlanner } from "./transaction.ts";
import type { OwnerCommand, OwnerCommandOutcome } from "./boundary.ts";
import { createOwnerCommandBoundary } from "./boundary.ts";
import { createOwnerCollectionCommand } from "./collections.ts";
import {
  createOwnerConnection,
  createOwnerWorkerCallAdmission,
} from "./connection.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  createCoreSchemaStatements,
  createEventStore,
} from "../events/index.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";
import { createPluginRegistry, definePlugin } from "../plugins/index.ts";
import { createDeliveryExecutor } from "../execution/index.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";

let businessMutations = 0;
const notes = defineCollection({
  name: "note",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      title: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: ["id", "namespace", "title", "createdAt", "updatedAt"],
  } as const,
  commands: {
    rename: {
      mutate({ input }) {
        businessMutations++;
        return { set: { title: String((input as { title: string }).title) } };
      },
    },
  },
});
const identity = {
  ownerId: "owner",
  invocationId: "invocation",
};
const committed: OwnerCommandOutcome = {
  status: "committed",
  result: { recordIds: [], eventIds: [] },
};
function capture() {
  const commands: OwnerCommand[] = [];
  const transaction = createOwnerTransactionPlanner({
    collections: { notes },
    identity,
    execute(command) {
      commands.push(structuredClone(command));
      return Promise.resolve(committed);
    },
  });
  return { commands, transaction };
}

test("planner reserves invocation order, snapshots input, drains unawaited operations and returns only IDs", async () => {
  const f = capture();
  const data = { title: "first" };
  const result = await f.transaction({
    operationKey: "invocation:one",
    execute({ collections }) {
      void collections.notes.create(data);
      data.title = "mutated";
      void collections.notes.create({ title: "second" });
      return 7;
    },
  });
  assert.equal(result.value, 7);
  const operations = (f.commands[0].intent as {
    operations: { input: { id: string; title: string } }[];
  }).operations;
  assert.deepEqual(operations.map((op) => op.input.title), ["first", "second"]);
  assert.notEqual(operations[0].input.id, operations[1].input.id);
  assert.equal(businessMutations, 0);
});

test("planner keeps arbitrary cyclic/function/local credential-like callback returns off the wire", async () => {
  const f = capture();
  const local: { self?: unknown; fn: () => number; localOnly: string } = {
    fn: () => 42,
    localOnly: "fixture-local-secret",
  };
  local.self = local;
  const result = await f.transaction({
    operationKey: "invocation:one",
    async execute({ collections }) {
      assert.deepEqual(
        Object.keys(await collections.notes.create({ title: "one" })),
        ["id"],
      );
      return local;
    },
  });
  assert.equal(result.value, local);
  assert.equal(result.value.fn(), 42);
  assert.equal(
    JSON.stringify(f.commands).includes("fixture-local-secret"),
    false,
  );
});

test("caught registration failure, callback failure and unsupported capabilities never submit", async () => {
  const f = capture();
  await assert.rejects(
    f.transaction({
      operationKey: "invocation:bad",
      async execute({ collections }) {
        await collections.notes.update({ id: "" }).catch(() => undefined);
        return "caught";
      },
    }),
    /record ID/,
  );
  await assert.rejects(
    f.transaction({
      operationKey: "invocation:bad",
      async execute({ collections }) {
        await collections.notes.create({ title: "one" });
        throw new Error("callback failure");
      },
    }),
    /callback failure/,
  );
  await assert.rejects(
    f.transaction({
      operationKey: "invocation:bad",
      execute({ collections }) {
        try {
          (collections.notes as unknown as { get(): void }).get();
        } catch {
          /* A caught unsupported capability still invalidates the plan. */
        }
        return "caught";
      },
    }),
    /not supported/,
  );
  assert.equal(f.commands.length, 0);
});

test("closed contexts and aborted planning cannot register or submit commands", async () => {
  const f = capture();
  let create!: (input: Record<string, unknown>) => Promise<{ id: string }>;
  await f.transaction({
    operationKey: "invocation:one",
    execute({ collections }) {
      create = collections.notes.create;
      return 1;
    },
  });
  await assert.rejects(create({ title: "late" }), /closed/);
  const abort = new AbortController();
  await assert.rejects(
    f.transaction({
      operationKey: "invocation:two",
      signal: abort.signal,
      async execute({ collections }) {
        await collections.notes.create({ title: "discard" });
        abort.abort(new Error("cancelled planning"));
      },
    }),
    /cancelled planning/,
  );
  assert.equal(f.commands.length, 1);
});

for (const mode of ["direct", "encoded"] as const) {
  test(`${mode} command port: replay recomputes local T, preserves owner command semantics and conflicts on whole-plan changes`, async () => {
    const db = await createTestDatabase();
    for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
    await provisionOwnerCommandSchema(db, "public");
    const registry = createPluginRegistry({
      plugins: [
        definePlugin({ id: "planner", version: "1", collections: { notes } }),
      ],
    });
    const store = createEventStore({ session: db });
    const executor = createDeliveryExecutor({
      store,
      registry,
      workerId: "executor",
      createContext: createTestProcessorContext,
    });
    const boundary = createOwnerCommandBoundary({
      session: db,
      schema: "public",
      ownerId: "owner",
      holderId: "holder",
      handlers: {
        collections: createOwnerCollectionCommand({
          session: db,
          schema: "public",
          registry,
          collections: { notes },
          executor,
          scope: () => ({ namespace: "space" }),
        }),
      },
      authorize(_tx, caller, command) {
        assert.ok(
          ["worker", "replacement"].includes(
            caller.principal.kind === "worker" ? caller.principal.workerId : "",
          ),
        );
        assert.ok(command.key.startsWith("invocation:"));
      },
      authenticateReceipt(_tx, caller) {
        assert.ok(
          ["worker", "replacement"].includes(
            caller.principal.kind === "worker" ? caller.principal.workerId : "",
          ),
        );
      },
    });
    const ownerEpoch = await boundary.acquire(0);
    const caller = {
      principal: { kind: "worker" as const, workerId: "worker" },
      ownerEpoch,
    };
    const admission = createOwnerWorkerCallAdmission({
      resolveOwner: () => boundary,
      resolveAssignment: () => ({ ownerId: "owner", ctxGranted: true, caller }),
    });
    const connection = createOwnerConnection({
      ownerId: "owner",
      async callHost(request) {
        const signal = request.signal ?? new AbortController().signal;
        const handler = await admission.admit({
          workload: request.workload,
          metadata: request.metadata ?? {},
          signal,
          fence: {
            identity: {
              workerId: caller.principal.workerId,
              attemptId: "attempt",
              epoch: 1,
            },
            connectionId: "connection",
            sessionGeneration: 1,
          },
          parent: {
            operationId: "operation",
            streamId: "stream",
            workload: "fixture",
            metadata: {},
          },
        });
        assert.ok(handler);
        const body = request.body;
        const input = body instanceof ReadableStream
          ? body
          : new ReadableStream<Uint8Array>({
            start(controller) {
              if (body) controller.enqueue(body);
              controller.close();
            },
          });
        const output = await handler({ input, signal });
        return {
          output: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(output);
              controller.close();
            },
          }),
          completed: Promise.resolve(),
          cancel: () => Promise.resolve(),
        };
      },
    });
    let transaction = createOwnerTransactionPlanner({
      collections: { notes },
      identity,
      execute: mode === "direct"
        ? (command, options) => boundary.execute(caller, command, options)
        : connection.execute,
    });
    const before = businessMutations;
    let callbacks = 0;
    try {
      const run = (title: string, value: unknown) =>
        transaction({
          operationKey: "invocation:plan",
          async execute({ collections }) {
            callbacks++;
            const ref = await collections.notes.create({ title });
            await collections.notes.commands.rename({
              id: ref.id,
              title: "renamed",
            });
            return value;
          },
        });
      const local = () => 1;
      const first = await run("initial", local);
      const duplicate = await run("initial", new Map([["local", 2]]));
      assert.equal(first.value, local);
      assert.ok(duplicate.value instanceof Map);
      assert.equal(first.outcome.status, "committed");
      assert.equal(duplicate.outcome.status, "duplicate");
      assert.deepEqual(first.outcome.result, duplicate.outcome.result);
      assert.equal(businessMutations - before, 1);
      assert.equal(callbacks, 2);
      const eventsBeforeReplacement =
        (await db.query("SELECT id,seq FROM events ORDER BY seq")).rows;
      caller.principal.workerId = "replacement";
      transaction = createOwnerTransactionPlanner({
        collections: { notes },
        identity,
        execute: mode === "direct"
          ? (command, options) => boundary.execute(caller, command, options)
          : connection.execute,
      });
      const replaced = await run("initial", "replacement local return");
      assert.equal(replaced.outcome.status, "duplicate");
      assert.deepEqual(replaced.outcome.result, first.outcome.result);
      assert.equal(businessMutations - before, 1);
      assert.deepEqual(
        (await db.query("SELECT id,seq FROM events ORDER BY seq")).rows,
        eventsBeforeReplacement,
      );
      await assert.rejects(run("changed", null));
      await assert.rejects(
        transaction({
          operationKey: "invocation:plan",
          execute: () => "empty changed plan",
        }),
      );
      assert.equal(
        (await db.query(
          "SELECT data->>'title' title FROM nodes WHERE type='note'",
        )).rows[0].title,
        "renamed",
      );
      assert.equal(
        (await db.query("SELECT key FROM owner_receipts")).rows.length,
        1,
      );
      assert.equal(
        JSON.stringify(
          (await db.query("SELECT intent,result FROM owner_receipts")).rows,
        ).includes("local"),
        false,
      );
    } finally {
      boundary.stop();
      await executor.shutdown();
      await db.close();
    }
  });
}

test("planner rejects unregistered commands, nondata inputs, call options and excess operations before submission", async () => {
  const f = capture();
  await assert.rejects(
    f.transaction({
      operationKey: "invocation:bad",
      async execute({ collections }) {
        await collections.notes.commands.notRegistered({ id: "one" });
      },
    }),
    /not supported/,
  );
  await assert.rejects(
    f.transaction({
      operationKey: "invocation:bad",
      async execute({ collections }) {
        await collections.notes.create({
          title: "one",
          callback: () => 1,
        });
      },
    }),
    /JSON/,
  );
  await assert.rejects(
    f.transaction({
      operationKey: "invocation:bad",
      async execute({ collections }) {
        const create = collections.notes.create as unknown as (
          input: unknown,
          options: unknown,
        ) => Promise<unknown>;
        await create({ title: "one" }, { identity: { workerId: "forged" } });
      },
    }),
    /not supported/,
  );
  const bounded = createOwnerTransactionPlanner({
    collections: { notes },
    identity,
    maxOperations: 1,
    execute() {
      throw new Error("must not submit");
    },
  });
  await assert.rejects(
    bounded({
      operationKey: "invocation:bad",
      async execute({ collections }) {
        await collections.notes.create({ title: "one" });
        await collections.notes.create({ title: "two" });
      },
    }),
    /bound/,
  );
  assert.equal(f.commands.length, 0);
});

test("pre-aborted plans never invoke callbacks; generated references bind stable invocation rather than local result", async () => {
  const f = capture();
  const abort = new AbortController();
  abort.abort(new Error("already cancelled"));
  let callbacks = 0;
  await assert.rejects(
    f.transaction({
      operationKey: "invocation:one",
      signal: abort.signal,
      execute() {
        callbacks++;
      },
    }),
    /already cancelled/,
  );
  assert.equal(callbacks, 0);
  const ids: string[] = [];
  for (const invocationId of ["same", "same", "different"]) {
    const transaction = createOwnerTransactionPlanner({
      collections: { notes },
      identity: { ...identity, invocationId },
      execute: () => Promise.resolve(committed),
    });
    const result = await transaction({
      operationKey: "one",
      execute: ({ collections }) => collections.notes.create({ title: "one" }),
    });
    ids.push(result.value.id);
  }
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[0], ids[2]);
});

test("planner refuses missing or blank required stable identity fields", () => {
  for (
    const invalid of [{}, { ownerId: "owner" }, { ...identity, ownerId: "" }, {
      ...identity,
      invocationId: " ",
    }]
  ) {
    assert.throws(
      () =>
        createOwnerTransactionPlanner({
          collections: { notes },
          identity: invalid as never,
          execute: () => Promise.resolve(committed),
        }),
      /identities are required/,
    );
  }
});

test("generated record IDs require no worker identity across execution replacement", async () => {
  const commands: OwnerCommand[] = [];
  const executionWorkers: string[] = [];
  for (const workerId of ["original", "replacement"]) {
    const transaction = createOwnerTransactionPlanner({
      collections: { notes },
      identity: {
        ownerId: identity.ownerId,
        invocationId: identity.invocationId,
      },
      execute(command) {
        executionWorkers.push(workerId);
        commands.push(command);
        return Promise.resolve(committed);
      },
    });
    await transaction({
      operationKey: "same-invocation/step",
      execute: async ({ collections }) =>
        await collections.notes.create({ title: "same" }),
    });
  }
  assert.deepEqual(commands[0], commands[1]);
  assert.deepEqual(executionWorkers, ["original", "replacement"]);
});
