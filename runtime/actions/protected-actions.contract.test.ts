import { assert, assertRejects } from "@std/assert";
import { createCopilotzWorker } from "../application/worker.ts";
import { buildWorkerRole } from "../../build/role-bundle.ts";
import { createCopilotz } from "../../create-copilotz.ts";
import type { ProtectedActionOwnerContext } from "./index.ts";

Deno.test("workers reject protected owner registrations before transport activation", async () => {
  await assertRejects(
    () =>
      createCopilotzWorker({
        transport: {
          type: "in-process",
          config: { topic: "protected-contract" },
        },
        // @ts-expect-error Owner callbacks cannot be configured on a Worker.
        protectedActions: {},
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
        !/\/actions\/protected-actions\.ts$/.test(module.source),
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
function publicContract(context: ProtectedActionOwnerContext) {
  void createCopilotz({
    protectedActions: {
      fixture: {
        authorize(_input, owner) {
          void owner.readAcceptedOutput();
        },
        prepareInput(input) {
          return input;
        },
      },
    },
  });
  // @ts-expect-error No caller-selected source reference.
  void context.resolveSource("event-id");
  // @ts-expect-error No caller-selected output reference.
  void context.readAcceptedOutput("other-run");
  // @ts-expect-error No session authority.
  void context.session;
  // @ts-expect-error No transaction authority.
  void context.transaction;
}
void publicContract;
