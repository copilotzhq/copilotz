import { createCopilotzWorker } from "../application/worker.ts";
import { identityFlowDefinitions } from "./identity-flow-definitions.ts";
const worker = await createCopilotzWorker({
  ...identityFlowDefinitions,
  namespace: "space",
  id: "identity-worker",
  capacity: 4,
  transport: {
    type: "websocket",
    config: { url: Deno.args[0], allowInsecureLoopback: true },
  },
  activate: () => ({
    workerId: "identity-worker",
    attemptId: "attempt",
    epoch: 1,
  }),
  register: () => ({
    credential: { kind: "registration", capability: "registration" },
    expiresAtMs: Date.now() + 60000,
  }),
  reconnectDelay: false,
});
await worker.ready;
console.log("WORKER_READY");
for await (const _chunk of Deno.stdin.readable) break;
await worker.stop();
