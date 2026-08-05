import { runRuntimeSmoke } from "./runtime-smoke.ts";

const result = await runRuntimeSmoke();
(globalThis as typeof globalThis & { __copilotzRuntimeSmoke?: unknown })
  .__copilotzRuntimeSmoke = result;
console.log(`copilotz-runtime-smoke:${JSON.stringify(result)}`);
