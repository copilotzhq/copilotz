import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  createStreamOutputDescriptor,
  isStreamOutputDescriptor,
} from "./observation.ts";

Deno.test("stream output descriptors are exact, serializable transport data", () => {
  const descriptor = createStreamOutputDescriptor({
    id: "stream-a",
    mediaType: "text/plain",
    kind: "text",
    role: "assistant",
    metadata: { lane: "reply" },
  }, {
    namespace: "tenant-a",
    metadata: { source: "processor" },
  });
  assertEquals(descriptor, {
    type: "stream.output",
    namespace: "tenant-a",
    streamId: "stream-a",
    mediaType: "text/plain",
    kind: "text",
    role: "assistant",
    metadata: { lane: "reply", source: "processor" },
  });
  assert(isStreamOutputDescriptor(descriptor));
  assertEquals(
    isStreamOutputDescriptor({
      ...descriptor,
      threadId: "forbidden",
    }),
    false,
  );
  assertEquals(
    isStreamOutputDescriptor({
      ...descriptor,
      kind: "unknown",
    }),
    false,
  );
  assertEquals(
    isStreamOutputDescriptor({
      ...descriptor,
      disposition: "download",
    }),
    false,
  );
  assertEquals(
    isStreamOutputDescriptor({
      ...descriptor,
      metadata: { date: new Date() },
    }),
    false,
  );
  let read = false;
  const accessor = { ...descriptor };
  Object.defineProperty(accessor, "namespace", {
    enumerable: true,
    get() {
      read = true;
      return "tenant-a";
    },
  });
  assertEquals(isStreamOutputDescriptor(accessor), false);
  assertEquals(read, false);
  const symbol = { ...descriptor };
  Object.defineProperty(symbol, Symbol("forbidden"), {
    enumerable: true,
    value: true,
  });
  assertEquals(isStreamOutputDescriptor(symbol), false);
  assertThrows(
    () =>
      createStreamOutputDescriptor({
        id: "stream-b",
        mediaType: "text/plain",
        kind: "text",
        role: "assistant",
        metadata: { date: new Date() },
      }, { namespace: "tenant-a" }),
    TypeError,
    "plain",
  );
});

Deno.test("stream output metadata rejects accessors, sparse keys, and cycles without observation", () => {
  let read = false;
  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      read = true;
      return "forbidden";
    },
  });
  const descriptor = (metadata: Record<string, unknown>) => () =>
    createStreamOutputDescriptor({
      id: "stream-a",
      mediaType: "text/plain",
      kind: "text",
      role: "assistant",
      metadata,
    }, { namespace: "tenant-a" });
  assertThrows(descriptor(accessor), TypeError, "enumerable data");
  assertEquals(read, false);
  const sparse: unknown[] = [];
  sparse[1] = "gap";
  assertThrows(descriptor({ sparse }), TypeError, "dense");
  const extra = ["value"] as unknown[] & { extra?: string };
  extra.extra = "forbidden";
  assertThrows(descriptor({ extra }), TypeError, "extra keys");
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assertThrows(descriptor(cycle), TypeError, "cycles");
});
