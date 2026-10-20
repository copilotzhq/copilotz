import { defineProcessor } from "../plugins/processor.ts";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createCopilotz } from "../../create-copilotz.ts";
import { createCopilotzApplication } from "../application/application.ts";
import { defineAction } from "../actions/define.ts";
import { defineCollection } from "../collections/definition.ts";
import { createOwnerTestDatabase } from "../testing/owner-database.ts";
import { testAuthority } from "../testing/authority.ts";
import { withRetainedAuthority } from "./binding.ts";
import {
  authorizationRefused,
  createOwnerEvaluator,
  type OwnerAuthorization,
} from "./evaluator.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import {
  defineServerFacade,
  serverPlugin,
} from "../../plugins/server/index.ts";
import { createHttpAdapter } from "../../plugins/server/authoring/http-adapter/index.ts";
import { createCoreHttpAdapter } from "../../plugins/core-http/adapters/http/core/index.ts";
import { createServerFacadeFetchHandler } from "../../server/facade.ts";
import type { ServerConstraints } from "./contracts.ts";

const notes = defineCollection({ name: "note", schema: { type: "object" } });
const reference = { id: "fixture", revision: "1" };
const restricted = <T>(id: string, run: () => Promise<T>) =>
  withRetainedAuthority(
    testAuthority("public", "space", id),
    new AbortController().signal,
    run,
  );

Deno.test("F4 ambient Action and HTTP host calls retain caller grants; top-level host remains trusted", async () => {
  const database = await createOwnerTestDatabase();
  let executions = 0;
  const app = await createCopilotz({
    database,
    namespace: "space",
    collections: { notes },
    actions: {
      start: defineAction({
        id: "notes.start",
        execute: (
          input: { id: string },
          context: import("../actions/types.ts").ActionContext,
        ) =>
          context.operations.start({
            action: "write",
            input,
            operationKey: input.id,
          }),
      }),
      write: defineAction({
        id: "notes.write",
        execute: (input: { id: string }) => write(input.id),
      }),
      parent: defineAction({
        id: "notes.parent",
        execute: (input: { id: string }) => callChild(input.id),
      }),
      child: defineAction({
        id: "notes.child",
        execute: () => {
          executions++;
          return "child";
        },
      }),
    },
    plugins: [serverPlugin],
    resources: {
      server: {
        default: defineServerFacade({
          expose: { actions: false, collections: false, channels: false },
          authenticate: (request) => ({
            authority: testAuthority(
              "public",
              "space",
              request.headers.get("member") ?? "denied",
            ),
          }),
        }),
      },
    },
    adapters: {
      http: {
        notes: createHttpAdapter({
          routes: [{
            id: "notes.route",
            method: "POST",
            path: "/write",
            handler: (context) => write((context.input as { id: string }).id),
          }],
        }),
      },
    },
    authorization: {
      policies: {
        fixture: {
          revision: "1",
          sources: [],
          evaluate({ authority, intent }) {
            if (
              intent.kind === "collection" &&
              authority.principal.id !== "writer"
            ) authorizationRefused();
            return {
              actions: {
                start: {},
                write: {},
                parent: {},
                ...(authority.principal.id === "writer" ? { child: {} } : {}),
              },
              collections: { notes: {} },
              collectionMutations: { notes: { create: {} } },
              operations: { metadata: {} },
            };
          },
        },
      },
      collections: { notes: reference },
      actions: {
        start: reference,
        write: reference,
        parent: reference,
        child: reference,
      },
    },
  });
  const write: (id: string) => Promise<unknown> = (id) =>
    app.collections.notes.create({ id });
  const callChild: (id: string) => Promise<unknown> = (id) =>
    app.actions.child({ id });
  try {
    const denied = await assertRejects(() =>
      restricted("denied", () => app.actions.write({ id: "denied-action" }))
    );
    assertEquals((denied as { code: string }).code, "forbidden");
    await restricted(
      "writer",
      () => app.actions.write({ id: "allowed-action" }),
    );
    await assertRejects(() =>
      restricted("denied", () => app.actions.parent({ id: "denied-child" }))
    );
    assertEquals(executions, 0);
    assertEquals(
      await restricted(
        "writer",
        () => app.actions.parent({ id: "allowed-child" }),
      ),
      "child",
    );
    for (const member of ["denied", "writer"]) {
      const response = await app.fetch(
        new Request("https://test/api/write", {
          method: "POST",
          headers: { "content-type": "application/json", member },
          body: JSON.stringify({ id: `${member}-route` }),
        }),
      );
      assertEquals(response.status, member === "writer" ? 200 : 403);
    }
    for (const member of ["denied", "writer"]) {
      const operationId = await restricted(
        member,
        () => app.actions.start({ id: `${member}-producer` }),
      );
      const handle = await app.attach({ operationId });
      try {
        if (member === "writer") await handle.done;
        else await handle.done.catch(() => undefined);
      } finally {
        await handle.detach();
      }
    }
    await app.actions.write({ id: "host-action" });
    await app.actions.child({});
    await app.collections.notes.create({ id: "host-direct" });
    assertEquals(executions, 2);
    assertEquals(
      (await app.collections.notes.list()).map((note) => note.id).sort(),
      [
        "allowed-action",
        "host-action",
        "host-direct",
        "writer-producer",
        "writer-route",
      ],
    );
  } finally {
    await app.close();
    await database.close();
  }
});

Deno.test("F4 unbound Collections refuse authenticated reads and writes, while host reads and writes work", async () => {
  const database = await createOwnerTestDatabase();
  const app = await createCopilotz({
    database,
    namespace: "space",
    collections: { notes },
  });
  try {
    await app.collections.notes.create({ id: "host" });
    for (
      const work of [
        () => app.collections.notes.list(),
        () => app.collections.notes.get({ id: "host" }),
        () => app.collections.notes.create({ id: "denied" }),
        () =>
          app.collections.notes.update({
            id: "host",
            set: { title: "denied" },
          }),
        () => app.collections.notes.delete({ id: "host" }),
      ]
    ) {
      const error = await assertRejects(() =>
        restricted<unknown>("denied", work)
      );
      assertEquals((error as { code: string }).code, "forbidden");
    }
    assertEquals((await app.collections.notes.list()).map((note) => note.id), [
      "host",
    ]);
  } finally {
    await app.close();
    await database.close();
  }
});

Deno.test("F4 Server and core-http startup name missing Collection bindings", async () => {
  const database = await createOwnerTestDatabase();
  const app = await createCopilotzApplication({
    database,
    namespace: "space",
    collections: { notes },
    authorization: {
      policies: {
        fixture: { revision: "1", sources: [], evaluate: () => ({}) },
      },
      actions: {},
      collections: {},
    },
  });
  try {
    const authenticate = () => ({ authority: testAuthority("public") });
    assertThrows(
      () =>
        createServerFacadeFetchHandler(app, {
          facade: defineServerFacade({
            authenticate,
            expose: { collections: true, actions: false, channels: false },
          }),
        }),
      TypeError,
      "collections 'notes'",
    );
    const core = {
      ...app,
      plugins: {
        ...app.plugins,
        adapters: {
          ...app.plugins.adapters,
          http: { core: createCoreHttpAdapter() },
        },
      },
    };
    assertThrows(
      () =>
        createServerFacadeFetchHandler(core, {
          facade: defineServerFacade({
            authenticate,
            expose: { collections: false, actions: false, channels: false },
          }),
        }),
      TypeError,
      "collections 'thread'",
    );
  } finally {
    await app.close();
    await database.close();
  }
});

Deno.test("F4 owner decision capture refuses malformed read, mutation and nested filters with generic typed errors", async () => {
  const database = await createOwnerTestDatabase();
  const app = await createCopilotzApplication({
    database,
    namespace: "space",
    collections: { notes },
  });
  let constraints: ServerConstraints = {};
  const registration: OwnerAuthorization = {
    policies: {
      fixture: {
        revision: "1",
        sources: [],
        evaluate: () => constraints,
      },
    },
    collections: { notes: reference },
    actions: {},
  };
  const evaluate = createOwnerEvaluator({
    registration,
    collections: { notes },
    databaseSchema: "public",
  });
  const run = createSchemaCommandRunner(database, "public");
  const decision = () =>
    run(
      "test.policy",
      {},
      (_, command) =>
        evaluate(testAuthority("public"), {
          kind: "collection",
          resource: "notes",
          operation: "list",
          input: {},
        }, command),
    );
  try {
    const invalid = [
      { owner: "private-policy-value" },
      null,
      [],
      "all",
      { where: "bad" },
      { where: [] },
      { contains: null },
      { containsAny: { tags: "bad" } },
      { filter: null },
      {
        filter: {
          and: [{ field: "owner", eq: "ada" }, {
            owner: "private-policy-value",
          }],
        },
      },
      { filter: { not: { field: "owner", in: "bad" } } },
      { filter: { or: "bad" } },
      { filter: { field: "owner", eq: "ada", typo: true } },
    ];
    for (const filter of invalid) {
      for (
        const value of [
          { collections: { notes: filter } },
          { collectionMutations: { notes: { create: { filter } } } },
          { collectionMutations: { notes: { update: { filter } } } },
          { collectionMutations: { notes: { delete: { filter } } } },
          {
            collectionMutations: {
              notes: { commands: { rename: { filter } } },
            },
          },
        ]
      ) {
        constraints = value as ServerConstraints;
        const error = await assertRejects(decision);
        assertEquals((error as { code: string }).code, "forbidden");
        assertEquals((error as Error).message, "Forbidden");
      }
    }
    constraints = {
      collections: {
        notes: {
          where: { owner: "ada" },
          contains: { tags: ["one"] },
          containsAny: { tags: ["one", "two"] },
          filter: {
            and: [{ field: "owner", eq: "ada" }, {
              not: { field: "archived", eq: true },
            }],
          },
        },
      },
      collectionMutations: { notes: { create: { filter: {} } } },
    };
    assertEquals((await decision()).constraints, constraints);
  } finally {
    await app.close();
    await database.close();
  }
});

for (const transient of [false, true]) {
  Deno.test(`F4 ambient ${transient ? "transient" : "durable"} Processor host calls preserve retained grants`, async () => {
    const database = await createOwnerTestDatabase();
    const outcomes: string[] = [];
    const processor = defineProcessor({
      id: "notes.processor",
      on: [{ eventType: "notes.requested" }],
      async handle(event) {
        const id = (event.data as { id: string }).id;
        // A Processor's public Event must not share mutable admission authority.
        const ingress = (event as unknown as {
          ownerIngress?: { authority?: { principal: { id: string } } };
        }).ownerIngress;
        if (id === "denied" && ingress?.authority) {
          try {
            ingress.authority.principal.id = "writer";
          } catch {
            // Frozen public snapshots are equally safe.
          }
        }
        try {
          await write(id);
          outcomes.push("allowed");
        } catch (error) {
          outcomes.push((error as { code: string }).code);
        }
      },
    });
    const app = await createCopilotz({
      database,
      namespace: "space",
      collections: { notes },
      processors: transient ? {} : { write: processor },
      engine: { transientProcessors: transient ? [processor] : [] },
      authorization: {
        policies: {
          fixture: {
            revision: "1",
            sources: [],
            evaluate({ authority, intent }) {
              if (
                intent.kind === "collection" &&
                authority.principal.id !== "writer"
              ) authorizationRefused();
              return {
                events: ["notes.requested"],
                collections: { notes: {} },
                collectionMutations: { notes: { create: {} } },
              };
            },
          },
        },
        collections: { notes: reference },
        actions: {},
      },
    });
    const write: (id: string) => Promise<unknown> = (id) =>
      app.collections.notes.create({ id });
    try {
      for (const id of ["denied", "writer"]) {
        const sent = await restricted(
          id,
          () => app.send({ type: "notes.requested", payload: { id } }),
        );
        await sent.done;
        await sent.detach();
      }
      assertEquals(outcomes, ["forbidden", "allowed"]);
      assertEquals(
        (await app.collections.notes.list()).map((note) => note.id),
        [
          "writer",
        ],
      );
    } finally {
      await app.close();
      await database.close();
    }
  });
}

Deno.test("F4 unbound kernel mutations and transactions refuse caller authority", async () => {
  const database = await createOwnerTestDatabase();
  const app = await createCopilotzApplication({
    database,
    namespace: "space",
    collections: { notes },
  });
  const scoped = app.collections.withScope({ namespace: "space" });
  try {
    await scoped.note.create({ id: "host" });
    for (
      const work of [
        () => scoped.note.create({ id: "denied" }),
        () => scoped.note.update({ id: "host", set: { text: "denied" } }),
        () => scoped.note.delete({ id: "host" }),
        () =>
          app.collections.transaction({
            namespace: "space",
            operationKey: "denied",
            execute: ({ collections }) =>
              collections.note.create({ id: "transaction" }),
          }),
      ]
    ) {
      const error = await assertRejects(() =>
        restricted<unknown>("denied", work)
      );
      assertEquals((error as { code: string }).code, "forbidden");
    }
    assertEquals((await scoped.note.list()).map((note) => note.id), ["host"]);
  } finally {
    await app.close();
    await database.close();
  }
});

Deno.test("F4 uncatalogued retained Events execute without gaining host Collection authority", async () => {
  const database = await createOwnerTestDatabase();
  const outcomes: string[] = [];
  const app = await createCopilotzApplication({
    database,
    namespace: "space",
    collections: { notes },
    processors: {
      recovery: defineProcessor({
        id: "notes.recovery",
        on: [{ eventType: "notes.raw" }],
        async handle() {
          try {
            await app.host.collections.notes.list();
            outcomes.push("allowed");
          } catch (error) {
            outcomes.push((error as { code: string }).code);
          }
        },
      }),
    },
  });
  try {
    const { createEventStore } = await import("../events/store.ts");
    const store = createEventStore({ session: database, schema: "public" });
    await store.append({ type: "notes.raw", namespace: "space", payload: {} }, [
      "processor:notes.recovery",
    ]);
    const recovered = await app.engine.recover({ namespace: "space" });
    assertEquals(recovered.failures, []);
    assertEquals(recovered.handles.length, 1);
    await recovered.handles[0].done;
    assertEquals(outcomes, ["forbidden"]);
    assertEquals(await app.host.collections.notes.list(), []);
  } finally {
    await app.shutdown();
    await database.close();
  }
});
