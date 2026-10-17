/** Real built-artifact acceptance with an explicitly selected compatible transport. */
import { assert, assertEquals } from "@std/assert";
import { buildWorkerRole } from "./role-bundle.ts";
import { ownerApplicationFixture } from "../contracts/package/fixtures/owner-application.ts";
import type { connect } from "../contracts/package/fixtures/owner-whole-plugin.ts";

const source = Deno.env.get("COPILOTZ_OXIAN_SOURCE_ROOT");
async function eventually(check: () => Promise<boolean>) {
  const until = Date.now() + 15_000;
  while (!await check()) {
    if (Date.now() > until) {
      throw new Error("worker artifact delivery timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
for (const mode of ["in-process", "websocket"] as const) {
  Deno.test({
    name:
      `built worker artifact ${mode}: root whole plugin calls owner Collections and child Actions`,
    ignore: !source,
    async fn() {
      const directory = await Deno.makeTempDir({ prefix: "worker-connected-" });
      let remote: Awaited<ReturnType<typeof connect>> | undefined;
      let fixture:
        | Awaited<ReturnType<typeof ownerApplicationFixture>>
        | undefined;
      try {
        const output = directory + "/worker.js";
        const graph = await buildWorkerRole(
          new URL(
            "../contracts/package/fixtures/owner-whole-plugin.ts",
            import.meta.url,
          ).pathname,
          { output },
        );
        assert(
          !graph.modules.some((m) =>
            /\/(persistence|engine|storage)\//.test(m.source)
          ),
        );
        assert(
          !graph.modules.some((m) =>
            m.source.endsWith("owner-storage-composition.ts")
          ),
        );
        assert(
          !graph.packages.some((p) =>
            /pglite|ominipg|postgres|sqlite/.test(p.id)
          ),
        );
        const artifact: { connect: typeof connect } = await import(
          "file://" + output
        );
        fixture = await ownerApplicationFixture(source!, mode);
        remote = await artifact.connect(fixture.ownerOptions);
        await remote.ready;
        fixture.setExecutionWorker("remote");
        assertEquals(
          await remote.actions.write("artifact", {
            idempotencyKey: "artifact",
          }),
          "whole:artifact",
        );
        await eventually(async () =>
          (await fixture!.query(
            "SELECT id FROM nodes WHERE id='reply:artifact'",
          )).rows.length === 1
        );
        const assignments = await fixture.query(
          "SELECT binding FROM owner_assignments WHERE binding->>'workerId'='remote'",
        );
        assert(
          assignments.rows.length >= 3,
          "built worker executed Action, Processor and nested Action",
        );
        assertEquals(
          await remote.actions.write("artifact", {
            idempotencyKey: "artifact",
          }),
          "whole:artifact",
        );
        assertEquals(
          (await fixture.query(
            "SELECT id FROM nodes WHERE id IN ('note:artifact','reply:artifact')",
          )).rows.length,
          2,
        );
        await eventually(async () =>
          (await fixture!.query(
            "SELECT status FROM event_deliveries WHERE status NOT IN ('succeeded','dead_letter','cancelled')",
          )).rows.length === 0
        );
        assertEquals(fixture.errors, []);
      } finally {
        await remote?.close();
        await fixture?.close();
        await Deno.remove(directory, { recursive: true });
      }
    },
  });
}
