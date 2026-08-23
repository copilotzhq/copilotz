import { assertEquals, assertThrows } from "@std/assert";

import {
  createPluginRegistry,
  createTransientProcessorSet,
  definePlugin,
  defineProcessor,
} from "./index.ts";

Deno.test("static wildcard registration requires a semantic structural guard", () => {
  const naked = defineProcessor({
    id: "test.naked-static-wildcard",
    on: [{ eventType: "*" }],
    handle() {},
  });
  const plugin = definePlugin({
    id: "test.naked-static-wildcard-plugin",
    version: "1.0.0",
    processors: { naked },
  });

  assertThrows(
    () => createPluginRegistry({ plugins: [plugin] }),
    TypeError,
    "cannot register static eventType '*' without a non-empty plain subject, metadata, or data matcher",
  );

  const transients = createTransientProcessorSet([naked]);
  const event = {
    durable: false,
    type: "stream.output",
    namespace: "tenant-a",
    payload: new Uint8Array([1, 2]),
    routing: {},
    visibility: { kind: "public" as const },
    metadata: {},
    correlationId: "correlation-a",
    streamId: "stream-a",
    sequence: 1,
    createdAt: new Date().toISOString(),
  } as const;
  assertEquals(transients.match(event), [naked]);
});
