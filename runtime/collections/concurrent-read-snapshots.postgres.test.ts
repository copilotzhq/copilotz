import { defineRead } from "./reads.ts";
import { assertEquals } from "@std/assert";
import { defineCollection } from "./definition.ts";
import { createCollectionRuntime } from "./kernel.ts";
import {
  createEventStore,
  type EventCoordinator,
  provisionCopilotzSchema,
} from "../events/index.ts";
import { localPostgresUrl } from "../testing/effect-commit-proxy.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { openDatabaseOwner, releaseDatabaseOwner } from "../engine/commands.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
const record = defineCollection({
  name: "fanout_record",
  schema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  } as const,
});

/**
 * Agent fan-out (parallel `ask`, parallel tool calls, many users) starts many
 * consistent reads at once. Each must complete; none may be refused for
 * capacity while the pool can serve it.
 */
Deno.test({
  name:
    "concurrent consistent reads on one owner all complete under a small pool",
  ignore: !url,
  async fn() {
    const db = await createTestDatabase({
      url: localPostgresUrl(url!),
      pgPoolMax: 4,
    });
    const schema = `fanout_${crypto.randomUUID().replaceAll("-", "")}`;
    await provisionCopilotzSchema(db, schema);
    const owner = await openDatabaseOwner(db, schema);
    owner.activate();
    const store = createEventStore({ session: db, schema });
    const coordinator: EventCoordinator = {
      async commitMutation(input) {
        return {
          ...await store.commitMutation({ ...input, consumers: [] }),
          dispatch: { handles: [], failures: [] },
        };
      },
      append() {
        throw new Error("unused");
      },
      recover() {
        throw new Error("unused");
      },
    };
    const runtime = createCollectionRuntime({
      session: db,
      eventStore: store,
      coordinator,
    });
    runtime.bind(record);
    try {
      const readers = 20;
      const outcomes = await Promise.allSettled(
        Array.from(
          { length: readers },
          () =>
            (async () => {
              const definition = defineRead(
                async (_args: unknown, { collections }) => {
                  const first = await collections.fanout_record.get({
                    id: "a",
                  });
                  // Hold the read phase briefly so the readers genuinely overlap.
                  await new Promise((resolve) => setTimeout(resolve, 25));
                  const second = await collections.fanout_record.get({
                    id: "b",
                  });
                  return [first, second];
                },
              );
              runtime.registerRead("testRead0", definition);
              return (await runtime.read<
                Awaited<ReturnType<typeof definition.execute>>
              >({ namespace: "space" }, "testRead0")).value;
            })(),
        ),
      );
      const refused = outcomes.filter((o) => o.status === "rejected").map((o) =>
        String(
          ((o as PromiseRejectedResult).reason as { code?: unknown })?.code ??
            (o as PromiseRejectedResult).reason,
        )
      );
      assertEquals(refused, [], `refused reads: ${refused.join(", ")}`);
    } finally {
      await releaseDatabaseOwner(owner);
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    }
  },
});
