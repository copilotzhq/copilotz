/** Real SQL/projection fence with an explicit stub authority resolver. Actual
 * worker/local lifecycle authority is covered by owner-host.local.test.ts. */
import { assertEquals, assertRejects } from "@std/assert";
import { defineCollection } from "../collections/definition.ts";
import { createCoreSchemaStatements } from "../events/schema.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { OWNER_COLLECTION_READ } from "../execution/collection-read-call.ts";
import { createOwnerCommandBoundary, type OwnerJson } from "./boundary.ts";
import {
  createOwnerCollectionRead,
  createOwnerCollectionReadEvaluator,
  type OwnerCollectionReadPolicy,
} from "./collection-read.ts";
import type { OwnerChildActionBinding } from "./child-action.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";

async function fixture(authorize: OwnerCollectionReadPolicy = () => ({})) {
  const db = await createTestDatabase({ pgliteMemoryProfile: "low-memory" });
  let stop: (() => void) | undefined;
  try {
    for (const sql of createCoreSchemaStatements("public")) await db.query(sql);
    await provisionOwnerCommandSchema(db, "public");
    const registry = createPluginRegistry({
      collections: {
        notes: defineCollection({
          name: "note",
          schema: {
            type: "object",
            properties: {
              label: { type: "string" },
              ref: {
                type: "object",
                properties: { value: { type: "number" } },
              },
            },
          },
        }),
        secret: defineCollection({
          name: "secret",
          schema: {
            type: "object",
            properties: {
              value: { type: "string", "x-copilotz-secret": true },
            },
          },
        }),
        content: defineCollection({
          name: "content",
          schema: { type: "object" },
          content: { fields: ["body"] },
        }),
        asset: defineCollection({ name: "asset", schema: { type: "object" } }),
      },
    });
    let resolves = 0;
    const grants = { ctxGranted: true, settlementGranted: true };
    const handler = createOwnerCollectionRead({
      schema: "public",
      registry,
      authorize,
      resolve: () => {
        resolves++;
        return Promise.resolve(
          {
            kind: "action",
            assignment: { namespace: "space", ...grants },
          } as OwnerChildActionBinding,
        );
      },
    });
    const boundary = createOwnerCommandBoundary({
      ownerId: "owner",
      holderId: "holder",
      schema: "public",
      session: db,
      handlers: {},
      projections: { [OWNER_COLLECTION_READ]: handler },
      authorize() {},
      authenticateReceipt() {
        throw new Error("unused");
      },
    });
    stop = () => boundary.stop();
    const epoch = await boundary.acquire(0);
    const caller = {
      principal: { kind: "worker" as const, workerId: "test" },
      ownerEpoch: epoch,
    };
    return {
      db,
      grants,
      registry,
      resolves: () => resolves,
      put: (id: string, data: unknown, namespace = "space") =>
        db.query(
          "INSERT INTO nodes(id,namespace,type,name,data) VALUES($1,$2,'note',$1,$3::jsonb)",
          [id, namespace, JSON.stringify(data)],
        ),
      read: (input: OwnerJson) =>
        boundary.project(caller, OWNER_COLLECTION_READ, input),
      async close() {
        boundary.stop();
        await db.close();
      },
    };
  } catch (error) {
    stop?.();
    await db.close();
    throw error;
  }
}

Deno.test("owner read projection refuses forged aliases, declarations and wire fields before resolution", async () => {
  const f = await fixture();
  try {
    for (
      const collectionAlias of [
        "missing",
        "secret",
        "content",
        "asset",
        "__proto__",
      ]
    ) {
      await assertRejects(() =>
        f.read({ collectionAlias, operation: "get", id: "a" })
      );
    }
    for (
      const extra of [{ namespace: "other" }, { schema: "other" }, {
        identity: {},
      }, { select: [] }] as Record<string, OwnerJson>[]
    ) {
      await assertRejects(() =>
        f.read(
          {
            collectionAlias: "notes",
            operation: "get",
            id: "a",
            ...extra,
          } as OwnerJson,
        )
      );
    }
    assertEquals(f.resolves(), 0);
  } finally {
    await f.close();
  }
});

Deno.test("owner read projection conjoins caller filters and policy before get and aggregation", async () => {
  let calls = 0;
  const f = await fixture((_tx, binding, request) => {
    calls++;
    assertEquals(Object.hasOwn(binding.assignment, "ctxGranted"), false);
    assertEquals(Object.hasOwn(binding.assignment, "settlementGranted"), false);
    (binding.assignment as { namespace: string }).namespace = "other";
    (request as { collectionAlias: string }).collectionAlias = "asset";
    return { where: { label: "public" } };
  });
  try {
    await f.put("a", { label: "public" });
    await f.put("b", { label: "private" });
    await f.put("foreign", { label: "public" }, "other");
    assertEquals(
      await f.read({ collectionAlias: "notes", operation: "get", id: "b" }),
      null,
    );
    assertEquals(
      await f.read({
        collectionAlias: "notes",
        operation: "list",
        query: { where: { label: "private" }, all: [] },
      }),
      [],
    );
    assertEquals(
      await f.read({
        collectionAlias: "notes",
        operation: "aggregate",
        query: { metrics: { n: { op: "count" } } },
      }),
      [{ n: 1 }],
    );
    assertEquals(calls, 6);
    assertEquals((await f.db.query("SELECT key FROM owner_receipts")).rows, []);
    assertEquals((await f.db.query("SELECT id FROM events")).rows, []);
  } finally {
    await f.close();
  }
});

Deno.test("owner read projection refuses protected output and aggregate source laundering", async () => {
  const f = await fixture();
  try {
    await f.put("a", {
      label: "public",
      ref: {
        schema: "copilotz.action.protected-value.v1",
        value: 42,
        bodyId: "private",
      },
    });
    await assertRejects(() =>
      f.read({ collectionAlias: "notes", operation: "get", id: "a" })
    );
    await assertRejects(() =>
      f.read({ collectionAlias: "notes", operation: "list", query: {} })
    );
    await assertRejects(
      () =>
        f.read({
          collectionAlias: "notes",
          operation: "aggregate",
          query: { metrics: { harmless: { op: "sum", field: "ref.value" } } },
        }),
      TypeError,
      "protected data",
    );
    await assertRejects(
      () =>
        f.read({
          collectionAlias: "notes",
          operation: "aggregate",
          query: { groupBy: ["ref.bodyId"], metrics: { n: { op: "count" } } },
        }),
      TypeError,
      "protected data",
    );
  } finally {
    await f.close();
  }
});

Deno.test("owner read projection refuses oversized records and aggregate groups", async () => {
  const f = await fixture();
  try {
    await f.put("a", { label: "x".repeat(262144) });
    await assertRejects(
      () => f.read({ collectionAlias: "notes", operation: "get", id: "a" }),
      RangeError,
      "transfer budget",
    );
    await assertRejects(
      () =>
        f.read({
          collectionAlias: "notes",
          operation: "aggregate",
          query: { groupBy: ["label"], metrics: { n: { op: "count" } } },
        }),
      RangeError,
      "transfer budget",
    );
  } finally {
    await f.close();
  }
});

Deno.test("owner aggregate never evaluates protected values into SQL error messages", async () => {
  const f = await fixture();
  try {
    await f.put("a", {
      ref: {
        schema: "copilotz.action.protected-value.v1",
        value: "2026-99-99T00:00:00Z",
      },
    });
    const error = await assertRejects(
      () =>
        f.read({
          collectionAlias: "notes",
          operation: "aggregate",
          query: {
            groupBy: [{ field: "ref.value", interval: "day" }],
            metrics: { n: { op: "count" } },
          },
        }),
      Error,
    );
    assertEquals(error instanceof TypeError, true);
    assertEquals(error.message.includes("protected data"), true);
    assertEquals(error.message.includes("2026-99-99"), false);
  } finally {
    await f.close();
  }
});

Deno.test("owner read authority is independent of the settlement grant", async () => {
  let calls = 0;
  const f = await fixture(() => {
    if (++calls === 2) f.grants.settlementGranted = false;
    return {};
  });
  try {
    await f.put("a", { label: "public" });
    const result = await f.read({
      collectionAlias: "notes",
      operation: "get",
      id: "a",
    });
    assertEquals((result as { id: string }).id, "a");
  } finally {
    await f.close();
  }
});

Deno.test("owner read refuses protected cursor anchors before using their order values", async () => {
  const f = await fixture();
  try {
    await f.put("anchor", {
      ref: { schema: "copilotz.action.protected-value.v1", value: 42 },
    });
    await f.put("lower", { ref: { value: 40 } });
    await f.put("upper", { ref: { value: 50 } });
    await assertRejects(
      () =>
        f.read({
          collectionAlias: "notes",
          operation: "list",
          query: { after: "anchor", order: { field: "ref.value" } },
        }),
      TypeError,
      "protected data",
    );
  } finally {
    await f.close();
  }
});

Deno.test("shared Collection evaluator captures bounded query independently of policy metadata", async () => {
  const f = await fixture();
  try {
    await f.put("a", { label: "public" });
    await f.put("b", { label: "private" });
    const prepare = createOwnerCollectionReadEvaluator({
      schema: "public",
      registry: f.registry,
    });
    const input = { collectionAlias: "notes", operation: "get", id: "a" };
    const plan = prepare(input);
    input.id = "b";
    if (plan.request.operation !== "get") throw new Error("Expected get");
    (plan.request as { id: string }).id = "b";
    const record = (await plan.execute(f.db, "space", {
      where: { label: "public" },
    }))();
    assertEquals((record as { id: string }).id, "a");
    assertEquals(
      (await prepare({ ...input, id: "b" }).execute(f.db, "space", {
        where: { label: "public" },
      }))(),
      null,
    );
  } finally {
    await f.close();
  }
});

Deno.test("final read revocation takes precedence over local output-shape errors", async () => {
  let calls = 0, revoke = true;
  const f = await fixture(() => ++calls === 2 && revoke ? undefined : {});
  try {
    let nested: unknown = 0;
    for (let index = 0; index < 40; index++) nested = { next: nested };
    await f.put("deep", { label: "public", ref: nested });
    const request = { collectionAlias: "notes", operation: "get", id: "deep" };
    const denied = await assertRejects(() => f.read(request));
    assertEquals((denied as { code?: string }).code, "ActionOwnershipLost");
    calls = 0;
    revoke = false;
    const invalid = await assertRejects(() => f.read(request));
    assertEquals(
      (invalid as { code?: string }).code,
      "ordinary_value_unsupported",
    );
  } finally {
    await f.close();
  }
});
