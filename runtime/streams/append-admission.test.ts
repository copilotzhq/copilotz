import type { WorkerWorkHandler } from "../../dependencies/oxian-worker.ts";
import { defineAction } from "../actions/define.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createOwnerWorkerWorkloads } from "../execution/owner-capability-worker.ts";
import {
  type CapabilityCall,
  type CapabilityInvocation,
  decodeCapability,
  encodeCapability,
} from "../execution/owner-capability-wire.ts";
import type { ContentStreamWriter } from "./types.ts";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  CONTENT_CHUNK_BYTES,
  createContentCatalog,
} from "../content/catalog.ts";
import { createMemoryBodyStore } from "../content/body-store.ts";
import { openDatabaseOwner } from "../engine/commands.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import { createContentStreamRuntime } from "./stream.ts";

Deno.test("stream append admits only an active and waiting chunk before reading or copying bytes", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `append_admission_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  const owner = await openDatabaseOwner(db, schema);
  const catalog = createContentCatalog(db, schema),
    store = createMemoryBodyStore();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let calls = 0, active = 0, maximumActive = 0, writtenBytes = 0;
  const runtime = createContentStreamRuntime({
    namespace: "scope",
    catalog,
    store: {
      ...store,
      async append(input) {
        calls++;
        maximumActive = Math.max(maximumActive, ++active);
        try {
          if (calls === 1) {
            entered.resolve();
            await release.promise;
          }
          writtenBytes += input.bytes.byteLength;
          return await store.append(input);
        } finally {
          active--;
        }
      },
    },
    onOpen(_opened, publication) {
      publication.established();
    },
  });
  const writer = await runtime.open({
    id: "lane",
    mediaType: "text/plain",
    role: "output",
  });
  try {
    const firstBytes = new Uint8Array(CONTENT_CHUNK_BYTES).fill(1);
    const first = writer.append({ appendId: "first", bytes: firstBytes });
    void first.catch(() => undefined);
    await entered.promise;
    const secondBytes = new Uint8Array(CONTENT_CHUNK_BYTES).fill(2);
    const second = writer.append({ appendId: "second", bytes: secondBytes });
    void second.catch(() => undefined);
    firstBytes.fill(3);
    secondBytes.fill(4);
    let inspected = 0;
    const refused = {
      appendId: "refused",
      get bytes(): Uint8Array {
        inspected++;
        throw new Error("bytes inspected");
      },
    };
    for (let i = 0; i < 100; i++) {
      assertThrows(() => writer.append(refused), RangeError, "capacity");
    }
    assertEquals(inspected, 0);
    assertEquals(calls, 1);
    release.resolve();
    assertEquals(await first, {
      startOffset: 0,
      endOffset: CONTENT_CHUNK_BYTES,
    });
    assertEquals(await second, {
      startOffset: CONTENT_CHUNK_BYTES,
      endOffset: CONTENT_CHUNK_BYTES * 2,
    });
    assertEquals(maximumActive, 1);
    assertEquals(writtenBytes, CONTENT_CHUNK_BYTES * 2);
    const reader = (await runtime.follow({ id: writer.id })).body.getReader();
    try {
      assertEquals(
        (await reader.read()).value,
        new Uint8Array(CONTENT_CHUNK_BYTES).fill(1),
      );
      assertEquals(
        (await reader.read()).value,
        new Uint8Array(CONTENT_CHUNK_BYTES).fill(2),
      );
    } finally {
      await reader.cancel();
    }
    await assertRejects(
      () => writer.append({ appendId: "first", bytes: new Uint8Array([9]) }),
      Error,
      "different bytes",
    );
    assertThrows(
      () =>
        writer.append({
          appendId: "oversized",
          bytes: new Uint8Array(CONTENT_CHUNK_BYTES + 1),
        }),
      TypeError,
      "bounded",
    );
    let hostileReads = 0;
    const oversized = new Uint8Array(CONTENT_CHUNK_BYTES + 1);
    Object.defineProperties(oversized, {
      byteLength: { value: 0 },
      length: { value: 0 },
      [Symbol.iterator]: {
        value() {
          hostileReads++;
          throw new Error("iterator");
        },
      },
    });
    assertThrows(
      () => writer.append({ appendId: "shadowed", bytes: oversized }),
      TypeError,
      "bounded",
    );
    const arrayLike = {
      byteLength: 0,
      get length() {
        hostileReads++;
        return 1_000_000_000;
      },
    } as unknown as Uint8Array;
    assertThrows(
      () => writer.append({ appendId: "arraylike", bytes: arrayLike }),
      TypeError,
    );
    assertEquals(hostileReads, 0);
    assertEquals(
      await writer.append({ appendId: "empty", bytes: new Uint8Array() }),
      {
        startOffset: CONTENT_CHUNK_BYTES * 2,
        endOffset: CONTENT_CHUNK_BYTES * 2,
      },
    );
    const small = new Uint8Array([7]);
    Object.defineProperties(small, {
      byteLength: { value: 1_000_000_000 },
      length: { value: 1_000_000_000 },
      [Symbol.iterator]: {
        value() {
          hostileReads++;
          throw new Error("iterator");
        },
      },
    });
    assertEquals(await writer.append({ appendId: "intrinsic", bytes: small }), {
      startOffset: CONTENT_CHUNK_BYTES * 2,
      endOffset: CONTENT_CHUNK_BYTES * 2 + 1,
    });
    assertEquals(hostileReads, 0);
  } finally {
    release.resolve();
    await writer.abort();
    owner.stop();
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
});

Deno.test("worker append refuses the third call before encoding and restores admission after rejection", async () => {
  const release = Promise.withResolvers<void>(),
    received = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<CapabilityCall>();
  let appendCalls = 0, sent = false;
  const registry = createPluginRegistry({
    actions: {
      run: defineAction({
        id: "test.append",
        async execute(
          _input: unknown,
          context: {
            streams: { open(input: unknown): Promise<ContentStreamWriter> };
          },
        ) {
          const writer = await context.streams.open({ id: "lane" });
          const first = writer.append({
            appendId: "first",
            bytes: new Uint8Array([1]),
          });
          void first.catch(() => undefined);
          await received.promise;
          const second = writer.append({
            appendId: "second",
            bytes: new Uint8Array([2]),
          });
          void second.catch(() => undefined);
          let inspected = 0;
          const refused = {
            appendId: "third",
            get bytes(): Uint8Array {
              inspected++;
              throw new Error("encoding inspected bytes");
            },
          };
          try {
            for (let i = 0; i < 100; i++) {
              await assertRejects(
                () => writer.append(refused),
                Error,
                "owner_append_capacity",
              );
            }
            assertEquals(inspected, 0);
            assertEquals(appendCalls, 2);
          } finally {
            release.resolve();
          }
          await assertRejects(() => first, Error, "append rejected");
          await second;
          await writer.append({
            appendId: "third",
            bytes: new Uint8Array([3]),
          });
          await writer.abort();
          return "bounded";
        },
      }),
    },
  });
  const invocation: CapabilityInvocation = {
    id: "invocation",
    context: "context",
    kind: "action",
    alias: "run",
    args: [{}],
    scope: {
      namespace: "scope",
      databaseSchema: "public",
      operationKey: "operation",
      now: new Date(0).toISOString(),
    },
  };
  const work: Parameters<WorkerWorkHandler>[0] = {
    streamId: "stream",
    workload: "copilotz.delivery.v1",
    metadata: {},
    signal: new AbortController().signal,
    input: new ReadableStream({ start: (c) => c.close() }),
    sendMetadata: () => Promise.resolve(),
    async callHost(request) {
      const call = decodeCapability(
        request.body as Uint8Array,
      ) as CapabilityCall;
      let value: unknown, error: Error | undefined;
      if (call.kind === "next") {
        if (!sent) {
          sent = true;
          value = { invocation };
        } else {
          await complete.promise;
          value = { done: true };
        }
      } else if (call.kind === "complete") complete.resolve(call);
      else if (call.kind === "call" && call.path?.[0] === "streams") {
        value = {
          $ownerResource: "writer",
          handle: "writer",
          id: "lane",
          offset: 0,
        };
      } else if (call.kind === "call" && call.path?.[0] === "append") {
        const ordinal = ++appendCalls;
        received.resolve();
        await release.promise;
        if (ordinal === 1) error = new Error("append rejected");
        else value = { startOffset: ordinal - 1, endOffset: ordinal };
      }
      return {
        streamId: "host-call",
        metadata: Promise.resolve({}),
        started: Promise.resolve(),
        cancel: () => Promise.resolve(),
        output: new ReadableStream({
          start(c) {
            c.enqueue(encodeCapability(error ? { error } : { value }));
            c.close();
          },
        }),
        completed: Promise.resolve(),
      };
    },
  };
  try {
    await createOwnerWorkerWorkloads({ registry })[work.workload](work);
    const result = await complete.promise;
    if (result.error) throw result.error;
    assertEquals(result.value, "bounded");
    assertEquals(appendCalls, 3);
  } finally {
    release.resolve();
  }
});
