/** Actual OS process: no gateway AsyncLocalStorage can reach this worker. */
import { createCopilotzWorker } from "../application/worker.ts";
import { createCopilotzApplication } from "../application/application.ts";
import { createTestDatabase } from "./ominipg.ts";
import { authorityDefinitions } from "./worker-authority-fixture.ts";
const db = await createTestDatabase();
const definitions = authorityDefinitions(() => app.host);
const app = await createCopilotzApplication({
  database: db,
  namespace: "space",
  ...definitions,
});
// Independent host bootstrap still works outside every worker invocation.
await app.host.collections.notes.create({ id: "bootstrap" });
const worker = await createCopilotzWorker({
  namespace: "space",
  ...definitions,
  id: "authority-worker",
  capacity: 2,
  transport: {
    type: "websocket",
    config: { url: Deno.args[0], allowInsecureLoopback: true },
  },
  activate: () => ({
    workerId: "authority-worker",
    attemptId: "attempt",
    epoch: 1,
  }),
  register: () => ({
    credential: { kind: "registration", capability: "test-registration" },
    // Credential expiry is tested separately; this process serves a long matrix.
    expiresAtMs: Date.now() + 10 * 60_000,
  }),
  reconnectDelay: false,
});
await worker.ready;
console.log("WORKER_READY");
for await (const _chunk of Deno.stdin.readable) break;
await worker.stop();
await app.close();
await db.close();
