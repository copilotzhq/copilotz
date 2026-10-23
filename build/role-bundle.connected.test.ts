import { assert, assertEquals } from "@std/assert";
import { buildWorkerRole } from "./role-bundle.ts";
import { plugin } from "../contracts/package/fixtures/owner-whole-plugin.ts";
import { createCopilotzGateway } from "../runtime/application/gateway.ts";
import { createOwnerTestDatabase } from "../runtime/testing/owner-database.ts";
import { listen } from "../runtime/adapters/deno/listen.ts";

Deno.test("emitted whole-plugin worker executes Actions, Processors and bounded reads over a real WebSocket without owner modules", async () => {
  const root = await Deno.makeTempDir({ prefix: "copilotz-emitted-worker-" });
  const database = await createOwnerTestDatabase();
  let gateway: Awaited<ReturnType<typeof createCopilotzGateway>> | undefined;
  let worker: { ready: Promise<void>; close(): Promise<void> } | undefined;
  let listener: ReturnType<typeof listen> | undefined;
  try {
    const output = root + "/worker.js";
    const graph = await buildWorkerRole(
      new URL(
        "../contracts/package/fixtures/owner-whole-plugin.ts",
        import.meta.url,
      ).pathname,
      { output },
    );
    assert(
      !graph.modules.some((m) =>
        /\/runtime\/(engine|persistence)\//.test(m.source)
      ),
    );
    assert(
      !graph.modules.some((m) =>
        /\/(owner-capabilities|commands|host|session)\.ts$/.test(m.source) &&
        m.source.includes("/runtime/")
      ),
    );
    const artifact = await import("file://" + output);
    gateway = await createCopilotzGateway({
      namespace: "artifact",
      database,
      plugins: [plugin],
      transports: [{ type: "websocket", config: { path: "/worker" } }],
      target: { workerId: "artifact" },
      admit(context) {
        return {
          definition: {
            workerId: "artifact",
            providerId: "test",
            workloads: [...context.workloads],
            capacity: context.capacity,
            providerConfig: {},
            labels: {},
          },
          sessionGeneration: 1,
          authenticatedWith: context.credential.kind,
          resume: {
            credential: { kind: "resume", capability: "test" },
            expiresAtMs: Date.now() + 60000,
          },
        };
      },
    });
    listener = listen(gateway, { hostname: "127.0.0.1", port: 0 });
    const url = new URL("/worker", listener.url);
    url.protocol = "ws:";
    worker = await artifact.connect({
      role: "worker",
      namespace: "artifact",
      id: "artifact",
      transport: {
        type: "websocket",
        config: { url, allowInsecureLoopback: true },
      },
      activate: () => ({ workerId: "artifact", attemptId: "one", epoch: 1 }),
      register: () => ({
        credential: { kind: "registration", capability: "test" },
        expiresAtMs: Date.now() + 60000,
      }),
      reconnectDelay: false,
    });
    await worker!.ready;
    assertEquals(
      await gateway.actions.write("artifact", { idempotencyKey: "artifact" }),
      "whole:artifact",
    );
    // The Action's result covers the note write. The reply belongs to its
    // inherited Processor and requires scope settlement before inspecting SQL.
    const operation = (await gateway.application.listOperations()).find((
      item,
    ) => item.correlationId === "host:artifact");
    assert(operation);
    const attachment = await gateway.application.attach({
      operationId: operation.operationId,
    });
    try {
      let outcome: unknown;
      for await (const output of attachment.outputs) {
        if (output.type === "operation.settled") {
          outcome = (output as { outcome?: string }).outcome;
        }
      }
      await attachment.done;
      assertEquals(outcome, "completed");
    } finally {
      await attachment.detach();
    }
    const replies = await database.query(
      "SELECT id FROM public.nodes WHERE type='public_reply'",
    );
    assertEquals(replies.rows.map((row) => row.id), ["reply:artifact"]);
  } finally {
    await worker?.close();
    await gateway?.shutdown();
    await listener?.shutdown();
    await database.close();
    await Deno.remove(root, { recursive: true });
  }
});
