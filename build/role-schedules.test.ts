import { assert, assertEquals, assertRejects } from "@std/assert";
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

Deno.test("worker role builds the real schedules plugin with its pure delegation digest", async () => {
  const root = await Deno.makeTempDir({ prefix: "role-schedules-" });
  try {
    const entry = root + "/entry.ts";
    const output = root + "/worker.js";
    await Deno.writeTextFile(
      entry,
      `
      export { schedulesPlugin, scheduledJobDelegationDigest, getNextScheduledRunAt }
        from "@copilotz/copilotz/schedules";
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
    const cron = graph.packages.find((pkg) => pkg.id === "croner@9.0.0");
    assert(cron);
    assert(cron.files.some((file) => file.path === "dist/croner.js"));
    assert(
      graph.modules.some((module) =>
        module.source.endsWith("/dependencies/croner.ts")
      ),
    );
    const artifact = await import("file://" + output);
    assertEquals(artifact.schedulesPlugin.id, "@copilotz/schedules");
    assertEquals(
      typeof artifact.schedulesPlugin.actions.runScheduledJobNow.execute,
      "function",
    );
    assertEquals(
      artifact.getNextScheduledRunAt(
        { type: "cron", expression: "0 * * * *", timezone: "UTC" },
        new Date("2026-10-19T02:15:00Z"),
      ).toISOString(),
      "2026-10-19T03:00:00.000Z",
    );
    const digest = await artifact.scheduledJobDelegationDigest({
      databaseSchema: "public",
      namespace: "scope",
      record: {
        id: "scheduled",
        status: "active",
        schedule: { type: "cron", expression: "0 * * * *", timezone: "UTC" },
        payload: { type: "example" },
        metadata: {},
      },
    });
    assert(/^sha256:[0-9a-f]{64}$/.test(digest));
    const guarded = root + "/guarded.mjs";
    await Deno.writeTextFile(
      guarded,
      `
      globalThis.setTimeout = globalThis.setInterval = () => {
        throw new Error("Schedules artifact started a timer");
      };
      globalThis.fetch = () => { throw new Error("Schedules artifact performed network I/O"); };
      const artifact = await import(${JSON.stringify("file://" + output)});
      const next = artifact.getNextScheduledRunAt(
        { type: "cron", expression: "0 * * * *", timezone: "UTC" },
        new Date("2026-10-19T02:15:00Z"),
      );
      if (next.toISOString() !== "2026-10-19T03:00:00.000Z") throw new Error("Wrong next run");
      if (artifact.schedulesPlugin.id !== "@copilotz/schedules") throw new Error("Wrong plugin");
    `,
    );
    const loaded = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-config",
        "--deny-read",
        "--deny-write",
        "--deny-net",
        "--deny-env",
        "--deny-run",
        "--deny-ffi",
        guarded,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(loaded.success, new TextDecoder().decode(loaded.stderr));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("worker Cron admission rejects package subpaths and keeps owner barrels excluded", async () => {
  const root = await Deno.makeTempDir({ prefix: "role-schedules-refusal-" });
  try {
    for (
      const [source, message] of [
        [
          'import metadata from "npm:croner@9.0.0/package.json" with { type: "json" }; export { metadata };',
          "Unsupported worker npm entry:",
        ],
        [
          'export { defineCollection } from "@copilotz/copilotz/collections";',
          "Unsupported worker runtime module:",
        ],
        [
          'export { defineAction } from "@copilotz/copilotz/actions";',
          "Unsupported worker runtime module:",
        ],
      ]
    ) {
      const entry = root + "/entry.ts", output = root + "/worker.js";
      await Deno.writeTextFile(entry, source);
      await Deno.writeTextFile(output, "previous artifact");
      await Deno.writeTextFile(output + ".graph.json", "previous graph");
      await assertRejects(
        () => buildWorkerRole(entry, { output }),
        Error,
        message,
      );
      assertEquals(await Deno.readTextFile(output), "previous artifact");
      assertEquals(
        await Deno.readTextFile(output + ".graph.json"),
        "previous graph",
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
