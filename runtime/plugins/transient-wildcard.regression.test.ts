import { assertRejects } from "@std/assert";

import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
} from "./index.ts";

Deno.test("static plugin processors reject the transient-only event wildcard", async () => {
  const wildcard = defineProcessor({
    id: "test.static-wildcard",
    on: [{ eventType: "*" }],
    handle() {},
  });
  const plugin = definePlugin({
    manifest: {
      id: "test.static-wildcard-plugin",
      version: "1.0.0",
      provides: { processors: [wildcard.id] },
    },
    resources: { processors: [wildcard] },
  });

  await assertRejects(
    () => createPluginRegistry({ plugins: [plugin] }),
    TypeError,
  );
});
