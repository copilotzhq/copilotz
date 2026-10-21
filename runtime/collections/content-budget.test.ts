import { assert, assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
import {
  createEventCoordinator,
  createEventStore,
  createSqlSession,
  provisionCopilotzSchema,
} from "../events/index.ts";
import { createDeliveryExecutor } from "../execution/index.ts";
import { createPluginRegistry } from "../plugins/index.ts";
import { createDatabaseAssetRepository } from "../content/database-repository.ts";
import { createMemoryAssetRepository } from "../content/repository.ts";
import { createContentResolver } from "../content/resolver.ts";
import { planContentBudget } from "../content/budget.ts";
import type { AssetRepository, ContentRef } from "../content/types.ts";
import { defineCollection } from "./definition.ts";
import {
  createResolvedCollectionReader,
  windowContentOptions,
} from "./resolved-read.ts";

const KIB = 1024;
const definition = defineCollection({
  name: "message",
  schema: { type: "object" },
  content: { fields: ["content"] },
});

type Message = { id: string; createdAt: string; content: unknown[] };
type Entry = Record<string, unknown> & {
  value?: unknown;
  deferred?: string;
  byteLength?: number;
};

/** A thread's messages, newest first, as a feed window reads them. */
async function thread(
  assets: AssetRepository,
  sizes: readonly number[],
): Promise<Message[]> {
  const messages: Message[] = [];
  for (const [index, size] of sizes.entries()) {
    const text = String(index % 10).repeat(size);
    const asset = await assets.publish({
      namespace: "tenant",
      mediaType: "text/plain",
      body: new TextEncoder().encode(text),
    });
    const ref: ContentRef = {
      assetId: asset.id,
      kind: "text",
      role: "body",
      mediaType: "text/plain",
    };
    messages.push({
      id: `m${String(index).padStart(3, "0")}`,
      createdAt: new Date(Date.UTC(2026, 9, 21, 0, 0, index)).toISOString(),
      content: [ref],
    });
  }
  return messages.reverse();
}

function reader(assets: AssetRepository, rows: readonly Message[]) {
  return createResolvedCollectionReader(
    () => Promise.resolve(rows),
    definition,
    "tenant",
    createContentResolver({ assets }),
  );
}

const entries = (rows: readonly unknown[]) =>
  (rows as Message[]).map((row) => row.content[0] as Entry);

Deno.test("a window whose newest 100 messages carry more than 256 KiB loads: the newest resolve, the older defer", async () => {
  const assets = createMemoryAssetRepository();
  const rows = await thread(assets, Array.from({ length: 100 }, () => 3 * KIB));
  const read = reader(assets, rows);
  const content = { fields: ["content"], byteLimit: 256 * KIB } as const;
  // Rejecting stays the default for callers that need every body.
  await assertRejects(
    () => read(undefined, { content }),
    RangeError,
    "byte budget",
  );
  const window = entries(
    await read(undefined, { content: { ...content, overflow: "defer" } }),
  );
  const fit = Math.floor((256 * KIB) / (3 * KIB));
  assertEquals(window.length, 100);
  assertEquals(
    window.slice(0, fit).every((entry) => typeof entry.value === "string"),
    true,
    "the newest bodies resolve",
  );
  for (const entry of window.slice(fit)) {
    assertEquals(entry.resolve, false);
    assertEquals(entry.deferred, "budget");
    assertEquals(entry.byteLength, 3 * KIB);
    assert(!("value" in entry));
  }
});

Deno.test("an oversize body stays a reference with its size, without spending the budget", async () => {
  const assets = createMemoryAssetRepository();
  const rows = await thread(assets, [KIB, 100 * KIB, KIB, KIB]);
  const window = entries(
    await reader(assets, rows)(undefined, {
      content: {
        fields: ["content"],
        byteLimit: 64 * KIB,
        bodyByteLimit: 32 * KIB,
        overflow: "defer",
      },
    }),
  );
  // Newest first: m003, m002, m001 (100 KiB), m000.
  assertEquals(window.map((entry) => entry.deferred ?? "read"), [
    "read",
    "read",
    "size",
    "read",
  ]);
  assertEquals(window[2].byteLength, 100 * KIB);
  assertEquals(window[2].resolve, false);
});

Deno.test("the budget plan is deterministic: read order decides, each body counts once", async () => {
  const plan = (sizes: [string, number][]) =>
    planContentBudget(
      sizes.map(([id, byteLength]) => ({ id, byteLength })),
      { maxBytes: 10, maxBodyBytes: 6 },
    );
  const order: [string, number][] = [
    ["a", 4],
    ["big", 7],
    ["b", 4],
    ["a", 4],
    ["c", 4],
    ["d", 1],
  ];
  // `big` is too large alone; `a` counts once; `c` overflows, so it and every
  // later body defer even though `d` would fit.
  assertEquals(plan(order), [
    "read",
    "size",
    "read",
    "read",
    "budget",
    "budget",
  ]);
  assertEquals(plan(order), plan(order));
  assertEquals(plan([["c", 4], ["b", 4], ["a", 4]]), [
    "read",
    "read",
    "budget",
  ]);
  // The same window read twice resolves the same bodies.
  const assets = createMemoryAssetRepository();
  const rows = await thread(assets, [5, 5, 5, 5]);
  const read = reader(assets, rows);
  const content = {
    fields: ["content"],
    byteLimit: 12,
    overflow: "defer",
  } as const;
  assertEquals(
    await read(undefined, { content }),
    await read(undefined, { content }),
  );
});

Deno.test("repositories without readWithin are budgeted from metadata the same way", async () => {
  const assets = createMemoryAssetRepository();
  const rows = await thread(assets, [4, 4, 4, 40]);
  const { readWithin: _native, ...legacy } = assets;
  const content = {
    fields: ["content"],
    byteLimit: 10,
    bodyByteLimit: 20,
    overflow: "defer",
  } as const;
  assertEquals(
    await reader(legacy, rows)(undefined, { content }),
    await reader(assets, rows)(undefined, { content }),
  );
});

Deno.test("the database repository reads only the bodies that fit", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    const session = createSqlSession(db);
    const schema = "content_budget";
    await provisionCopilotzSchema(session, schema);
    const store = createEventStore({ session, schema });
    const registry = await createPluginRegistry();
    const executor = createDeliveryExecutor({
      store,
      registry,
      workerId: "budget-test",
      createContext: createTestProcessorContext,
    });
    const coordinator = createEventCoordinator({ store, registry, executor });
    const assets = createDatabaseAssetRepository({
      coordinator,
      session,
      eventStore: store,
      databaseSchema: schema,
    });
    const rows = await thread(assets, [6, 6, 30, 6]);
    const window = entries(
      await reader(assets, rows)(undefined, {
        content: {
          fields: ["content"],
          byteLimit: 12,
          bodyByteLimit: 20,
          overflow: "defer",
        },
      }),
    );
    // Newest first: m003 (6), m002 (30, too large), m001 (6), m000 (6).
    assertEquals(window.map((entry) => entry.deferred ?? entry.value), [
      "333333",
      "size",
      "111111",
      "budget",
    ]);
  } finally {
    await db.close();
  }
});

Deno.test("live windows defer over budget unless the subscriber chose to reject", () => {
  assertEquals(windowContentOptions(true), { overflow: "defer" });
  assertEquals(windowContentOptions({ fields: ["content"], byteLimit: 9 }), {
    overflow: "defer",
    fields: ["content"],
    byteLimit: 9,
  });
  assertEquals(
    windowContentOptions({ overflow: "reject" }),
    { overflow: "reject" },
  );
  assertEquals(windowContentOptions(undefined), undefined);
  assertEquals(windowContentOptions(false), false);
});
