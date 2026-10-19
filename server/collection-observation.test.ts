import { assert, assertEquals, assertRejects } from "@std/assert";
import { createCopilotz } from "../create-copilotz.ts";
import {
  type CollectionSnapshot,
  createCopilotzClient,
} from "../client/index.ts";
import {
  type ActionContext,
  ActionError,
  defineAction,
} from "../runtime/actions/index.ts";
import { defineCollection } from "../runtime/collections/definition.ts";
import { definePlugin } from "../runtime/plugins/index.ts";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import { until } from "../runtime/testing/effect-commit-proxy.ts";
import { serverPlugin } from "../plugins/server/plugin.ts";
import { defineServerFacade } from "../plugins/server/resources/facade/index.ts";

Deno.test("live Collection record and list use owner snapshots, reconnect reset, and idle policy revocation", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    pgPoolMax: 4,
  });
  const schema = `live_view_${crypto.randomUUID().replaceAll("-", "")}`;
  let permitted = true;
  let viewerReads = 0;
  const app = await createCopilotz({
    database: db,
    databaseSchema: schema,
    namespace: "space",
    collections: {
      entry: defineCollection({
        name: "liveEntry",
        ownerPolicy: "required",
        schema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        } as const,
      }),
    },
    actions: {
      write: defineAction({
        id: "fixture.write",
        async execute(
          input: { id: string; value: string; update?: boolean },
          context: ActionContext,
        ) {
          return input.update
            ? await context.collections.entry.update({
              id: input.id,
              set: { value: input.value },
            })
            : await context.collections.entry.create({
              id: input.id,
              value: input.value,
            });
        },
      }),
    },
    collectionPolicies: {
      entry: {
        authorize(_intent, context) {
          if (
            context.invocation.kind === "action" &&
            context.invocation.id === "fixture.write"
          ) return;
          if (
            context.invocation.kind === "viewer" &&
            context.invocation.actor.id === "member" && permitted
          ) {
            viewerReads++;
            return;
          }
          throw new ActionError("Denied", { code: "forbidden", status: 403 });
        },
      },
    },
    plugins: [
      definePlugin({
        ...serverPlugin,
        resources: {
          server: {
            default: defineServerFacade({
              expose: {
                actions: true,
                collections: {
                  include: ["liveEntry"],
                  operations: { include: ["get", "list", "observe"] },
                },
                channels: false,
              },
              authenticate() {
                return {
                  databaseSchema: schema,
                  namespace: "space",
                  actor: { id: "member" },
                  context: {
                    viewer: {
                      kind: "session",
                      subject: "directory-member",
                      expiresAt: 9999999999,
                    },
                  },
                };
              },
              authorize() {
                return {};
              },
            }),
          },
        },
      }),
    ],
  });
  const client = createCopilotzClient({
    baseUrl: "http://fixture.test/api",
    fetch: (input, init) => app.fetch(new Request(input, init)),
  });
  const recordAbort = new AbortController();
  const listAbort = new AbortController();
  const record: CollectionSnapshot[] = [];
  const list: CollectionSnapshot[] = [];
  let recordError: unknown;
  let listError: unknown;
  const writes = async (value: string, update = false) => {
    const receipt = await client.actions.submit("fixture.write", {
      id: "one",
      value,
      update,
    }, { idempotencyKey: crypto.randomUUID() });
    return await client.operations.result(receipt.operationId);
  };
  let recordDone: Promise<unknown> = Promise.resolve();
  let listDone: Promise<unknown> = Promise.resolve();
  try {
    await writes("first");
    recordDone = client.collections.observe("liveEntry", { id: "one" }, {
      signal: recordAbort.signal,
      onSnapshot: (value) => {
        record.push(value);
      },
    }).catch((error) => {
      recordError = error;
    });
    listDone = client.collections.observe(
      "liveEntry",
      { query: { limit: 10 } },
      {
        signal: listAbort.signal,
        onSnapshot: (value) => {
          list.push(value);
        },
      },
    ).catch((error) => {
      listError = error;
    });
    await until(
      () => record.length && list.length || recordError || listError,
      "first Collection snapshots",
    );
    if (recordError) throw recordError;
    if (listError) throw listError;
    assertEquals(record[0].reset, true);
    assertEquals((record[0].value as { value: string }).value, "first");
    assertEquals((list[0].value as { value: string }[])[0].value, "first");
    assertEquals(JSON.parse(record[0].checkpoint).sequence, record[0].to);
    const first = record[0].to;
    await writes("second", true);
    await until(
      () =>
        (record.at(-1)?.value as { value?: string })?.value === "second" &&
        (list.at(-1)?.value as { value?: string }[])?.[0]?.value === "second",
      "owner push Collection replacement",
    );
    assert(BigInt(record.at(-1)!.to) > BigInt(first));
    assertEquals(record[1].from, first);
    const reconnectAbort = new AbortController();
    const snapshots: CollectionSnapshot[] = [];
    const reconnect = client.collections.observe("liveEntry", { id: "one" }, {
      checkpoint: record[0].checkpoint,
      signal: reconnectAbort.signal,
      onSnapshot(value) {
        snapshots.push(value);
        reconnectAbort.abort();
      },
    });
    await reconnect.catch(() => undefined);
    assertEquals(snapshots[0].reset, true);
    assertEquals((snapshots[0].value as { value: string }).value, "second");
    const before = viewerReads;
    permitted = false; // No selected-record mutation, no owner event.
    await until(
      () => recordError && listError,
      "idle viewer policy revocation",
    );
    assertEquals((recordError as { code: string }).code, "revoked");
    assertEquals((listError as { code: string }).code, "revoked");
    assert(viewerReads >= before);
    await assertRejects(() => client.collections.get("liveEntry", "one"));
  } finally {
    recordAbort.abort();
    listAbort.abort();
    await Promise.allSettled([recordDone, listDone]);
    await app.close();
    await db.close();
  }
});
