import { assertEquals } from "@std/assert";
import { createContentResolver } from "../content/resolver.ts";
import { createMemoryAssetRepository } from "../content/repository.ts";
import { createEphemeralEvent } from "../events/index.ts";
import { resolveProcessorEvent } from "./event-data.ts";

Deno.test("resolved processor Event data recursively hydrates text and JSON refs", async () => {
  const assets = createMemoryAssetRepository();
  await assets.publish({
    id: "event-text",
    namespace: "tenant-a",
    mediaType: "text/plain",
    body: new TextEncoder().encode("resolved text"),
  });
  await assets.publish({
    id: "event-json",
    namespace: "tenant-a",
    mediaType: "application/json",
    body: new TextEncoder().encode('{"answer":42}'),
  });
  await assets.publish({
    id: "event-file",
    namespace: "tenant-a",
    mediaType: "application/octet-stream",
    body: new Uint8Array([1, 2, 3]),
  });
  const baseResolver = createContentResolver({ assets });
  const requested: string[][] = [];
  const resolver = {
    async getMany(
      refs: readonly import("../content/types.ts").ContentRef[],
      options: {
        namespace: string;
      },
    ) {
      assertEquals(options.namespace, "tenant-a");
      requested.push(refs.map((ref) => ref.assetId));
      return await baseResolver.getMany(refs, options);
    },
  };
  const event = createEphemeralEvent({
    type: "event.content.created",
    namespace: "tenant-a",
    correlationId: "event-content",
    payload: {
      nested: [
        {
          assetId: "event-text",
          kind: "text",
          role: "body",
          mediaType: "text/plain",
          name: "message.txt",
          metadata: { source: "event" },
          value: "untrusted text",
        },
        {
          data: {
            assetId: "event-json",
            kind: "json",
            role: "details",
            mediaType: "application/json",
            value: { answer: "untrusted" },
          },
        },
        {
          descriptor: {
            assetId: "event-text",
            kind: "text",
            role: "attachment",
            mediaType: "text/plain",
            resolve: false,
          },
        },
      ],
      binary: {
        assetId: "event-file",
        kind: "file",
        role: "attachment",
        mediaType: "application/octet-stream",
        value: "untrusted bytes",
        resolve: false,
      },
    },
  });

  const resolved = await resolveProcessorEvent({} as never, event, resolver);
  const data = resolved.data as {
    nested: Array<Record<string, unknown>>;
    binary: Record<string, unknown>;
  };

  assertEquals(requested, [["event-text", "event-json"]]);
  assertEquals(data.nested[0], {
    assetId: "event-text",
    kind: "text",
    role: "body",
    mediaType: "text/plain",
    name: "message.txt",
    metadata: { source: "event" },
    value: "resolved text",
  });
  assertEquals(data.nested[1].data, {
    assetId: "event-json",
    kind: "json",
    role: "details",
    mediaType: "application/json",
    value: { answer: 42 },
  });
  assertEquals(data.nested[2].descriptor, {
    assetId: "event-text",
    kind: "text",
    role: "attachment",
    mediaType: "text/plain",
    resolve: false,
  });
  assertEquals(data.binary, {
    assetId: "event-file",
    kind: "file",
    role: "attachment",
    mediaType: "application/octet-stream",
    resolve: false,
  });
  assertEquals(event.payload, {
    nested: [
      {
        assetId: "event-text",
        kind: "text",
        role: "body",
        mediaType: "text/plain",
        name: "message.txt",
        metadata: { source: "event" },
        value: "untrusted text",
      },
      {
        data: {
          assetId: "event-json",
          kind: "json",
          role: "details",
          mediaType: "application/json",
          value: { answer: "untrusted" },
        },
      },
      {
        descriptor: {
          assetId: "event-text",
          kind: "text",
          role: "attachment",
          mediaType: "text/plain",
          resolve: false,
        },
      },
    ],
    binary: {
      assetId: "event-file",
      kind: "file",
      role: "attachment",
      mediaType: "application/octet-stream",
      value: "untrusted bytes",
      resolve: false,
    },
  });
});

Deno.test("processor Event resolution remains usable without a content resolver", async () => {
  const event = createEphemeralEvent({
    type: "event.content.legacy",
    namespace: "tenant-a",
    correlationId: "event-content-legacy",
    payload: {
      content: {
        assetId: "event-text",
        kind: "text",
        role: "body",
        mediaType: "text/plain",
      },
    },
  });

  const resolved = await resolveProcessorEvent({} as never, event);
  assertEquals(resolved.data, event.payload);
});

Deno.test("a durable Event is resolved once per scope and each caller gets its own copy", async () => {
  const assets = createMemoryAssetRepository();
  await assets.publish({
    id: "once-text",
    namespace: "tenant-a",
    mediaType: "text/plain",
    body: new TextEncoder().encode("resolved once"),
  });
  const baseResolver = createContentResolver({ assets });
  let resolutions = 0;
  const resolver = {
    getMany(
      refs: readonly import("../content/types.ts").ContentRef[],
      options: { namespace: string },
    ) {
      resolutions++;
      return baseResolver.getMany(refs, options);
    },
  };
  const event = {
    id: "event-once",
    durable: true,
    type: "event.content.created",
    namespace: "tenant-a",
    correlationId: "once",
    metadata: {},
    createdAt: new Date().toISOString(),
    payload: {
      body: {
        assetId: "once-text",
        kind: "text",
        role: "body",
        mediaType: "text/plain",
      },
    },
  } as unknown as import("../events/index.ts").CopilotzEvent;
  const scope = { session: undefined, tables: {} } as never;

  const first = await resolveProcessorEvent(scope, event, resolver);
  const second = await resolveProcessorEvent(scope, event, resolver);
  assertEquals(resolutions, 1, "the second resolution reuses the first");
  assertEquals(
    (second.data as { body: { value: string } }).body.value,
    "resolved once",
  );
  (first.data as { body: { value: string } }).body.value = "mutated";
  const third = await resolveProcessorEvent(scope, event, resolver);
  assertEquals(
    (third.data as { body: { value: string } }).body.value,
    "resolved once",
    "a handler cannot change what another handler sees",
  );

  // A different scope resolves for itself.
  await resolveProcessorEvent(
    { session: undefined, tables: {} } as never,
    event,
    resolver,
  );
  assertEquals(resolutions, 2);
});

Deno.test("a failed Event resolution is not remembered", async () => {
  let attempts = 0;
  const resolver = {
    getMany(): Promise<never> {
      attempts++;
      return Promise.reject(new Error("content unavailable"));
    },
  };
  const event = {
    id: "event-failing",
    durable: true,
    type: "event.content.created",
    namespace: "tenant-a",
    correlationId: "failing",
    metadata: {},
    createdAt: new Date().toISOString(),
    payload: {
      body: {
        assetId: "missing",
        kind: "text",
        role: "body",
        mediaType: "text/plain",
      },
    },
  } as unknown as import("../events/index.ts").CopilotzEvent;
  const scope = { session: undefined, tables: {} } as never;
  for (let attempt = 1; attempt <= 2; attempt++) {
    await resolveProcessorEvent(scope, event, resolver).then(
      () => {
        throw new Error("expected a failure");
      },
      (error: Error) => assertEquals(error.message, "content unavailable"),
    );
  }
  assertEquals(attempts, 2, "the retry resolves again");
});
