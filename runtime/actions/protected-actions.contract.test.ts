import { assert, assertRejects } from "@std/assert";
import { createCopilotzWorker } from "../application/worker.ts";
import { buildWorkerRole } from "../../build/role-bundle.ts";
import { createCopilotz } from "../../create-copilotz.ts";
import type { OwnerPolicy } from "../authorization/evaluator.ts";

Deno.test("workers reject protected owner registrations before transport activation", async () => {
  await assertRejects(
    () =>
      createCopilotzWorker({
        transport: {
          type: "in-process",
          config: { topic: "protected-contract" },
        },
        // @ts-expect-error Owner callbacks cannot be configured on a Worker.
        authorization: {},
      }),
    TypeError,
    "Workers accept",
  );
});
Deno.test("worker artifact excludes protected owner hooks admission evidence and SQL runtime", async () => {
  const root = await Deno.makeTempDir({ prefix: "protected-action-wire-" });
  try {
    const entry = `${root}/worker.ts`;
    await Deno.writeTextFile(
      entry,
      'export { createCopilotz } from "@copilotz/copilotz/worker";',
    );
    const graph = await buildWorkerRole(entry, { output: `${root}/worker.js` });
    for (const module of graph.modules) {
      assert(
        !/\/actions\/authorized-capture\.ts$/.test(module.source),
        module.source,
      );
      assert(
        !/\/application\/ingress\/authority\.ts$/.test(module.source),
        module.source,
      );
      assert(
        !/\/engine\/owner-query-context\.ts$/.test(module.source),
        module.source,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
function publicContract(context: Parameters<OwnerPolicy["evaluate"]>[0]) {
  void createCopilotz({
    authorization: {
      policies: {
        fixture: {
          revision: "1",
          sources: [],
          evaluate() {
            return {};
          },
        },
      },
      collections: {},
      actions: {},
    },
  });
  // @ts-expect-error Policies have no raw session authority.
  void context.session;
  // @ts-expect-error Policies have no transaction authority.
  void context.transaction;
  // @ts-expect-error Policies cannot bypass declared sources with SQL.
  void context.query;
}
void publicContract;
