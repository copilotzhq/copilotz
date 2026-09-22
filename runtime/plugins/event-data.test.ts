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
