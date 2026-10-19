/** Receipt recovery uses a fresh, parentless call; it never replays a write. */
import type { Worker } from "../../dependencies/oxian-worker.ts";
import {
  type CapabilityCall,
  encodeCapability,
  OWNER_CAPABILITY_WORKLOAD,
  readCapability,
} from "./owner-capability-wire.ts";
export async function recoverOwnerReceipt(
  worker: Pick<Worker, "callHost">,
  receipt: NonNullable<CapabilityCall["receipt"]>,
): Promise<boolean> {
  const handle = await worker.callHost({
    workload: OWNER_CAPABILITY_WORKLOAD,
    body: encodeCapability({ kind: "receipt", value: receipt }),
    deadlineAtMs: Date.now() + 10_000,
  });
  const response = await readCapability(handle.output) as {
    value?: unknown;
    error?: unknown;
  };
  await handle.completed;
  return response.error === undefined && response.value === true;
}
