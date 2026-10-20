import { assert } from "@std/assert";
import { buildWorkerRole } from "../../build/role-bundle.ts";

Deno.test("worker artifact excludes host command SQL handlers and registration runtime", async () => {
  const root = await Deno.makeTempDir({ prefix: "host-command-wire-" });
  try {
    const entry = `${root}/worker.ts`;
    await Deno.writeTextFile(
      entry,
      'export { createCopilotz } from "@copilotz/copilotz/worker";',
    );
    const graph = await buildWorkerRole(entry, { output: `${root}/worker.js` });
    for (const module of graph.modules) {
      assert(
        !/\/application\/host-command[^/]*\.ts$/.test(module.source),
        module.source,
      );
      assert(!/\/engine\/commands\.ts$/.test(module.source), module.source);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
