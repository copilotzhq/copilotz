import { assert, assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
import {
  createCoreSchemaStatements,
  createEventCoordinator,
  createEventStore,
  createSqlSession,
} from "../events/index.ts";
import { createDeliveryExecutor } from "../execution/index.ts";
import { createPluginRegistry } from "../plugins/index.ts";
import {
  collectionAssetAdopterFor,
  createDatabaseAssetRepository,
} from "../content/database-repository.ts";
import { createContentResolver } from "../content/resolver.ts";
import {
  type CollectionRecord,
  createCollectionRuntime,
  type ResolvedCollectionContentEntry,
  type ScopedCollection,
  type ScopedCollectionCallOptions,
  type ScopedCollectionReadOptions,
} from "./index.ts";
import { defineCollection } from "./definition.ts";
import { createResolvedCollectionReader } from "./resolved-read.ts";
import type { ContentRef } from "../content/types.ts";

Deno.test("scoped resolved reads preserve records, page boundaries, reference semantics and authorization", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const session = createSqlSession(db);
  const schema = "resolved_collection";
  for (const statement of createCoreSchemaStatements(schema)) {
    await session.query(statement);
  }
  const store = createEventStore({ session, schema });
  const registry = await createPluginRegistry();
  const executor = createDeliveryExecutor({
    store,
    registry,
    workerId: "resolved-test",
    createContext: createTestProcessorContext,
  });
  const coordinator = createEventCoordinator({ store, registry, executor });
  const assets = createDatabaseAssetRepository({
    coordinator,
    session,
    eventStore: store,
    databaseSchema: schema,
  });
  const batches: string[][] = [];
  let deny = false;
  let failReads = false;
  let abortRead: AbortController | undefined;
  const resolver = createContentResolver({
    assets: {
      ...assets,
      async readMany(namespace, ids, options) {
        if (failReads) throw new Error("Storage unavailable");
        // A batch the repository refuses on its byte budget reads no body.
        const result = await assets.readMany(namespace, ids, options);
        batches.push([...ids]);
        abortRead?.abort();
        return result;
      },
    },
    authorize: ({ namespace }) => namespace === "tenant" && !deny,
  });
  const runtime = createCollectionRuntime({
    coordinator,
    session,
    eventStore: store,
    assets: collectionAssetAdopterFor(assets),
    contentResolver: resolver,
  });
  runtime.bind(defineCollection({
    name: "document",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        body: { type: "array" },
        metadata: { type: "object" },
      },
      required: ["id", "title", "body", "metadata"],
    },
    content: { fields: ["body", "metadata.reasoning"] },
    search: { enabled: true, fields: ["title"] },
    commands: {
      rename: {
        mutate: ({ input }) => ({
          set: { title: String((input as { title: string }).title) },
        }),
      },
    },
    queries: {
      all: { filter: () => ({}) },
      resolved: {
        select: ({ input, read }) =>
          read.list("document", { where: { id: input.id }, limit: 1 }, {
            content: { fields: ["body"] },
          }),
      },
      cancelledChild: {
        select({ read }) {
          const controller = new AbortController();
          controller.abort();
          return read.list("document", {}, { signal: controller.signal });
        },
      },
      resolvedOne: {
        async select({ input, read }) {
          const record = await read.get("document", String(input.id), {
            content: true,
          });
          return record ? [record] : [];
        },
      },
    },
  }));
  const docs = runtime.withScope({ namespace: "tenant" }).document;
  try {
    const asset = await assets.publish({
      namespace: "tenant",
      mediaType: "text/plain",
      body: new TextEncoder().encode("Hello"),
    });
    const ref: ContentRef = {
      assetId: asset.id,
      kind: "text",
      role: "body",
      mediaType: "text/plain",
    };
    await docs.create({
      id: "a",
      title: "first",
      body: [ref, ref],
      metadata: {
        reasoning: [{ ...ref, role: "reasoning" }],
        unrelated: [{ ...ref, assetId: "not-read" }],
      },
    });
    await docs.create({ id: "b", title: "second", body: [ref], metadata: {} });
    const plain = await docs.get({ id: "a" });
    assert(plain);
    assertEquals(batches.length, 0);
    const resolved = await docs.get({ id: "a" }, { content: { byteLimit: 5 } });
    assertEquals(resolved, {
      ...plain,
      body: [{ ...ref, value: "Hello" }, { ...ref, value: "Hello" }],
      metadata: {
        ...(plain.metadata as object),
        reasoning: [{ ...ref, role: "reasoning", value: "Hello" }],
      },
    });
    assertEquals(batches, [[asset.id]]);
    const selected = await docs.get({ id: "a" }, {
      content: { fields: ["metadata.reasoning"] },
    });
    assertEquals(selected?.body, plain.body);
    assertEquals(selected?.metadata, {
      ...(plain.metadata as object),
      reasoning: [{ ...ref, role: "reasoning", value: "Hello" }],
    });
    assertEquals(await docs.get({ id: "missing" }, { content: true }), null);
    assertEquals(
      await docs.get({ id: "a" }, { content: { fields: [] } }),
      plain,
    );
    const page = await docs.list({
      limit: 1,
      order: { field: "id", direction: "asc" },
    }, { content: true });
    assertEquals(page.map((r) => r.id), ["a"]);
    assertEquals(page[0].body, [{ ...ref, value: "Hello" }, {
      ...ref,
      value: "Hello",
    }]);
    const next = await docs.list({
      limit: 1,
      after: "a",
      order: { field: "id", direction: "asc" },
    }, { content: true });
    assertEquals(next.map((r) => r.id), ["b"]);
    assertEquals(
      (await docs.search({ text: "second" }, { content: true }))[0].body,
      [{ ...ref, value: "Hello" }],
    );
    assertEquals(await docs.get({ id: "a" }, { content: false }), plain);
    const filtered = await docs.list({
      filter: {
        and: [{ field: "title", eq: "second" }, {
          not: { field: "id", eq: "a" },
        }],
      },
      limit: 1,
    }, { content: true });
    assertEquals(filtered.map((row) => row.id), ["b"]);
    assertEquals(filtered[0].body, [{ ...ref, value: "Hello" }]);
    const before = batches.length;
    await assertRejects(
      () => docs.get({ id: "a" }, { content: { byteLimit: 4 } }),
      RangeError,
      "byte budget",
    );
    await assertRejects(
      () =>
        docs.get({ id: "missing" }, {
          content: { fields: ["metadata.unrelated"] },
        }),
      TypeError,
      "Undeclared content field",
    );
    assertEquals(batches.length, before);
    deny = true;
    assertEquals(
      await docs.list({ filter: { field: "id", eq: "not-selected" } }, {
        content: true,
      }),
      [],
    );
    await assertRejects(() => docs.get({ id: "a" }, { content: true }), Error);
    assertEquals(batches.length, before);
    deny = false;
    const cancelled = new AbortController();
    cancelled.abort();
    await assertRejects(
      () => docs.list({}, { content: true, signal: cancelled.signal }),
      DOMException,
    );
    assertEquals(batches.length, before);
    abortRead = new AbortController();
    await assertRejects(
      () => docs.get({ id: "a" }, { content: true, signal: abortRead!.signal }),
      DOMException,
    );
    abortRead = undefined;
    assertEquals(
      await runtime.withScope({ namespace: "other" }).document.list({}, {
        content: true,
      }),
      [],
    );
    assertEquals(await docs.get({ id: "a" }), plain);
    const base = runtime.get("document")!;
    const scope = {
      namespace: "tenant",
      createMutationIdentity: (key: string) => ({
        deduplicationId: `base:${key}`,
      }),
    };
    assertEquals(
      await base.get(scope, { id: "a" }, { content: true }),
      await docs.get({ id: "a" }, { content: true }),
    );
    assertEquals(
      (await base.list(scope, { where: { id: "b" } }, { content: true }))[0]
        .body,
      [{ ...ref, value: "Hello" }],
    );
    assertEquals(
      (await base.search(scope, { text: "second" }, { content: true }))[0].id,
      "b",
    );
    assertEquals((await docs.queries.resolved({ id: "a" }))[0].body, [{
      ...ref,
      value: "Hello",
    }, { ...ref, value: "Hello" }]);
    assertEquals((await base.queries.resolvedOne(scope, { id: "b" }))[0].body, [
      { ...ref, value: "Hello" },
    ]);
    assertEquals(
      await base.queries.resolvedOne({ namespace: "other" }, { id: "b" }),
      [],
    );
    await assertRejects(
      () =>
        base.queries.resolvedOne(scope, { id: "b" }, {
          signal: cancelled.signal,
        }),
      DOMException,
    );
    await assertRejects(
      () =>
        base.queries.cancelledChild(scope, {}, {
          signal: new AbortController().signal,
        }),
      DOMException,
    );
    assertEquals((await base.list(scope)).length, 2);
    const input = { id: "c", title: "third", body: [], metadata: {} };
    const created = await base.create(scope, input);
    assertEquals(
      await runtime.withScope(scope).document.create(input),
      created,
    );
    assertEquals(
      (await base.update(scope, { id: "c", set: { title: "changed" } })).title,
      "changed",
    );
    assertEquals(
      (await base.commands.rename(scope, { id: "c", title: "renamed" })).title,
      "renamed",
    );
    await assertRejects(
      () =>
        runtime.transaction({
          namespace: "tenant",
          operationKey: "guard",
          execute: () => base.update(scope, { id: "c", set: { title: "bad" } }),
        }),
      Error,
      "transaction.collections",
    );
    await base.create(
      { namespace: "tenant" },
      { ...input, id: "forged" },
      { namespace: "other" } as unknown as ScopedCollectionCallOptions,
    );
    assertEquals(
      await base.get({ namespace: "other" }, { id: "forged" }),
      null,
    );
    assertEquals(await base.delete(scope, { id: "c" }), {
      id: "c",
      deleted: true,
    });
    assertEquals(await docs.get({ id: "c" }), null);
    failReads = true;
    await assertRejects(() => docs.get({ id: "a" }, { content: true }), Error);
  } finally {
    await executor.shutdown();
    await db.close();
  }
});

Deno.test("selected content returns metadata with text, JSON and bytes without modifying or aliasing records", async () => {
  const { createMemoryAssetRepository } = await import(
    "../content/repository.ts"
  );
  const assets = createMemoryAssetRepository();
  const resolver = createContentResolver({ assets });
  const definition = defineCollection({
    name: "document",
    schema: { type: "object" },
    content: { fields: ["body", "nested.body"] },
  });
  const refs: ContentRef[] = [];
  for (
    const [kind, mediaType, body] of [
      ["text", "text/plain", new TextEncoder().encode("Hello")],
      ["json", "application/json", new TextEncoder().encode('{"answer":42}')],
      ["file", "application/octet-stream", new Uint8Array([0, 255, 7])],
    ] as const
  ) {
    const asset = await assets.publish({
      namespace: "tenant",
      mediaType,
      body,
    });
    refs.push({
      assetId: asset.id,
      kind,
      role: "body",
      mediaType,
      name: `${kind}-example`,
      metadata: { source: "test" },
    });
  }
  const source = {
    body: [...refs, refs[1]],
    nested: { body: refs },
    untouched: "yes",
  };
  const read = createResolvedCollectionReader(
    () => Promise.resolve(source),
    definition,
    "tenant",
    resolver,
  );
  const selected = await read(undefined, { content: { fields: ["body"] } });
  assertEquals(selected.body, [
    { ...refs[0], kind: "text", value: "Hello" },
    { ...refs[1], kind: "json", value: { answer: 42 } },
    { ...refs[2], kind: "file", value: new Uint8Array([0, 255, 7]) },
    { ...refs[1], kind: "json", value: { answer: 42 } },
  ]);
  assertEquals(selected.nested, source.nested);
  (selected.body[1].value as { answer: number }).answer = 9;
  assertEquals(selected.body[3].value, { answer: 42 });
  assertEquals(Object.hasOwn(selected.body[0], "asset"), false);
  assertEquals((await read(undefined)).body, [...refs, refs[1]]);
  const missingResolver = createResolvedCollectionReader(
    () => Promise.resolve(source),
    definition,
    "tenant",
    undefined,
  );
  await assertRejects(
    () => missingResolver(undefined, { content: true }),
    Error,
    "resolver is not configured",
  );
  assertEquals(
    await missingResolver(undefined, { content: { fields: [] } }),
    source,
  );
  await assertRejects(
    () => read(undefined, { content: { byteLimit: -1 } }),
    TypeError,
    "byteLimit",
  );
  const malformed = createResolvedCollectionReader(
    () => Promise.resolve({ body: [{}] }),
    definition,
    "tenant",
    resolver,
  );
  await assertRejects(
    () => malformed(undefined, { content: true }),
    TypeError,
    "Invalid content reference",
  );
});

// Literal selections retain untouched fields; dynamic selections widen conservatively.
function readTypes(
  collection: ScopedCollection<
    CollectionRecord & {
      body: ContentRef[];
      nested: { body: ContentRef[] };
      title: string;
    }
  >,
  options?: ScopedCollectionReadOptions,
) {
  const plain: Promise<CollectionRecord | null> = collection.get({ id: "a" });
  const selected = collection.get({ id: "a" }, {
    content: { fields: ["body"] },
  });
  selected.then((record) => {
    if (!record) return;
    const content: readonly ResolvedCollectionContentEntry[] = record.body;
    const untouched: ContentRef[] = record.nested.body;
    const title: string = record.title;
    // @ts-expect-error Entries contain metadata and value, not bare strings.
    const references: readonly string[] = record.body;
    const entry = record.body[0];
    if (entry.resolve === false) return;
    if (entry.kind === "text") {
      const text: string = entry.value;
      void text;
    }
    if (entry.kind === "image") {
      const bytes: Uint8Array = entry.value;
      void bytes;
    }
    return [content, untouched, title, references];
  });
  const nested = collection.get({ id: "a" }, {
    content: { fields: ["nested.body"] },
  });
  nested.then((record) => {
    if (!record) return;
    const content: readonly ResolvedCollectionContentEntry[] =
      record.nested.body;
    const untouched: ContentRef[] = record.body;
    return [content, untouched];
  });
  collection.get({ id: "a" }, options);
  collection.list();
  // @ts-expect-error Retired pre-release option is not exposed.
  collection.get({ id: "a" }, { resolveContent: true });
  return plain;
}
void readTypes;
