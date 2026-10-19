import { assert, assertEquals } from "@std/assert";
import { buildWorkerRole } from "./role-bundle.ts";

Deno.test("worker role builds and evaluates the pure scheduled-delegation authoring helper", async () => {
  const root = await Deno.makeTempDir({ prefix: "role-schedules-" });
  try {
    const entry = root + "/entry.ts";
    const output = root + "/worker.js";
    await Deno.writeTextFile(
      entry,
      `
      export { scheduledJobDelegationDigest } from "@copilotz/copilotz/authoring";
    `,
    );
    const graph = await buildWorkerRole(entry, { output });
    assert(
      graph.modules.some((module) =>
        module.source.endsWith("/runtime/schedules/delegation.ts")
      ),
    );
    assert(
      !graph.modules.some((module) =>
        /\/runtime\/(?:engine|persistence)\//.test(module.source)
      ),
    );
    const artifact = await import("file://" + output);
    const input = {
      databaseSchema: "public",
      namespace: "scope",
      record: {
        id: "scheduled",
        status: "active",
        schedule: { type: "cron", expression: "0 * * * *", timezone: "UTC" },
        payload: { type: "example" },
        metadata: {},
      },
    };
    const digest = await artifact.scheduledJobDelegationDigest(input);
    assertEquals(await artifact.scheduledJobDelegationDigest(input), digest);
    assert(/^sha256:[0-9a-f]{64}$/.test(digest));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
