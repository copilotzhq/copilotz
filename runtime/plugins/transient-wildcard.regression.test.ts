import { assertThrows } from "@std/assert";

import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
} from "./index.ts";

Deno.test("static plugin processors reject the transient-only event wildcard", () => {
  const wildcard = defineProcessor({
    id: "test.static-wildcard",
    on: [{ eventType: "*" }],
    handle() {},
  });
  const plugin = definePlugin({
    id: "test.static-wildcard-plugin",
    version: "1.0.0",
    processors: [wildcard],
  });

  assertThrows(
    () => createPluginRegistry({ plugins: [plugin] }),
    TypeError,
  );
});
